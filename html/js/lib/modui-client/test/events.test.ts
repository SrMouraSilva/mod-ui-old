// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ModUiTimeoutError } from '../src';
import { FakeWebSocket, connected, flush, makeClient, setupFakes } from './helpers';

setupFakes();

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
