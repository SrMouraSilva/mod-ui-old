// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ModUiError } from '../src';
import { connected, flush, makeClient, summaries, setupFakes } from './helpers';

setupFakes();

const myBundle = summaries[1].bundle;

/** Routes of a device whose running pedalboard is "My Board", saved in `myBundle`. */
function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /pedalboard/list': summaries,
    'GET /pedalboard/current': { bundlepath: myBundle, title: 'My Board', modified: true },
    'POST /pedalboard/save': { ok: true, bundlepath: myBundle, title: 'My Board' },
    ...extra,
  };
}

function formOf(body: string | undefined) {
  const form = new URLSearchParams(body);
  return { title: form.get('title'), asNew: form.get('asNew') };
}

describe('client.device.currentPedalboard.get()', () => {
  it('returns the list entry of the running bundle', async () => {
    const { client, calls } = makeClient(routes());
    const current = await client.device.currentPedalboard.get();

    expect(current?.title).toBe('My Board');
    expect(current?.bundlepath).toBe(myBundle);
    expect(current?.version).toBe(3);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/pedalboard/current', '/pedalboard/list']);
  });

  it('ignores trailing slashes when matching the bundle', async () => {
    const { client } = makeClient(
      routes({ 'GET /pedalboard/current': { bundlepath: myBundle + '/', title: 'My Board', modified: false } }),
    );
    await expect(client.device.currentPedalboard.get()).resolves.toMatchObject({ bundlepath: myBundle });
  });

  it('returns null for an untitled pedalboard, without listing', async () => {
    const { client, calls } = makeClient(
      routes({ 'GET /pedalboard/current': { bundlepath: '', title: '', modified: false } }),
    );
    await expect(client.device.currentPedalboard.get()).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('throws when the running bundle is not in the list', async () => {
    const { client } = makeClient(
      routes({ 'GET /pedalboard/current': { bundlepath: '/gone.pedalboard', title: 'Gone', modified: false } }),
    );
    await expect(client.device.currentPedalboard.get()).rejects.toThrow(/not in the pedalboard list/);
  });
});

describe('client.device.currentPedalboard.save()', () => {
  it('keeps the current title when none is given (asNew=0)', async () => {
    const { client, calls } = makeClient(routes());
    const saved = await client.device.currentPedalboard.save();

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /pedalboard/current',
      'POST /pedalboard/save',
      'GET /pedalboard/list',
    ]);
    expect(formOf(calls[1].body)).toEqual({ title: 'My Board', asNew: '0' });
    expect(saved.bundlepath).toBe(myBundle);
  });

  it('renames when a title is given, without reading the current one', async () => {
    const { client, calls } = makeClient(routes());
    await client.device.currentPedalboard.save('Renamed');

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/pedalboard/save', '/pedalboard/list']);
    expect(formOf(calls[0].body)).toEqual({ title: 'Renamed', asNew: '0' });
  });

  it('returns the bundle the backend wrote (a factory pedalboard is copied)', async () => {
    const copy = { ...summaries[1], bundle: '/root/.pedalboards/Factory-2.pedalboard', title: 'Factory 2' };
    const { client } = makeClient(
      routes({
        'GET /pedalboard/list': [...summaries, copy],
        'POST /pedalboard/save': { ok: true, bundlepath: copy.bundle, title: copy.title },
      }),
    );
    const saved = await client.device.currentPedalboard.save();
    expect(saved.bundlepath).toBe(copy.bundle);
    expect(saved.title).toBe('Factory 2');
  });

  it('asks for a title when the running pedalboard is untitled', async () => {
    const { client, calls } = makeClient(
      routes({ 'GET /pedalboard/current': { bundlepath: '', title: '', modified: true } }),
    );
    await expect(client.device.currentPedalboard.save()).rejects.toThrow(/no title yet/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects a blank title without any request', async () => {
    const { client, calls } = makeClient(routes());
    await expect(client.device.currentPedalboard.save('   ')).rejects.toBeInstanceOf(ModUiError);
    expect(calls).toHaveLength(0);
  });

  it('throws when the backend reports a failure', async () => {
    const { client } = makeClient(
      routes({ 'POST /pedalboard/save': { ok: false, bundlepath: null, title: 'My Board' } }),
    );
    await expect(client.device.currentPedalboard.save()).rejects.toThrow(/failed to save/);
  });

  it('throws when the saved bundle is missing from the list', async () => {
    const { client } = makeClient(
      routes({ 'POST /pedalboard/save': { ok: true, bundlepath: '/new.pedalboard', title: 'New' } }),
    );
    await expect(client.device.currentPedalboard.save()).rejects.toThrow(/not in the pedalboard list/);
  });
});

describe('client.device.currentPedalboard.saveAs()', () => {
  it('saves a new bundle (asNew=1) and returns it with the final title', async () => {
    const created = { ...summaries[1], bundle: '/root/.pedalboards/Solo-2.pedalboard', title: 'Solo 2', version: 0 };
    const { client, calls } = makeClient(
      routes({
        'GET /pedalboard/list': [...summaries, created],
        'POST /pedalboard/save': { ok: true, bundlepath: created.bundle, title: 'Solo 2' },
      }),
    );
    const saved = await client.device.currentPedalboard.saveAs('Solo');

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/pedalboard/save', '/pedalboard/list']);
    expect(formOf(calls[0].body)).toEqual({ title: 'Solo', asNew: '1' });
    expect(saved.title).toBe('Solo 2');
    expect(saved.bundlepath).toBe(created.bundle);
  });

  it('rejects a blank title', async () => {
    const { client } = makeClient(routes());
    await expect(client.device.currentPedalboard.saveAs('')).rejects.toBeInstanceOf(ModUiError);
  });
});

describe('currentPedalboard and device operations', () => {
  it('a save waits for a load in progress', async () => {
    const { client, calls } = makeClient({
      ...routes(),
      'GET /reset': true,
      'POST /pedalboard/load_bundle/': { ok: true, name: 'My Board' },
    });
    const socket = await connected(client);

    const loading = client.device.load(myBundle);
    const saving = client.device.currentPedalboard.save();
    await flush();
    expect(calls.some((c) => new URL(c.url).pathname === '/pedalboard/save')).toBe(false);

    socket.emit('loading_end 0');
    await loading;
    await saving;
    expect(calls.some((c) => new URL(c.url).pathname === '/pedalboard/save')).toBe(true);
  });
});
