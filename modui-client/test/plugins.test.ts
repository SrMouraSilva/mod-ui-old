// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { Plugin } from '../src';
import { gainInfo, gainUri, makeClient, pluginSummaries, setupFakes } from './helpers';

setupFakes();

describe('client.device.plugins.list()', () => {
  it('returns a Plugin for every summary', async () => {
    const { client, calls } = makeClient({ 'GET /effect/list': pluginSummaries });
    const plugins = await client.device.plugins.list();

    expect(plugins).toHaveLength(2);
    expect(plugins[0]).toBeInstanceOf(Plugin);
    expect(plugins[0]).toMatchObject({ uri: gainUri, name: 'Gain', label: 'Gain', brand: 'MOD', category: ['Utility'] });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /effect/list']);
  });

  it('info() reads /effect/get with the URI and caches the answer', async () => {
    const { client, calls } = makeClient({ 'GET /effect/list': pluginSummaries, 'GET /effect/get': gainInfo });
    const [gain] = await client.device.plugins.list();

    const first = await gain.info();
    const second = await gain.info();

    expect(first.ports.audio?.input?.[0].symbol).toBe('in');
    expect(second).toBe(first);
    const gets = calls.filter((c) => new URL(c.url).pathname === '/effect/get');
    expect(gets).toHaveLength(1);
    expect(new URL(gets[0].url).searchParams.get('uri')).toBe(gainUri);
  });
});
