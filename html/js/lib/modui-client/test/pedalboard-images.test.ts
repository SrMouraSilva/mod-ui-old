// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ImageStatus, ModUiError } from '../src';
import { makeClient, summaries, setupFakes } from './helpers';

setupFakes();

const bundle = summaries[1].bundle; // '/root/.pedalboards/My Board&Co.pedalboard', version 3
const encodedBundle = '%2Froot%2F.pedalboards%2FMy+Board%26Co.pedalboard';

async function imagesOf(routes: Record<string, unknown> = {}) {
  const made = makeClient({ 'GET /pedalboard/list': summaries, ...routes });
  const [, reference] = await made.client.pedalboards.list();
  made.calls.length = 0; // forget the list request
  return { ...made, images: reference.images };
}

describe('reference.images URLs (sync)', () => {
  it('builds the thumbnail and screenshot URLs without any request', async () => {
    const { images, calls } = await imagesOf();

    expect(images.getThumbnailUrl()).toBe(
      `http://modduo.local/pedalboard/image/thumbnail.png?bundlepath=${encodedBundle}&v=3`,
    );
    expect(images.getScreenshotUrl()).toBe(
      `http://modduo.local/pedalboard/image/screenshot.png?bundlepath=${encodedBundle}&v=3`,
    );
    expect(calls).toHaveLength(0);
  });

  it('is exposed by every reference, tied to its own bundle', async () => {
    const { client } = makeClient({ 'GET /pedalboard/list': summaries });
    const [defaultBoard, board] = await client.pedalboards.list();
    expect(defaultBoard.images.getThumbnailUrl()).toContain('default.pedalboard');
    expect(board.images.getThumbnailUrl()).toContain('My+Board');
  });

  it('adds tstamp once the creation time is known', async () => {
    const { images } = await imagesOf({
      'GET /pedalboard/image/check': { status: 1, ctime: '1760000000.5' },
    });
    await images.status();
    expect(images.getThumbnailUrl()).toBe(
      `http://modduo.local/pedalboard/image/thumbnail.png?bundlepath=${encodedBundle}&v=3&tstamp=1760000000.5`,
    );
  });
});

describe('reference.images.status()', () => {
  const cases: [number, string, ImageStatus][] = [
    [-1, '0.0', ImageStatus.Missing],
    [0, '0.0', ImageStatus.Generating],
    [1, '1760000000.5', ImageStatus.Available],
  ];

  for (const [status, ctime, expected] of cases) {
    it(`maps check status ${status} to ${expected}`, async () => {
      const { images, calls } = await imagesOf({ 'GET /pedalboard/image/check': { status, ctime } });
      await expect(images.status()).resolves.toBe(expected);
      expect(calls[0].method).toBe('GET');
      expect(calls[0].url).toBe(`http://modduo.local/pedalboard/image/check?bundlepath=${encodedBundle}`);
    });
  }

  it('does not add tstamp when the images are not available', async () => {
    const { images } = await imagesOf({ 'GET /pedalboard/image/check': { status: -1, ctime: '0.0' } });
    await images.status();
    expect(images.getThumbnailUrl()).not.toContain('tstamp');
  });
});

describe('reference.images.generate()', () => {
  it('generates, then waits for pending jobs, in that order', async () => {
    const { images, calls } = await imagesOf({
      'GET /pedalboard/image/generate': { ok: true, ctime: '1760000001.0' },
      'GET /pedalboard/image/wait': { ok: true, ctime: '1760000002.0' },
    });
    await expect(images.generate()).resolves.toBeUndefined();

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/pedalboard/image/generate', '/pedalboard/image/wait']);
    expect(new URL(calls[0].url).searchParams.get('bundlepath')).toBe(bundle);
    expect(new URL(calls[1].url).searchParams.get('bundlepath')).toBe(bundle);
    // the URL now bypasses the browser cache with the final creation time
    expect(images.getScreenshotUrl()).toContain('tstamp=1760000002.0');
  });

  it('throws without waiting when the backend could not generate', async () => {
    const { images, calls } = await imagesOf({ 'GET /pedalboard/image/generate': { ok: false, ctime: '0.0' } });
    await expect(images.generate()).rejects.toBeInstanceOf(ModUiError);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/pedalboard/image/generate']);
  });

  it('throws when the images are still missing after waiting', async () => {
    const { images } = await imagesOf({
      'GET /pedalboard/image/generate': { ok: true, ctime: '1.0' },
      'GET /pedalboard/image/wait': { ok: false, ctime: '0.0' },
    });
    await expect(images.generate()).rejects.toThrow(/not available/);
  });
});
