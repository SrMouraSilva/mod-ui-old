// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Entry point: {@link ModUiClient} and its options.
 * @module
 */

import { Device } from './device';
import { ModUiError } from './errors';
import { EventChannel } from './events';
import { HttpTransport } from './http';
import { PedalboardsApi } from './pedalboards';
import { PluginsApi } from './plugins';
import type { FetchLike, WebSocketFactory, WebSocketLike } from './runtime';

/** Options of {@link ModUiClient}. All are optional in a mod-ui page. */
export interface ModUiClientOptions {
  /**
   * Origin of the mod-ui server, e.g. `"http://modduo.local"`. Defaults to `location.origin`.
   * The WebSocket URL is derived from it (`http` → `ws`, `https` → `wss`).
   */
  baseUrl?: string;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** WebSocket class used to open the client's own socket. Defaults to the global `WebSocket`. */
  WebSocket?: WebSocketFactory;
  /**
   * Reuse an already open socket instead of opening a new one (in the classic UI: `window.ws`).
   * The client then never answers `ping`/`data_ready` and never closes it.
   */
  webSocket?: WebSocketLike;
  /** Default timeout for pedalboard loads, in ms. Default: 60000. */
  loadTimeoutMs?: number;
  /** Timeout for opening the WebSocket and receiving the initial state replay, in ms. Default: 30000. */
  connectTimeoutMs?: number;
  /**
   * Maximum time to wait for the WebSocket frame that confirms a plugin or connection change
   * (`add`, `remove`, `connect`, `disconnect`), in ms. Default: 10000.
   */
  graphTimeoutMs?: number;
}

/**
 * Entry point of the mod-ui client.
 *
 * @example
 * // In a mod-ui page (same origin)
 * const client = new ModUiClient();
 *
 * // From another origin / Node (Node 22+ has global fetch and WebSocket)
 * const remote = new ModUiClient({ baseUrl: 'http://modduo.local' });
 *
 * // Inside the classic UI, sharing its socket instead of opening a second one
 * const shared = new ModUiClient({ webSocket: window.ws });
 */
export class ModUiClient {
  /** Server origin used for every request, without trailing slash. */
  readonly baseUrl: string;
  /** The running pedalboard. */
  readonly device: Device;
  /** The pedalboard library. */
  readonly pedalboards: PedalboardsApi;
  /** Main WebSocket: raw subscriptions and waits. */
  readonly events: EventChannel;

  constructor(options: ModUiClientOptions = {}) {
    const origin = options.baseUrl ?? (typeof location !== 'undefined' ? location.origin : undefined);
    if (!origin) {
      throw new ModUiError('options.baseUrl is required outside a browser page');
    }
    this.baseUrl = origin.replace(/\/+$/, '');

    const fetchImpl = options.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
    if (!fetchImpl) {
      throw new ModUiError('No fetch implementation available; pass options.fetch');
    }
    const factory =
      options.WebSocket ?? (typeof WebSocket !== 'undefined' ? (WebSocket as unknown as WebSocketFactory) : undefined);

    const http = new HttpTransport(this.baseUrl, fetchImpl);
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/websocket';
    const connectTimeoutMs = options.connectTimeoutMs ?? 30000;
    this.events = new EventChannel(wsUrl, factory, options.webSocket, connectTimeoutMs);
    this.pedalboards = new PedalboardsApi(http);
    this.device = new Device(http, this.events, this.pedalboards, new PluginsApi(http), options.loadTimeoutMs ?? 60000, {
      confirmTimeoutMs: options.graphTimeoutMs ?? 10000,
      // Used when the socket is shared: its state replay has passed, so a short-lived own socket reads a new one.
      openSnapshotChannel: () => (factory ? new EventChannel(wsUrl, factory, undefined, connectTimeoutMs) : null),
    });
  }

  /** Connects the WebSocket ahead of time (feature methods do it on demand). See {@link EventChannel.connect}. */
  connect(): Promise<void> {
    return this.events.connect();
  }

  /** Releases the WebSocket (closes it if the client opened it). */
  close(): void {
    this.events.close();
  }
}
