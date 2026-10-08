// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Test doubles and fixtures shared by the unit tests. */

import { afterEach, beforeEach, vi } from 'vitest';
import { ModUiClient, type PedalboardSummary, type WebSocketLike } from '../src';

// ---------------------------------------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------------------------------------

type Listener = (event: any) => void;

/** In-memory WebSocket: records sent frames and lets tests push server messages. */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string = 'ws://fake/websocket') {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.dispatch('close', {});
  }
  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Server side: open the connection. */
  open(): void {
    this.readyState = 1;
    this.dispatch('open', {});
  }
  /** Server side: push a text frame. */
  emit(message: string): void {
    this.dispatch('message', { data: message });
  }
  /** Server side: the initial state replay (shortened). */
  replay(): void {
    this.open();
    this.emit('stats 3.0 0');
    this.emit('loading_start 0 0');
    this.emit('loading_end 0');
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
}

export interface Call {
  method: string;
  url: string;
  body?: string;
}

/** Routes "METHOD /path" to canned answers and records every call. */
export function fakeFetch(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url, body: init?.body as string | undefined };
    calls.push(call);
    const path = new URL(url).pathname;
    const route = routes[`${call.method} ${path}`];
    if (route === undefined) {
      return new Response('<html>404: Not Found</html>', { status: 404 });
    }
    const value = await (typeof route === 'function' ? (route as (c: Call) => unknown)(call) : route);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200 });
  });
  return { fetchFn, calls };
}

export const summaries: PedalboardSummary[] = [
  {
    broken: false,
    factory: false,
    hasTrialPlugins: false,
    uri: 'file:///root/.pedalboards/default.pedalboard/default.ttl',
    bundle: '/root/.pedalboards/default.pedalboard',
    title: 'Default',
    version: 0,
  },
  {
    broken: false,
    factory: false,
    hasTrialPlugins: false,
    uri: 'file:///root/.pedalboards/My_Board.pedalboard/My_Board.ttl',
    bundle: '/root/.pedalboards/My Board&Co.pedalboard',
    title: 'My Board',
    version: 3,
  },
];

export const infoBody = {
  title: 'My Board',
  width: 1200,
  height: 600,
  factory: false,
  midi_separated_mode: true,
  midi_loopback: false,
  plugins: [],
  connections: [],
  hardware: {
    audio_ins: 2,
    audio_outs: 2,
    cv_ins: 0,
    cv_outs: 0,
    midi_ins: [],
    midi_outs: [],
    serial_midi_in: false,
    serial_midi_out: false,
    midi_merger_out: false,
    midi_broadcaster_in: false,
  },
  timeInfo: { available: 0, bpb: 4, bpm: 120, rolling: false },
  version: 3,
};

export function makeClient(routes: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof ModUiClient>[0]> = {}) {
  const { fetchFn, calls } = fakeFetch(routes);
  const client = new ModUiClient({
    baseUrl: 'http://modduo.local/',
    fetch: fetchFn as unknown as typeof fetch,
    WebSocket: FakeWebSocket,
    ...extra,
  });
  return { client, calls, fetchFn };
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Opens the client's own socket and plays the initial replay. */
export async function connected(client: ModUiClient): Promise<FakeWebSocket> {
  const connecting = client.connect();
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket.replay();
  await connecting;
  return socket;
}

/** Registers the per-test reset of fakes and timers. Call once at the top of each test file. */
export function setupFakes(): void {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
