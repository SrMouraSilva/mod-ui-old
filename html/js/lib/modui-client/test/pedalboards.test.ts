// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ModUiError, ModUiHttpError, PedalboardReference } from '../src';
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

describe('PedalboardReference.remove()', () => {
  const factorySummary = {
    ...summaries[1],
    factory: true,
    title: 'Factory Board',
    bundle: '/usr/share/mod/pedalboards/Factory.pedalboard',
  };

  it('calls GET /pedalboard/remove/ for a user pedalboard', async () => {
    const { client, calls } = makeClient({
      'GET /pedalboard/list': summaries,
      'GET /pedalboard/remove/': true,
    });
    const [, board] = await client.pedalboards.list();
    await expect(board.remove()).resolves.toBeUndefined();

    expect(calls[1].method).toBe('GET');
    expect(calls[1].url).toBe(
      'http://modduo.local/pedalboard/remove/?bundlepath=%2Froot%2F.pedalboards%2FMy+Board%26Co.pedalboard',
    );
  });

  it('refuses factory pedalboards without calling the backend', async () => {
    const { client, calls } = makeClient({ 'GET /pedalboard/list': [factorySummary] });
    const [factory] = await client.pedalboards.list();
    await expect(factory.remove()).rejects.toThrow(/factory pedalboard/);
    await expect(factory.remove()).rejects.toBeInstanceOf(ModUiError);
    expect(calls).toHaveLength(1); // only the list
  });

  it('refuses the default pedalboard without calling the backend', async () => {
    const { client, calls } = makeClient({ 'GET /pedalboard/list': summaries });
    const [defaultBoard] = await client.pedalboards.list();
    await expect(defaultBoard.remove()).rejects.toThrow(/default pedalboard/);
    expect(calls).toHaveLength(1);
  });

  it('throws when the backend answers false', async () => {
    const { client } = makeClient({ 'GET /pedalboard/list': summaries, 'GET /pedalboard/remove/': false });
    const [, board] = await client.pedalboards.list();
    await expect(board.remove()).rejects.toThrow(/could not remove/);
  });
});

describe('PedalboardReference.copy()', () => {
  const copySummary = {
    ...summaries[1],
    bundle: '/root/.pedalboards/My_Board_2_.pedalboard',
    title: 'My Board (2)',
    version: 0,
  };
  const factorySummary = {
    ...summaries[1],
    factory: true,
    title: 'Factory Board',
    bundle: '/usr/share/mod/pedalboards/Factory.pedalboard',
  };

  /** Routes of a device where the copy of the source ends up as `copy`. */
  function routes(storedTitle: string, copy = copySummary, extra: Record<string, unknown> = {}) {
    return {
      'GET /pedalboard/list': [...summaries, factorySummary, copy],
      'GET /pedalboard/info/': { ...infoBody, title: storedTitle },
      'GET /pedalboard/factorycopy/': { ...infoBody, title: copy.title, bundlepath: copy.bundle },
      ...extra,
    };
  }

  it('sends the stored title and returns the new reference from the list', async () => {
    const { client, calls } = makeClient(routes('My Board'));
    const [, board] = await client.pedalboards.list();
    const copy = await board.copy();

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/pedalboard/list',
      '/pedalboard/info/',
      '/pedalboard/factorycopy/',
      '/pedalboard/list',
    ]);
    const request = new URL(calls[2].url);
    expect(request.searchParams.get('bundlepath')).toBe(board.bundlepath);
    expect(request.searchParams.get('title')).toBe('My Board');
    expect(calls[2].method).toBe('GET');

    expect(copy.bundlepath).toBe(copySummary.bundle);
    expect(copy.title).toBe('My Board (2)');
    expect(copy.factory).toBe(false);
    expect(copy).not.toBe(board);
  });

  it('copies a factory pedalboard too', async () => {
    const factoryCopy = { ...copySummary, title: 'Factory Board', bundle: '/root/.pedalboards/Factory_Board.pedalboard' };
    const { client, calls } = makeClient(routes('Factory Board', factoryCopy));
    const list = await client.pedalboards.list();
    const copy = await list.find((pb) => pb.factory)!.copy();

    expect(new URL(calls[2].url).searchParams.get('bundlepath')).toBe(factorySummary.bundle);
    expect(copy.factory).toBe(false);
    expect(copy.title).toBe('Factory Board');
  });

  it('uses the title stored in the bundle, not the one shown by the list', async () => {
    // the list shows "My Board (2)" for a duplicated name, the bundle still says "My Board"
    const dupe = { ...summaries[1], title: 'My Board (2)' };
    const { client, calls } = makeClient({
      ...routes('My Board'),
      'GET /pedalboard/list': [dupe, copySummary],
    });
    const [board] = await client.pedalboards.list();
    expect(board.title).toBe('My Board (2)');
    await board.copy();
    expect(new URL(calls[2].url).searchParams.get('title')).toBe('My Board');
  });

  const unsafeTitles: [string, string][] = [
    ['a single quote (shell injection)', "O'Brien"],
    ['a double quote', 'Say "hi"'],
    ['a slash (sed delimiter)', 'Rock/Pop'],
    ['an ampersand', 'Rock & Roll'],
    ['a backslash', 'Back\\slash'],
    ['an asterisk', 'Rock*'],
    ['an opening bracket', 'Rock [live'],
    ['a newline', 'two\nlines'],
  ];

  for (const [what, title] of unsafeTitles) {
    it(`refuses a title with ${what} without calling factorycopy`, async () => {
      const { client, calls } = makeClient(routes(title));
      const [, board] = await client.pedalboards.list();
      await expect(board.copy()).rejects.toThrow(/cannot be copied/);
      expect(calls.some((c) => new URL(c.url).pathname === '/pedalboard/factorycopy/')).toBe(false);
    });
  }

  it('accepts ordinary punctuation', async () => {
    const { client } = makeClient(routes('Mr. Brown (live) - 2024! #1, café'));
    const [, board] = await client.pedalboards.list();
    await expect(board.copy()).resolves.toBeInstanceOf(PedalboardReference);
  });

  it('refuses a pedalboard without a title', async () => {
    const { client, calls } = makeClient(routes('  '));
    const [, board] = await client.pedalboards.list();
    await expect(board.copy()).rejects.toThrow(/no title/);
    expect(calls.some((c) => new URL(c.url).pathname === '/pedalboard/factorycopy/')).toBe(false);
  });

  it('throws when the backend answers false', async () => {
    const { client } = makeClient(routes('My Board', copySummary, { 'GET /pedalboard/factorycopy/': false }));
    const [, board] = await client.pedalboards.list();
    await expect(board.copy()).rejects.toThrow(/could not copy/);
  });

  it('throws when the copy is missing from the list', async () => {
    const { client } = makeClient(routes('My Board', copySummary, { 'GET /pedalboard/list': summaries }));
    const [, board] = await client.pedalboards.list();
    await expect(board.copy()).rejects.toThrow(/not in the pedalboard list/);
  });

  it('turns HTTP errors into ModUiHttpError', async () => {
    const { client } = makeClient(
      routes('My Board', copySummary, { 'GET /pedalboard/factorycopy/': new Response('sed failed', { status: 500 }) }),
    );
    const [, board] = await client.pedalboards.list();
    await expect(board.copy()).rejects.toBeInstanceOf(ModUiHttpError);
  });
});
