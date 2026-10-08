// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ModUiError, ModUiTimeoutError } from '../src';
import { FakeWebSocket, connected, flush, infoBody, makeClient, summaries, setupFakes } from './helpers';

setupFakes();

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

  it('rejects invalid targets', async () => {
    const { client } = makeClient(routes);
    await expect(client.device.load('' as string)).rejects.toBeInstanceOf(ModUiError);
    await expect(client.device.load({} as { bundlepath: string })).rejects.toBeInstanceOf(ModUiError);
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
