// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ModUiClient,
  ModUiError,
  ModUiHttpError,
  ModUiTimeoutError,
  PedalboardReference,
  type PedalboardSummary,
  type WebSocketLike,
} from './modui-client';

// ---------------------------------------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------------------------------------

type Listener = (event: any) => void;

/** In-memory WebSocket: records sent frames and lets tests push server messages. */
class FakeWebSocket implements WebSocketLike {
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

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** Routes "METHOD /path" to canned answers and records every call. */
function fakeFetch(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url, body: init?.body as string | undefined };
    calls.push(call);
    const path = new URL(url).pathname;
    const route = routes[`${call.method} ${path}`];
    if (route === undefined) {
      return new Response('<html>404: Not Found</html>', { status: 404 });
    }
    const value = typeof route === 'function' ? (route as (c: Call) => unknown)(call) : route;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200 });
  });
  return { fetchFn, calls };
}

const summaries: PedalboardSummary[] = [
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

const infoBody = {
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

function makeClient(routes: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof ModUiClient>[0]> = {}) {
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
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Opens the client's own socket and plays the initial replay. */
async function connected(client: ModUiClient): Promise<FakeWebSocket> {
  const connecting = client.connect();
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket.replay();
  await connecting;
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

describe('ModUiClient', () => {
  it('derives the WebSocket URL from baseUrl', async () => {
    const { client } = makeClient({});
    expect(client.baseUrl).toBe('http://modduo.local');
    await connected(client);
    expect(FakeWebSocket.instances[0].url).toBe('ws://modduo.local/websocket');
  });

  it('requires a baseUrl outside a browser', () => {
    expect(() => new ModUiClient({ fetch: vi.fn() as unknown as typeof fetch })).toThrow(ModUiError);
  });
});

describe('client.pedalboards.list()', () => {
  it('returns references built from GET /pedalboard/list', async () => {
    const { client, calls } = makeClient({ 'GET /pedalboard/list': summaries });
    const list = await client.pedalboards.list();

    expect(calls).toEqual([{ method: 'GET', url: 'http://modduo.local/pedalboard/list', body: undefined }]);
    expect(list).toHaveLength(2);
    expect(list[1]).toBeInstanceOf(PedalboardReference);
    expect(list[1].bundlepath).toBe('/root/.pedalboards/My Board&Co.pedalboard');
    expect(list[1].title).toBe('My Board');
    expect(list[1].version).toBe(3);
    expect(list[0].isDefault).toBe(true);
    expect(list[1].isDefault).toBe(false);
  });

  it('turns HTTP errors into ModUiHttpError', async () => {
    const { client } = makeClient({ 'GET /pedalboard/list': new Response('boom', { status: 500 }) });
    const error = await client.pedalboards.list().catch((e) => e);
    expect(error).toBeInstanceOf(ModUiHttpError);
    expect(error.status).toBe(500);
    expect(error.body).toBe('boom');
  });
});

describe('PedalboardReference.info()', () => {
  it('URL-encodes the bundle path and adds it to the result', async () => {
    const { client, calls } = makeClient({
      'GET /pedalboard/list': summaries,
      'GET /pedalboard/info/': infoBody,
    });
    const [, board] = await client.pedalboards.list();
    const info = await board.info();

    expect(calls[1].url).toBe(
      'http://modduo.local/pedalboard/info/?bundlepath=%2Froot%2F.pedalboards%2FMy+Board%26Co.pedalboard',
    );
    expect(info.bundlepath).toBe(board.bundlepath);
    expect(info.title).toBe('My Board');
    expect(info.width).toBe(1200);
  });
});

describe('client.device.load()', () => {
  const routes = {
    'GET /pedalboard/list': summaries,
    'GET /pedalboard/info/': infoBody,
    'GET /reset': true,
    'POST /pedalboard/load_bundle/': { ok: true, name: 'My Board' },
  };

  it('resets, loads the bundle and resolves only after loading_end', async () => {
    const { client, calls } = makeClient(routes);
    const socket = await connected(client);

    let settled = false;
    const loading = client.device.load('/root/.pedalboards/My Board&Co.pedalboard').then((r) => {
      settled = true;
      return r;
    });
    await flush();

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /reset',
      'POST /pedalboard/load_bundle/',
    ]);
    expect(new URLSearchParams(calls[1].body)).toEqual(
      new URLSearchParams({ bundlepath: '/root/.pedalboards/My Board&Co.pedalboard', isDefault: '0' }),
    );
    expect(settled).toBe(false);

    socket.emit('loading_start 0 0');
    socket.emit('add /graph/Gain urn:gain 10.0 20.0 0 0.1.0.0 1');
    await flush();
    expect(settled).toBe(false);

    socket.emit('loading_end 2');
    await expect(loading).resolves.toEqual({
      bundlepath: '/root/.pedalboards/My Board&Co.pedalboard',
      name: 'My Board',
      snapshotId: 2,
    });
  });

  it('does not mistake the initial replay for the load (connects lazily)', async () => {
    const { client, calls } = makeClient(routes);
    let settled = false;
    const loading = client.device.load('/b.pedalboard').then(() => (settled = true));
    await flush(); // load() runs through the internal queue, the socket is opened asynchronously

    const socket = FakeWebSocket.instances[0];
    socket.replay(); // ends with "loading_end 0" before any HTTP call
    await flush();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/reset', '/pedalboard/load_bundle/']);
    expect(settled).toBe(false);

    socket.emit('loading_end 0');
    await loading;
    expect(settled).toBe(true);
  });

  it('works when loading_end arrives before the HTTP response', async () => {
    let socket!: FakeWebSocket;
    const { client } = makeClient({
      ...routes,
      'POST /pedalboard/load_bundle/': () => {
        socket.emit('loading_start 0 0');
        socket.emit('loading_end 1');
        return { ok: true, name: 'Early' };
      },
    });
    socket = await connected(client);
    await expect(client.device.load('/b.pedalboard')).resolves.toMatchObject({ name: 'Early', snapshotId: 1 });
  });

  it('accepts a PedalboardReference and a PedalboardInfo', async () => {
    const { client, calls } = makeClient(routes);
    const socket = await connected(client);
    const [, board] = await client.pedalboards.list();

    const fromRef = client.device.load(board);
    await flush();
    socket.emit('loading_end 0');
    await fromRef;

    const info = await board.info();
    const fromInfo = client.device.load(info);
    await flush();
    socket.emit('loading_end 0');
    await fromInfo;

    const bodies = calls.filter((c) => c.method === 'POST').map((c) => new URLSearchParams(c.body).get('bundlepath'));
    expect(bodies).toEqual([board.bundlepath, board.bundlepath]);
  });

  it('rejects when the backend cannot load the bundle', async () => {
    const { client } = makeClient({ ...routes, 'POST /pedalboard/load_bundle/': { ok: false, name: '' } });
    await connected(client);
    await expect(client.device.load('/missing.pedalboard')).rejects.toThrow(/could not load/);
  });

  it('rejects when the reset is refused', async () => {
    const { client, calls } = makeClient({ ...routes, 'GET /reset': false });
    await connected(client);
    await expect(client.device.load('/b.pedalboard')).rejects.toThrow(/refused to reset/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects with ModUiTimeoutError when loading_end never arrives', async () => {
    const { client } = makeClient(routes, { loadTimeoutMs: 1000 });
    await connected(client);
    vi.useFakeTimers();
    const loading = client.device.load('/b.pedalboard');
    const assertion = expect(loading).rejects.toBeInstanceOf(ModUiTimeoutError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it('rejects pending loads when the socket closes', async () => {
    const { client } = makeClient(routes);
    const socket = await connected(client);
    const loading = client.device.load('/b.pedalboard');
    await flush();
    socket.close();
    await expect(loading).rejects.toThrow(/WebSocket closed/);
  });

  it('rejects invalid targets', () => {
    const { client } = makeClient(routes);
    expect(() => client.device.load('' as string)).toThrow(ModUiError);
    expect(() => client.device.load({} as { bundlepath: string })).toThrow(ModUiError);
  });

  it('serializes concurrent loads', async () => {
    const { client, calls } = makeClient(routes);
    const socket = await connected(client);

    const first = client.device.load('/a.pedalboard');
    const second = client.device.load('/b.pedalboard');
    await flush();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);

    socket.emit('loading_end 0');
    await first;
    await flush();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);

    socket.emit('loading_end 0');
    await expect(second).resolves.toMatchObject({ bundlepath: '/b.pedalboard' });
  });
});

describe('client.device.loadDefault()', () => {
  it('finds the default bundle in the list and loads it with isDefault=1', async () => {
    const { client, calls } = makeClient({
      'GET /pedalboard/list': summaries,
      'GET /reset': true,
      'POST /pedalboard/load_bundle/': { ok: true, name: '' },
    });
    const socket = await connected(client);

    const loading = client.device.loadDefault();
    await flush();
    socket.emit('loading_end 0');
    await expect(loading).resolves.toEqual({
      bundlepath: '/root/.pedalboards/default.pedalboard',
      name: '',
      snapshotId: 0,
    });

    const post = calls.find((c) => c.method === 'POST')!;
    const form = new URLSearchParams(post.body);
    expect(form.get('bundlepath')).toBe('/root/.pedalboards/default.pedalboard');
    expect(form.get('isDefault')).toBe('1');
  });

  it('throws when there is no default pedalboard', async () => {
    const { client } = makeClient({ 'GET /pedalboard/list': [summaries[1]], 'GET /reset': true });
    await expect(client.device.loadDefault()).rejects.toThrow(/default pedalboard/);
  });
});

describe('client.device.reset()', () => {
  it('calls GET /reset', async () => {
    const { client, calls } = makeClient({ 'GET /reset': true });
    await client.device.reset();
    expect(calls.map((c) => c.url)).toEqual(['http://modduo.local/reset']);
  });
});

describe('client.events', () => {
  it('answers ping and data_ready on its own socket', async () => {
    const { client } = makeClient({});
    const socket = await connected(client);
    socket.emit('ping');
    socket.emit('data_ready 7');
    expect(socket.sent).toEqual(['pong', 'data_ready 7']);
  });

  it('only listens on a shared socket', async () => {
    const shared = new FakeWebSocket();
    shared.open();
    const { client } = makeClient({}, { webSocket: shared });
    await client.connect();

    shared.emit('ping');
    shared.emit('data_ready 7');
    expect(shared.sent).toEqual([]);
    expect(FakeWebSocket.instances).toEqual([shared]); // no extra socket opened

    client.close();
    expect(shared.closed).toBe(false);
  });

  it('waits for a shared socket that is still connecting', async () => {
    const shared = new FakeWebSocket();
    const { client } = makeClient({}, { webSocket: shared });
    let done = false;
    const connecting = client.connect().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    shared.open();
    await connecting;
    expect(client.events.connected).toBe(true);
  });

  it('dispatches messages to subscribers until unsubscribed', async () => {
    const { client } = makeClient({});
    const seen: string[] = [];
    const off = client.events.on('param_set', (args) => seen.push(args));
    const all: string[] = [];
    client.events.on('*', (_args, command) => all.push(command));
    const socket = await connected(client);

    socket.emit('param_set /graph/Gain gain 1.000000');
    off();
    socket.emit('param_set /graph/Gain gain 2.000000');

    expect(seen).toEqual(['/graph/Gain gain 1.000000']);
    expect(all).toContain('param_set');
  });

  it('times out when the initial replay never arrives', async () => {
    vi.useFakeTimers();
    const { client } = makeClient({}, { connectTimeoutMs: 500 });
    const connecting = client.connect();
    const assertion = expect(connecting).rejects.toBeInstanceOf(ModUiTimeoutError);
    FakeWebSocket.instances[0].open();
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    expect(FakeWebSocket.instances[0].closed).toBe(true);
  });

  it('reconnects after the socket closed', async () => {
    const { client } = makeClient({});
    const first = await connected(client);
    first.close();
    expect(client.events.connected).toBe(false);
    await connected(client);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
