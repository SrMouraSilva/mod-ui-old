// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ModUiHttpError, PedalboardReference } from '../src';
import { infoBody, makeClient, summaries, setupFakes } from './helpers';

setupFakes();

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
