// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ModUiError, ModUiTimeoutError, PatchParam, type PluginInstance } from '../src';
import {
  chunkUri,
  connectedWith,
  flush,
  gainInfo,
  gainUri,
  labelUri,
  loopUri,
  makeClient,
  patchInfo,
  patchUri,
  pluginSummaries,
  sampleUri,
  setupFakes,
  stepsUri,
  type FakeWebSocket,
} from './helpers';

setupFakes();

const instanceId = '/graph/Patcher';
const addFrame = `add ${instanceId} ${patchUri} 10.0 20.0 0 1.0.0.0 0`;

/** Replay frames with the values a real device reports for the parameters (writable = 1: the host tracks them). */
const replay = [
  addFrame,
  `patch_set ${instanceId} 1 ${labelUri} s Hello big world`,
  `patch_set ${instanceId} 1 ${loopUri} b 1`,
  `patch_set ${instanceId} 1 ${stepsUri} i 8`,
];

/** A device running the Patcher plugin; `info` replaces its description. */
async function device(frames: string[] = replay, info: unknown = patchInfo) {
  const made = makeClient({
    'GET /effect/list': pluginSummaries,
    'POST /effect/bulk/': { [gainUri]: gainInfo, [patchUri]: info },
  });
  const socket = await connectedWith(made.client, frames);
  const instance = (await made.client.device.currentPedalboard.plugins.list())[0];
  return { ...made, socket, instance };
}

const patchFrames = (socket: FakeWebSocket) => socket.sent.filter((frame) => /^patch_(set|get)/.test(frame));
const param = (instance: PluginInstance, uri: string) => instance.patchParams.get(uri)!;

describe('instance.patchParams description', () => {
  it('lists the parameters of the types the client handles, in plugin order, and leaves the others out', async () => {
    const { instance } = await device();
    const list = instance.patchParams.list();

    expect(list.map((p) => p.uri)).toEqual([labelUri, sampleUri, loopUri, stepsUri]);
    expect(list[0]).toBeInstanceOf(PatchParam);
    expect(instance.patchParams.get(chunkUri)).toBeUndefined();
    expect(instance.patchParams.get('urn:nothing')).toBeUndefined();
    expect(instance.info?.parameters).toHaveLength(5); // the raw description keeps everything
  });

  it('exposes type, flags, defaults, ranges and file filters', async () => {
    const { instance } = await device();

    expect(param(instance, labelUri)).toMatchObject({ type: 'string', label: 'label', readable: true, writable: true, default: 'Hello' });
    expect(param(instance, labelUri).minimum).toBeUndefined();
    expect(param(instance, sampleUri)).toMatchObject({
      type: 'path',
      readable: false,
      fileTypes: ['audio'],
      supportedExtensions: ['wav', '.FLAC'],
    });
    expect(param(instance, loopUri)).toMatchObject({ type: 'bool', default: false });
    expect(param(instance, stepsUri)).toMatchObject({ type: 'int', writable: false, default: 8, minimum: 1, maximum: 16 });
  });

  it('has no patch parameters for a plugin without any', async () => {
    const made = makeClient({ 'GET /effect/list': pluginSummaries, 'POST /effect/bulk/': { [gainUri]: gainInfo } });
    await connectedWith(made.client, [`add /graph/Gain ${gainUri} 0.0 0.0 0 1.0.0.0 0`]);
    const [gain] = await made.client.device.currentPedalboard.plugins.list();
    expect(gain.patchParams.list()).toEqual([]);
  });
});

describe('PatchParam.value', () => {
  it('comes from the state replay: values with spaces, 1 / true for bool, integers parsed', async () => {
    const { instance } = await device();
    expect(param(instance, labelUri).value).toBe('Hello big world');
    expect(param(instance, loopUri).value).toBe(true);
    expect(param(instance, stepsUri).value).toBe(8);
    expect(param(instance, sampleUri).value).toBeUndefined(); // never reported
  });

  it('follows live frames from the plugin or another client', async () => {
    const { instance, socket } = await device();
    socket.emit(`patch_set ${instanceId} 1 ${labelUri} s Verse 2`);
    socket.emit(`patch_set ${instanceId} 1 ${loopUri} b false`);
    socket.emit(`patch_set ${instanceId} 1 ${sampleUri} p /data/user-files/a b.wav`);
    socket.emit(`patch_set ${instanceId} 0 ${stepsUri} i 12`);
    expect(param(instance, labelUri).value).toBe('Verse 2');
    expect(param(instance, loopUri).value).toBe(false);
    expect(param(instance, sampleUri).value).toBe('/data/user-files/a b.wav');
    expect(param(instance, stepsUri).value).toBe(12);
  });

  it('ignores frames of other plugins and malformed ones', async () => {
    const { instance, socket } = await device();
    socket.emit(`patch_set /graph/Other 1 ${labelUri} s nope`);
    socket.emit(`patch_set ${instanceId}`);
    expect(param(instance, labelUri).value).toBe('Hello big world');
  });

  it('is cleared when the pedalboard is reloaded and replayed', async () => {
    const { instance, socket } = await device();
    socket.emit('loading_start 0 0');
    socket.emit(addFrame);
    expect(param(instance, labelUri).value).toBeUndefined();
    socket.emit(`patch_set ${instanceId} 1 ${labelUri} s Again`);
    expect(param(instance, labelUri).value).toBe('Again');
  });
});

describe('PatchParam.setValue()', () => {
  it.each([
    ['string with spaces', labelUri, 'some text', `patch_set ${instanceId} ${labelUri} s some text`],
    ['bool true', loopUri, true, `patch_set ${instanceId} ${loopUri} b 1`],
    ['bool false', loopUri, false, `patch_set ${instanceId} ${loopUri} b 0`],
    ['path in a supported extension', sampleUri, '/data/x.WAV', `patch_set ${instanceId} ${sampleUri} p /data/x.WAV`],
    ['path with a dotted extension in the list', sampleUri, '/data/x.flac', `patch_set ${instanceId} ${sampleUri} p /data/x.flac`],
  ])('sends the exact frame for a %s', async (_name, uri, value, frame) => {
    const { instance, socket } = await device();
    await param(instance, uri).setValue(value as string | boolean);
    expect(patchFrames(socket)).toEqual([frame]);
    expect(param(instance, uri).value).toBe(value);
  });

  it('sends integers without decimals and floats as text, and shows the value at once', async () => {
    const steps = { ...patchInfo.parameters[3], writable: true };
    const gain = { ...steps, uri: patchUri + '#gain', type: 'http://lv2plug.in/ns/ext/atom#Float', ranges: { minimum: -1, maximum: 1, default: 0 } };
    const { instance, socket } = await device([addFrame], { ...patchInfo, parameters: [steps, gain] });

    await param(instance, stepsUri).setValue(3);
    await param(instance, patchUri + '#gain').setValue(0.25);
    expect(patchFrames(socket)).toEqual([`patch_set ${instanceId} ${stepsUri} i 3`, `patch_set ${instanceId} ${patchUri}#gain f 0.25`]);
    expect(param(instance, stepsUri).value).toBe(3);
    expect(param(instance, patchUri + '#gain').value).toBe(0.25);
  });

  it.each([
    ['a number for a string', labelUri, 5, /non-empty string/],
    ['an empty string', labelUri, '', /non-empty string/],
    ['a newline', labelUri, 'a\nb', /control characters/],
    ['a NUL', labelUri, 'a\u0000b', /control characters/],
    ['a string for a bool', loopUri, 'yes', /true or false/],
    ['a path with another extension', sampleUri, '/data/x.mp3', /extension/],
    ['a path without extension', sampleUri, '/data/x', /extension/],
    ['an empty path', sampleUri, '', /non-empty string/],
    ['a parameter that is not writable', stepsUri, 4, /not writable/],
  ])('rejects %s and sends nothing', async (_name, uri, value, message) => {
    const { instance, socket } = await device();
    const result = param(instance, uri).setValue(value as string);
    await expect(result).rejects.toBeInstanceOf(ModUiError);
    await expect(result).rejects.toThrow(message);
    expect(patchFrames(socket)).toEqual([]);
    expect(param(instance, labelUri).value).toBe('Hello big world');
  });

  it('checks numbers: finite, integer for int, inside the range', async () => {
    const steps = { ...patchInfo.parameters[3], writable: true };
    const { instance, socket } = await device([addFrame], { ...patchInfo, parameters: [steps] });
    const param = instance.patchParams.get(stepsUri)!;

    await expect(param.setValue(NaN)).rejects.toThrow(/finite number/);
    await expect(param.setValue(Infinity)).rejects.toThrow(/finite number/);
    await expect(param.setValue('3' as unknown as number)).rejects.toThrow(/finite number/);
    await expect(param.setValue(2.5)).rejects.toThrow(/integer/);
    await expect(param.setValue(0)).rejects.toThrow(/outside the range 1 .. 16/);
    await expect(param.setValue(17)).rejects.toThrow(/outside the range/);
    expect(patchFrames(socket)).toEqual([]);

    await param.setValue(1);
    await param.setValue(16);
    expect(patchFrames(socket)).toEqual([`patch_set ${instanceId} ${stepsUri} i 1`, `patch_set ${instanceId} ${stepsUri} i 16`]);
  });

  it('accepts a uri without whitespace and refuses whitespace', async () => {
    const link = { ...patchInfo.parameters[0], uri: patchUri + '#link', type: 'http://lv2plug.in/ns/ext/atom#URI' };
    const { instance, socket } = await device([addFrame], { ...patchInfo, parameters: [link] });
    const param = instance.patchParams.get(patchUri + '#link')!;

    await expect(param.setValue('urn:a b')).rejects.toThrow(/whitespace/);
    await param.setValue('urn:ab');
    expect(patchFrames(socket)).toEqual([`patch_set ${instanceId} ${patchUri}#link u urn:ab`]);
  });

  it('rejects when the plugin is gone, without sending', async () => {
    const { instance, socket } = await device();
    const label = param(instance, labelUri);
    socket.emit(`remove ${instanceId}`);
    await expect(label.setValue('x')).rejects.toThrow(/no plugin "\/graph\/Patcher"/);
    expect(patchFrames(socket)).toEqual([]);
  });
});

describe('PatchParam.refresh()', () => {
  it('sends patch_get and resolves with the parsed answer', async () => {
    const { instance, socket } = await device();
    const pending = param(instance, labelUri).refresh();
    await flush();
    expect(patchFrames(socket)).toEqual([`patch_get ${instanceId} ${labelUri}`]);

    socket.emit(`patch_set ${instanceId} 1 ${labelUri} s Chorus A`);
    expect(await pending).toBe('Chorus A');
    expect(param(instance, labelUri).value).toBe('Chorus A');
  });

  it('ignores answers for another uri or instance', async () => {
    const { instance, socket } = await device();
    let settled = false;
    const pending = param(instance, labelUri)
      .refresh()
      .finally(() => (settled = true));
    await flush();
    socket.emit(`patch_set ${instanceId} 1 ${loopUri} b 0`);
    socket.emit(`patch_set /graph/Other 1 ${labelUri} s other`);
    await flush();
    expect(settled).toBe(false);

    socket.emit(`patch_set ${instanceId} 1 ${labelUri} s mine`);
    expect(await pending).toBe('mine');
  });

  it('registers the wait before sending: an answer that arrives during the send is not lost', async () => {
    const { instance, socket } = await device();
    const send = socket.send.bind(socket);
    socket.send = (data: string) => {
      send(data);
      if (data.startsWith('patch_get')) socket.emit(`patch_set ${instanceId} 1 ${labelUri} s instant`);
    };
    expect(await param(instance, labelUri).refresh()).toBe('instant');
  });

  it('rejects for a parameter that is not readable and for a plugin that is gone, without sending', async () => {
    const { instance, socket } = await device();
    await expect(param(instance, sampleUri).refresh()).rejects.toThrow(/not readable/);
    const label = param(instance, labelUri);
    socket.emit(`remove ${instanceId}`);
    await expect(label.refresh()).rejects.toThrow(/no plugin "\/graph\/Patcher"/);
    expect(patchFrames(socket)).toEqual([]);
  });

  it('times out when the plugin never answers', async () => {
    const { instance } = await device();
    await expect(param(instance, labelUri).refresh({ timeoutMs: 20 })).rejects.toBeInstanceOf(ModUiTimeoutError);
  });

  it('does not hold the device queue while it waits for the plugin', async () => {
    const { instance, socket } = await device();
    const pending = param(instance, labelUri).refresh({ timeoutMs: 500 });
    await flush();

    await instance.move({ x: 5, y: 6 }); // would hang if refresh() still held the queue
    expect(socket.sent).toContain(`plugin_pos ${instanceId} 5 6`);

    socket.emit(`patch_set ${instanceId} 1 ${labelUri} s done`);
    expect(await pending).toBe('done');
  });
});
