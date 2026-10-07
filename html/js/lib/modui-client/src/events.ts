// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The main WebSocket channel (`/websocket`).
 * @module
 */

import { ModUiError, ModUiTimeoutError } from './errors';
import type { WebSocketFactory, WebSocketLike } from './runtime';

/** Handler of a WebSocket message: `args` is everything after the command (empty string when none). */
export type MessageHandler = (args: string, command: string) => void;

/** Handle returned by {@link EventChannel.waitFor}. */
export interface Waiting {
  /** Resolves with the message arguments, rejects on timeout, `stop` or socket close. */
  promise: Promise<string>;
  /** Stops waiting; the promise then never settles. */
  cancel(): void;
}

interface Waiter {
  command: string;
  predicate: (args: string) => boolean;
  resolve(args: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * The main WebSocket (`/websocket`, operationId `connectMainWebSocket`).
 *
 * Available as `client.events`. Feature areas use it to await backend confirmations; applications can use
 * {@link EventChannel.on} to observe raw messages (`param_set`, `transport`, `stats`, ...).
 *
 * @example
 * const off = client.events.on('stats', (args) => {
 *   const [cpuLoad, xruns] = args.split(' ');
 *   console.log(`CPU ${cpuLoad}% / ${xruns} xruns`);
 * });
 * await client.connect();
 * // later: off();
 */
export class EventChannel {
  private socket: WebSocketLike | null = null;
  private connecting: Promise<void> | null = null;
  private synced = false;
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly waiters = new Set<Waiter>();
  private readonly owned: boolean;

  /**
   * @param url WebSocket URL (`ws://host/websocket`).
   * @param factory Class used to open the client's own socket.
   * @param shared Existing socket to reuse instead (see {@link ModUiClientOptions.webSocket}).
   * @param connectTimeoutMs Timeout for {@link EventChannel.connect}.
   */
  constructor(
    private readonly url: string,
    private readonly factory: WebSocketFactory | undefined,
    private readonly shared: WebSocketLike | undefined,
    private readonly connectTimeoutMs: number,
  ) {
    this.owned = shared === undefined;
  }

  /** True when the socket is open and the initial state replay has been received. */
  get connected(): boolean {
    return this.synced && this.socket !== null && this.socket.readyState === WS_OPEN;
  }

  /**
   * Opens the socket (once) and resolves when the client is in sync with the backend.
   *
   * - Own socket: resolves after the initial state replay (first `loading_end`).
   * - Shared socket: resolves as soon as it is open (its owner already handled the replay).
   *
   * Safe to call many times; feature methods call it for you.
   * @throws {ModUiTimeoutError} when the backend does not answer within `connectTimeoutMs`.
   */
  connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = (this.owned ? this.openOwnSocket() : this.attachSharedSocket()).then(
        () => {
          this.synced = true;
        },
        (error) => {
          this.connecting = null;
          throw error;
        },
      );
    }
    return this.connecting;
  }

  /**
   * Subscribes to a WebSocket command (`'*'` receives every message).
   * Does not open the socket by itself; call {@link EventChannel.connect} (or any feature method).
   * @returns A function that removes the subscription.
   */
  on(command: string, handler: MessageHandler): () => void {
    let set = this.handlers.get(command);
    if (!set) {
      set = new Set();
      this.handlers.set(command, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /**
   * Waits for the next message `command` whose arguments satisfy `predicate`.
   * Register the wait **before** triggering the action that produces the message: mod-ui often pushes
   * WebSocket messages before the HTTP response of the request that caused them.
   */
  waitFor(command: string, timeoutMs: number, predicate: (args: string) => boolean = () => true): Waiting {
    let waiter!: Waiter;
    const promise = new Promise<string>((resolve, reject) => {
      waiter = {
        command,
        predicate,
        resolve: (args) => {
          this.removeWaiter(waiter);
          resolve(args);
        },
        reject: (error) => {
          this.removeWaiter(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          waiter.reject(new ModUiTimeoutError(`No "${command}" message within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
    // Avoid "unhandled rejection" noise while the caller is still awaiting something else.
    promise.catch(() => undefined);
    return { promise, cancel: () => this.removeWaiter(waiter) };
  }

  /** Sends a raw text frame. The socket must be connected. */
  send(text: string): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      throw new ModUiError('WebSocket is not connected');
    }
    this.socket.send(text);
  }

  /** Detaches from the socket; closes it only if this client opened it. Pending waits are rejected. */
  close(): void {
    const socket = this.socket;
    this.detach();
    this.failWaiters(new ModUiError('Client closed'));
    if (socket && this.owned) {
      socket.close();
    }
  }

  // ------------------------------------------------------------------------------------------------------------------

  private openOwnSocket(): Promise<void> {
    if (!this.factory) {
      return Promise.reject(new ModUiError('No WebSocket implementation available; pass options.WebSocket'));
    }
    const socket = new this.factory(this.url);
    this.attach(socket);
    // The initial state replay always ends with "loading_end".
    const replay = this.waitFor('loading_end', this.connectTimeoutMs);
    return replay.promise.then(
      () => undefined,
      (error) => {
        this.detach();
        socket.close();
        throw error;
      },
    );
  }

  private attachSharedSocket(): Promise<void> {
    const socket = this.shared!;
    this.attach(socket);
    if (socket.readyState === WS_OPEN) {
      return Promise.resolve();
    }
    if (socket.readyState !== WS_CONNECTING) {
      this.detach();
      return Promise.reject(new ModUiError('The shared WebSocket is closed'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener('open', onOpen);
        this.detach();
        reject(new ModUiTimeoutError(`Shared WebSocket not open within ${this.connectTimeoutMs} ms`));
      }, this.connectTimeoutMs);
      const onOpen = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        resolve();
      };
      socket.addEventListener('open', onOpen);
    });
  }

  private attach(socket: WebSocketLike): void {
    this.socket = socket;
    socket.addEventListener('message', this.onMessage);
    socket.addEventListener('close', this.onClose);
  }

  private detach(): void {
    if (this.socket) {
      this.socket.removeEventListener('message', this.onMessage);
      this.socket.removeEventListener('close', this.onClose);
    }
    this.socket = null;
    this.connecting = null;
    this.synced = false;
  }

  private readonly onMessage = (event: { data?: unknown }): void => {
    if (typeof event.data !== 'string') {
      return;
    }
    const space = event.data.indexOf(' ');
    const command = space < 0 ? event.data : event.data.slice(0, space);
    const args = space < 0 ? '' : event.data.slice(space + 1);

    if (this.owned) {
      if (command === 'ping') {
        this.socket?.send('pong');
      } else if (command === 'data_ready') {
        // Flow control: mod-host stays silent until the counter is echoed back.
        this.socket?.send('data_ready ' + args);
      }
    }

    for (const key of [command, '*']) {
      const set = this.handlers.get(key);
      if (set) {
        for (const handler of Array.from(set)) {
          handler(args, command);
        }
      }
    }

    if (command === 'stop') {
      this.failWaiters(new ModUiError('The backend stopped (audio host restarted or UI disconnected)'));
      return;
    }
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.command === command && waiter.predicate(args)) {
        waiter.resolve(args);
      }
    }
  };

  private readonly onClose = (): void => {
    this.detach();
    this.failWaiters(new ModUiError('WebSocket closed'));
  };

  private removeWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter);
  }

  private failWaiters(error: Error): void {
    for (const waiter of Array.from(this.waiters)) {
      waiter.reject(error);
    }
  }
}
