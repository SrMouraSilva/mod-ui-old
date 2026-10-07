// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ModUiClient, ModUiError } from '../src';
import { FakeWebSocket, connected, makeClient, setupFakes } from './helpers';

setupFakes();

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
