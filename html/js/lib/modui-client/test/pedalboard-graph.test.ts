// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ModUiError, ModUiTimeoutError, PedalboardConnection, PluginInstance, type Port } from '../src';
import { generateInstance } from '../src/pedalboard-graph';
import {
  FakeWebSocket,
  connectedWith,
  flush,
  gainInfo,
  gainUri,
  hardwareFrames,
  makeClient,
  midiInfo,
  midiUri,
  pluginSummaries,
  setupFakes,
} from './helpers';

setupFakes();

const gainFrame = (instance: string, x = 10, y = 20) => `add ${instance} ${gainUri} ${x}.0 ${y}.0 0 1.0.0.0 0`;

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /effect/list': pluginSummaries,
    'POST /effect/bulk/': { [gainUri]: gainInfo, [midiUri]: midiInfo },
    ...extra,
  };
}

/** A device with the hardware ports and a Gain plugin wired capture_1 → Gain → playback_1. */
async function wiredDevice(extra: Record<string, unknown> = {}) {
  const made = makeClient(routes(extra));
  const socket = await connectedWith(made.client, [
    ...hardwareFrames,
    gainFrame('/graph/Gain'),
    'connect /graph/capture_1 /graph/Gain/in',
    'connect /graph/Gain/out /graph/playback_1',
  ]);
  return { ...made, socket, current: made.client.device.currentPedalboard };
}

const requests = (calls: { method: string; url: string }[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
const idsOf = (ports: Port[]) => ports.map((port) => port.id);

describe('generateInstance()', () => {
  const none = new Set<string>();
  it('uses the last segment of the URI', () => {
    expect(generateInstance(gainUri, none)).toBe('/graph/Gain');
    expect(generateInstance('urn:test#my-plugin', none)).toBe('/graph/my_plugin');
  });
  it('skips trailing delimiters and prefixes names that start with a digit', () => {
    expect(generateInstance('http://x.org/plugins/Gain/', none)).toBe('/graph/Gain');
    expect(generateInstance('http://x.org/2x2', none)).toBe('/graph/_2x2');
  });
  it('avoids the reserved cv name and counts up from _1', () => {
    expect(generateInstance('http://x.org/cv', none)).toBe('/graph/cvx');
    expect(generateInstance(gainUri, new Set(['/graph/Gain']))).toBe('/graph/Gain_1');
    const many = new Set(['/graph/Gain', ...Array.from({ length: 12 }, (_, i) => `/graph/Gain_${i + 1}`)]);
    expect(generateInstance(gainUri, many)).toBe('/graph/Gain_13');
  });
});

describe('currentPedalboard.plugins.list()', () => {
  it('builds the instances from the state replay and reads their descriptions with one bulk request', async () => {
    const { current, calls } = await wiredDevice();
    const instances = await current.plugins.list();

    expect(instances).toHaveLength(1);
    expect(instances[0]).toBeInstanceOf(PluginInstance);
    expect(instances[0]).toMatchObject({ instance: '/graph/Gain', uri: gainUri, x: 10, y: 20 });
    expect(await instances[0].isActive()).toBe(true);
    expect(idsOf(instances[0].ports.audio.input)).toEqual(['/graph/Gain/in']);
    expect(idsOf(instances[0].ports.audio.output)).toEqual(['/graph/Gain/out']);
    expect(instances[0].ports.midi).toEqual({ input: [], output: [] });
    expect(instances[0].ports.cv).toEqual({ input: [], output: [] });
    expect(instances[0].port('in')).toMatchObject({ type: 'audio', direction: 'input', owner: instances[0] });
    expect(instances[0].port('gain')).toBeUndefined(); // control ports are not connectable
    expect(requests(calls)).toEqual(['POST /effect/bulk/']);
    expect(JSON.parse(calls[0].body!)).toEqual([gainUri]);

    await current.plugins.list();
    expect(calls).toHaveLength(1); // the description is cached
  });

  it('follows live frames: add, plugin_pos, bypass and remove (also on instances listed before)', async () => {
    const { current, socket } = await wiredDevice();
    socket.emit(`add /graph/Midi ${midiUri} 5.0 6.0 0 1.0.0.0 0`);
    socket.emit('plugin_pos /graph/Gain 100 200');
    socket.emit('param_set /graph/Gain :bypass 1.000000');

    const instances = await current.plugins.list();
    expect(instances.map((i) => i.instance)).toEqual(['/graph/Gain', '/graph/Midi']);
    expect(instances[0]).toMatchObject({ x: 100, y: 200 });
    expect(await instances[0].isActive()).toBe(false);
    socket.emit('plugin_pos /graph/Gain 7 8'); // the object is live: no need to list again
    expect(instances[0]).toMatchObject({ x: 7, y: 8 });

    socket.emit('remove /graph/Gain');
    expect((await current.plugins.list()).map((i) => i.instance)).toEqual(['/graph/Midi']);
  });

  it('is empty after "remove :all" and after a new loading_start, but keeps the pedalboard ports', async () => {
    const { current, socket } = await wiredDevice();
    socket.emit('remove :all');
    expect(await current.plugins.list()).toEqual([]);
    expect(await current.connections.list()).toEqual([]);
    expect(await current.ports.audio.output()).toHaveLength(2);

    socket.emit(gainFrame('/graph/Gain'));
    socket.emit('loading_start 0 0');
    expect(await current.plugins.list()).toEqual([]);
  });

  it('leaves plugins that are not installed without ports', async () => {
    const { current } = await wiredDevice({ 'POST /effect/bulk/': {} });
    const [instance] = await current.plugins.list();
    expect(instance.info).toBeNull();
    expect(instance.ports.audio).toEqual({ input: [], output: [] });
    expect(instance.port('in')).toBeUndefined();
    expect(await current.connections.list()).toEqual([]); // their connections cannot be resolved
  });

  it('reads a snapshot through a second socket when the socket is shared', async () => {
    const shared = new FakeWebSocket();
    shared.open();
    const { client } = makeClient(routes(), { webSocket: shared });
    const listing = client.device.currentPedalboard.plugins.list();
    await flush();

    const snapshot = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(snapshot).not.toBe(shared);
    snapshot.open();
    snapshot.emit('loading_start 0 0');
    snapshot.emit(gainFrame('/graph/Gain'));
    shared.emit('plugin_pos /graph/Gain 7 8'); // live frame that arrives meanwhile
    snapshot.emit('loading_end 0');

    const [instance] = await listing;
    expect(instance).toMatchObject({ instance: '/graph/Gain', x: 7, y: 8 });
    expect(snapshot.closed).toBe(true);
  });
});

describe('currentPedalboard.ports.list()', () => {
  it('groups the pedalboard ports by type and direction: device inputs are sources (outputs), device outputs are sinks (inputs)', async () => {
    const { current } = await wiredDevice();
    const { ports } = current;

    expect(idsOf(await ports.audio.output())).toEqual(['/graph/capture_1', '/graph/capture_2']);
    expect(idsOf(await ports.audio.input())).toEqual(['/graph/playback_1', '/graph/playback_2']);
    expect(idsOf(await ports.midi.output())).toEqual(['/graph/midi_merger_out']);
    expect(idsOf(await ports.midi.input())).toEqual(['/graph/midi_broadcaster_in']);
    expect(await ports.cv.output()).toEqual([]);
    expect(await ports.cv.input()).toEqual([]);

    const [capture] = await ports.audio.output();
    expect(capture).toMatchObject({ symbol: 'capture_1', name: 'Capture_1', type: 'audio', direction: 'output', owner: null });
  });

  it('list() returns all of them in one flat list: audio, MIDI, CV; sources first; by index', async () => {
    const { current } = await wiredDevice();
    const ports = await current.ports.list();

    expect(ports.every((port) => port.owner === null)).toBe(true);
    expect(ports.map((port) => `${port.id} ${port.type} ${port.direction}`)).toEqual([
      '/graph/capture_1 audio output',
      '/graph/capture_2 audio output',
      '/graph/playback_1 audio input',
      '/graph/playback_2 audio input',
      '/graph/midi_merger_out midi output',
      '/graph/midi_broadcaster_in midi input',
    ]);
  });

  it('forgets a port after remove_hw_port, with its connections', async () => {
    const { current, socket } = await wiredDevice();
    socket.emit('remove_hw_port /graph/playback_1');
    expect(idsOf(await current.ports.audio.input())).toEqual(['/graph/playback_2']);
    expect(idsOf(await current.ports.list())).not.toContain('/graph/playback_1');
    expect((await current.connections.list()).map((c) => c.id)).toEqual(['/graph/capture_1,/graph/Gain/in']);
  });
});

describe('currentPedalboard.connections.list()', () => {
  it('returns the connections with their Port objects', async () => {
    const { current } = await wiredDevice();
    const connections = await current.connections.list();

    expect(connections.every((c) => c instanceof PedalboardConnection)).toBe(true);
    expect(connections.map((c) => c.id)).toEqual([
      '/graph/capture_1,/graph/Gain/in',
      '/graph/Gain/out,/graph/playback_1',
    ]);
    expect(connections[0].from.owner).toBeNull();
    expect(connections[0].to.owner?.instance).toBe('/graph/Gain');
  });

  it('follows connect and disconnect frames', async () => {
    const { current, socket } = await wiredDevice();
    socket.emit('connect /graph/capture_2 /graph/Gain/in');
    socket.emit('disconnect /graph/capture_1 /graph/Gain/in');
    expect((await current.connections.list()).map((c) => c.id)).toEqual([
      '/graph/Gain/out,/graph/playback_1',
      '/graph/capture_2,/graph/Gain/in',
    ]);
  });
});

describe('currentPedalboard.plugins.add()', () => {
  it('registers the wait before the request, sends uri and position, and returns the instance', async () => {
    const holder: { socket?: FakeWebSocket } = {};
    const { client, calls } = makeClient(
      routes({
        // like the real backend, the WebSocket frame comes before the HTTP answer
        'GET /effect/add//graph/Gain': () => {
          holder.socket!.emit(gainFrame('/graph/Gain', 200, 100));
          return gainInfo;
        },
      }),
    );
    holder.socket = await connectedWith(client, hardwareFrames);

    const [gain] = (await client.device.plugins.list()).filter((p) => p.uri === gainUri);
    const created = await client.device.currentPedalboard.plugins.add(gain, { x: 200, y: 100 });

    const add = calls.find((c) => new URL(c.url).pathname === '/effect/add//graph/Gain')!;
    const query = new URL(add.url).searchParams;
    expect([query.get('uri'), query.get('x'), query.get('y')]).toEqual([gainUri, '200', '100']);
    expect(created).toBeInstanceOf(PluginInstance);
    expect(created).toMatchObject({ instance: '/graph/Gain', x: 200, y: 100 });
    expect(idsOf(created.ports.audio.input)).toEqual(['/graph/Gain/in']);
    expect(idsOf(created.ports.audio.output)).toEqual(['/graph/Gain/out']);
    // the description returned by the backend is reused: no bulk request
    expect(requests(calls)).not.toContain('POST /effect/bulk/');
    expect((await client.device.currentPedalboard.plugins.list()).map((i) => i.instance)).toEqual(['/graph/Gain']);
  });

  it('also resolves when the frame arrives after the HTTP answer, and accepts a bare URI at (0, 0)', async () => {
    const { client, calls } = makeClient(routes({ 'GET /effect/add//graph/Gain': gainInfo }));
    const socket = await connectedWith(client, hardwareFrames);

    const adding = client.device.currentPedalboard.plugins.add(gainUri);
    await flush();
    await flush();
    socket.emit(gainFrame('/graph/Gain', 0, 0));

    await expect(adding).resolves.toMatchObject({ instance: '/graph/Gain' });
    const query = new URL(calls[calls.length - 1].url).searchParams;
    expect([query.get('x'), query.get('y')]).toEqual(['0', '0']);
  });

  it('numbers the name when it is taken', async () => {
    const { current, socket } = await wiredDevice({ 'GET /effect/add//graph/Gain_1': gainInfo });
    const adding = current.plugins.add(gainUri);
    await flush();
    await flush();
    socket.emit(gainFrame('/graph/Gain_1'));
    await expect(adding).resolves.toMatchObject({ instance: '/graph/Gain_1' });
  });

  it('rejects when the backend answers false', async () => {
    const { client } = makeClient(routes({ 'GET /effect/add//graph/Gain': false }));
    await connectedWith(client, hardwareFrames);
    await expect(client.device.currentPedalboard.plugins.add(gainUri)).rejects.toThrow(/could not load the plugin/);
  });

  it('rejects an invalid target without any request', async () => {
    const { client, calls } = makeClient(routes());
    await connectedWith(client, hardwareFrames);
    await expect(client.device.currentPedalboard.plugins.add('')).rejects.toBeInstanceOf(ModUiError);
    expect(calls).toHaveLength(0);
  });

  it('rejects with a timeout when the add frame never arrives', async () => {
    const { client } = makeClient(routes({ 'GET /effect/add//graph/Gain': gainInfo }), { graphTimeoutMs: 20 });
    await connectedWith(client, hardwareFrames);
    await expect(client.device.currentPedalboard.plugins.add(gainUri)).rejects.toBeInstanceOf(ModUiTimeoutError);
  });
});

describe('currentPedalboard.plugins.remove()', () => {
  it('removes a plugin by instance object or path, with the frames the backend sends', async () => {
    const holder: { socket?: FakeWebSocket } = {};
    const { current, calls, socket } = await wiredDevice({
      'GET /effect/remove//graph/Gain': () => {
        holder.socket!.emit('disconnect /graph/capture_1 /graph/Gain/in');
        holder.socket!.emit('disconnect /graph/Gain/out /graph/playback_1');
        holder.socket!.emit('remove /graph/Gain');
        return true;
      },
    });
    holder.socket = socket;

    const [instance] = await current.plugins.list();
    await instance.remove();

    expect(requests(calls)).toContain('GET /effect/remove//graph/Gain');
    expect(await current.plugins.list()).toEqual([]);
    expect(await current.connections.list()).toEqual([]);
  });

  it('accepts a path without the leading slash', async () => {
    const holder: { socket?: FakeWebSocket } = {};
    const { current, socket } = await wiredDevice({
      'GET /effect/remove//graph/Gain': () => {
        holder.socket!.emit('remove /graph/Gain');
        return true;
      },
    });
    holder.socket = socket;
    await expect(current.plugins.remove('graph/Gain')).resolves.toBeUndefined();
  });

  it('rejects an unknown plugin without any request', async () => {
    const { current, calls } = await wiredDevice();
    await expect(current.plugins.remove('/graph/Nope')).rejects.toThrow(/no plugin "\/graph\/Nope"/);
    expect(requests(calls)).not.toContain('GET /effect/remove//graph/Nope');
  });

  it('rejects when the backend answers false', async () => {
    const { current } = await wiredDevice({ 'GET /effect/remove//graph/Gain': false });
    await expect(current.plugins.remove('/graph/Gain')).rejects.toThrow(/could not remove/);
  });
});

describe('currentPedalboard.connections.connect()', () => {
  async function freeDevice(extra: Record<string, unknown> = {}) {
    const made = makeClient(routes(extra));
    const socket = await connectedWith(made.client, [
      ...hardwareFrames,
      gainFrame('/graph/Gain'),
      `add /graph/Midi ${midiUri} 0.0 0.0 0 1.0.0.0 0`,
    ]);
    return { ...made, socket, current: made.client.device.currentPedalboard };
  }

  it('connects a pedalboard port to a plugin port and waits for the connect frame', async () => {
    const holder: { socket?: FakeWebSocket } = {};
    const { current, calls, socket } = await freeDevice({
      'GET /effect/connect//graph/capture_1,/graph/Gain/in': () => {
        holder.socket!.emit('connect /graph/capture_1 /graph/Gain/in');
        return true;
      },
    });
    holder.socket = socket;

    const [capture] = await current.ports.audio.output();
    const [gain] = await current.plugins.list();
    const connection = await current.connections.connect(capture, gain.port('in')!);

    expect(connection).toBeInstanceOf(PedalboardConnection);
    expect(connection.id).toBe('/graph/capture_1,/graph/Gain/in');
    expect(requests(calls)).toContain('GET /effect/connect//graph/capture_1,/graph/Gain/in');
    expect((await current.connections.list()).map((c) => c.id)).toEqual([connection.id]);
  });

  it('accepts port ids, with or without the leading slash', async () => {
    const holder: { socket?: FakeWebSocket } = {};
    const { current, socket } = await freeDevice({
      'GET /effect/connect//graph/Gain/out,/graph/playback_1': () => {
        holder.socket!.emit('connect /graph/Gain/out /graph/playback_1');
        return true;
      },
    });
    holder.socket = socket;
    const connection = await current.connections.connect('graph/Gain/out', '/graph/playback_1');
    expect(connection.from.owner?.instance).toBe('/graph/Gain');
    expect(connection.to.owner).toBeNull();
  });

  it('connects two ports of the pedalboard (capture → playback)', async () => {
    const holder: { socket?: FakeWebSocket } = {};
    const { current, socket } = await freeDevice({
      'GET /effect/connect//graph/capture_1,/graph/playback_1': () => {
        holder.socket!.emit('connect /graph/capture_1 /graph/playback_1');
        return true;
      },
    });
    holder.socket = socket;
    await expect(current.connections.connect('/graph/capture_1', '/graph/playback_1')).resolves.toBeInstanceOf(
      PedalboardConnection,
    );
  });

  it.each([
    ['output → output', '/graph/capture_1', '/graph/capture_2', /must be an input|is an output/],
    ['input → input', '/graph/Gain/in', '/graph/playback_1', /is an input/],
    ['input → output (swapped)', '/graph/playback_1', '/graph/capture_1', /is an input/],
    ['audio → midi', '/graph/capture_1', '/graph/Midi/midi_in', /types differ/],
    ['midi → audio', '/graph/Midi/midi_out', '/graph/Gain/in', /types differ/],
    ['unknown port', '/graph/capture_9', '/graph/Gain/in', /no port "\/graph\/capture_9"/],
    ['a control port', '/graph/capture_1', '/graph/Gain/gain', /no port "\/graph\/Gain\/gain"/],
    ['same plugin', '/graph/Gain/out', '/graph/Gain/in', /same plugin/],
  ])('rejects %s without any request', async (_name, from, to, message) => {
    const { current, calls } = await freeDevice();
    await expect(current.connections.connect(from, to)).rejects.toThrow(message);
    expect(requests(calls).filter((r) => r.includes('/effect/connect'))).toEqual([]);
  });

  it('returns the existing connection without a request when it already exists', async () => {
    const { current, calls } = await wiredDevice();
    const connection = await current.connections.connect('/graph/capture_1', '/graph/Gain/in');
    expect(connection.id).toBe('/graph/capture_1,/graph/Gain/in');
    expect(requests(calls).filter((r) => r.includes('/effect/connect'))).toEqual([]);
  });

  it('rejects when the backend answers false', async () => {
    const { current } = await freeDevice({ 'GET /effect/connect//graph/capture_1,/graph/Gain/in': false });
    await expect(current.connections.connect('/graph/capture_1', '/graph/Gain/in')).rejects.toThrow(/could not connect/);
  });
});

describe('currentPedalboard.connections.disconnect()', () => {
  it('removes a connection and waits for the disconnect frame', async () => {
    const holder: { socket?: FakeWebSocket } = {};
    const { current, calls, socket } = await wiredDevice({
      'GET /effect/disconnect//graph/capture_1,/graph/Gain/in': () => {
        holder.socket!.emit('disconnect /graph/capture_1 /graph/Gain/in');
        return true;
      },
    });
    holder.socket = socket;

    const [connection] = await current.connections.list();
    await current.connections.disconnect(connection);

    expect(requests(calls)).toContain('GET /effect/disconnect//graph/capture_1,/graph/Gain/in');
    expect((await current.connections.list()).map((c) => c.id)).toEqual(['/graph/Gain/out,/graph/playback_1']);
  });

  it('rejects a connection that does not exist, without any request (the backend would answer true)', async () => {
    const { current, calls } = await wiredDevice();
    const capture2 = (await current.ports.audio.output())[1];
    const [gain] = await current.plugins.list();
    const stranger = new PedalboardConnection(capture2, gain.port('in')!);

    await expect(current.connections.disconnect(stranger)).rejects.toThrow(/is not connected/);
    expect(requests(calls).filter((r) => r.includes('/effect/disconnect'))).toEqual([]);
  });
});

describe('queue', () => {
  it('runs graph calls after a pending load', async () => {
    const order: string[] = [];
    const { client } = makeClient({
      ...routes(),
      'GET /pedalboard/list': [
        {
          broken: false,
          factory: false,
          hasTrialPlugins: false,
          uri: 'file:///d.ttl',
          bundle: '/root/.pedalboards/default.pedalboard',
          title: 'Default',
          version: 0,
        },
      ],
      'GET /reset': () => {
        order.push('reset');
        return true;
      },
      'POST /pedalboard/load_bundle/': () => {
        order.push('load');
        socket.emit('loading_end 0');
        return { ok: true, name: '' };
      },
    });
    const socket = await connectedWith(client, hardwareFrames);

    const loading = client.device.loadDefault();
    const listing = client.device.currentPedalboard.plugins.list().then((instances) => {
      order.push('list');
      return instances;
    });
    await loading;
    await listing;
    expect(order).toEqual(['reset', 'load', 'list']);
  });
});

describe('instance.params', () => {
  const sentTo = (socket: FakeWebSocket) => socket.sent.filter((frame) => /^(param_set|plugin_pos)/.test(frame));

  it('lists the control inputs with their description, and finds them by symbol', async () => {
    const { current } = await wiredDevice();
    const [instance] = await current.plugins.list();

    const params = instance.params.list();
    expect(params.map((param) => param.symbol)).toEqual(['gain', 'enabled']);
    expect(instance.params.get('gain')).toMatchObject({
      symbol: 'gain', name: 'Gain', default: 0, minimum: -90, maximum: 24, designation: '', properties: [], owner: instance,
    });
    expect(instance.params.get('nope')).toBeUndefined();
    expect(instance.params.list()).not.toBe(params); // a copy
  });

  it('has no params when the plugin is not installed', async () => {
    const { current } = await wiredDevice({ 'POST /effect/bulk/': {} });
    const [instance] = await current.plugins.list();
    expect(instance.params.list()).toEqual([]);
  });

  it('value is the default until a value is known, then follows param_set frames (also from others)', async () => {
    const { current, socket } = await wiredDevice();
    socket.emit('param_set /graph/Gain gain 6.500000');
    const [instance] = await current.plugins.list();
    const gain = instance.params.get('gain')!;
    expect(gain.value).toBe(6.5);
    expect(instance.params.get('enabled')!.value).toBe(1); // default

    socket.emit('param_set /graph/Gain gain -3.000000');
    expect(gain.value).toBe(-3);
  });

  it('setValue() sends param_set and shows the new value at once, without waiting for an answer', async () => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();
    const gain = instance.params.get('gain')!;

    await gain.setValue(3.5);

    expect(sentTo(socket)).toEqual(['param_set /graph/Gain/gain 3.5']);
    expect(gain.value).toBe(3.5);
  });

  it.each([
    ['NaN', NaN, /finite number/],
    ['Infinity', Infinity, /finite number/],
    ['a string', '3' as unknown as number, /finite number/],
    ['above the maximum', 25, /outside the range/],
    ['below the minimum', -91, /outside the range/],
  ])('setValue() rejects %s without sending anything', async (_name, value, message) => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();
    await expect(instance.params.get('gain')!.setValue(value)).rejects.toThrow(message);
    expect(sentTo(socket)).toEqual([]);
  });

  it('accepts the limits of the range', async () => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();
    await instance.params.get('gain')!.setValue(-90);
    await instance.params.get('gain')!.setValue(24);
    expect(sentTo(socket)).toEqual(['param_set /graph/Gain/gain -90', 'param_set /graph/Gain/gain 24']);
  });

  it('setValue() refuses a port the host drives (designation) and a plugin that is gone', async () => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();
    await expect(instance.params.get('enabled')!.setValue(0)).rejects.toThrow(/driven by the host/);

    socket.emit('remove /graph/Gain');
    await expect(instance.params.get('gain')!.setValue(1)).rejects.toThrow(/no plugin "\/graph\/Gain"/);
    expect(sentTo(socket)).toEqual([]);
  });
});

describe('instance bypass: isActive(), setActive(), toggle()', () => {
  const bypassFrames = (socket: FakeWebSocket) => socket.sent.filter((frame) => frame.includes(':bypass'));

  it('isActive() reads the live state', async () => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();
    expect(await instance.isActive()).toBe(true);
    socket.emit('param_set /graph/Gain :bypass 1.000000');
    expect(await instance.isActive()).toBe(false);
    socket.emit('param_set /graph/Gain :bypass 0.000000');
    expect(await instance.isActive()).toBe(true);
  });

  it('setActive(false) bypasses and setActive(true) turns it on, with the state updated at once', async () => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();

    await instance.setActive(false);
    expect(await instance.isActive()).toBe(false);
    await instance.setActive(true);
    expect(await instance.isActive()).toBe(true);

    expect(bypassFrames(socket)).toEqual(['param_set /graph/Gain/:bypass 1.0', 'param_set /graph/Gain/:bypass 0.0']);
  });

  it('toggle() flips the state and resolves with the new one', async () => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();

    await expect(instance.toggle()).resolves.toBe(false);
    await expect(instance.toggle()).resolves.toBe(true);
    expect(bypassFrames(socket)).toEqual(['param_set /graph/Gain/:bypass 1.0', 'param_set /graph/Gain/:bypass 0.0']);
  });

  it('rejects a non-boolean and a plugin that is gone, without sending anything', async () => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();
    await expect(instance.setActive('yes' as unknown as boolean)).rejects.toBeInstanceOf(ModUiError);

    socket.emit('remove /graph/Gain');
    await expect(instance.isActive()).rejects.toThrow(/no plugin/);
    await expect(instance.setActive(false)).rejects.toThrow(/no plugin/);
    await expect(instance.toggle()).rejects.toThrow(/no plugin/);
    expect(bypassFrames(socket)).toEqual([]);
  });
});

describe('instance.move()', () => {
  it('sends plugin_pos and x / y show the new position at once', async () => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();

    await instance.move({ x: 320, y: 140.5 });

    expect(socket.sent.filter((f) => f.startsWith('plugin_pos'))).toEqual(['plugin_pos /graph/Gain 320 140.5']);
    expect(instance).toMatchObject({ x: 320, y: 140.5 });
  });

  it.each([[{ x: NaN, y: 1 }], [{ x: 1, y: Infinity }], [{ x: '1', y: 2 }], [null]])(
    'rejects the position %j without sending anything',
    async (position) => {
      const { current, socket } = await wiredDevice();
      const [instance] = await current.plugins.list();
      await expect(instance.move(position as never)).rejects.toThrow(/finite numbers/);
      expect(socket.sent.filter((f) => f.startsWith('plugin_pos'))).toEqual([]);
    },
  );

  it('rejects a plugin that is gone, without sending anything', async () => {
    const { current, socket } = await wiredDevice();
    const [instance] = await current.plugins.list();
    socket.emit('remove /graph/Gain');
    await expect(instance.move({ x: 1, y: 2 })).rejects.toThrow(/no plugin/);
    expect(socket.sent.filter((f) => f.startsWith('plugin_pos'))).toEqual([]);
  });

  it('runs after a pending load (device queue)', async () => {
    const order: string[] = [];
    const { client, current, socket } = await wiredDevice({
      'GET /pedalboard/list': [{ broken: false, factory: false, hasTrialPlugins: false, uri: 'file:///d.ttl', bundle: '/root/.pedalboards/default.pedalboard', title: 'Default', version: 0 }],
      'GET /reset': () => { order.push('reset'); return true; },
      'POST /pedalboard/load_bundle/': () => {
        order.push('load');
        socket.emit('loading_end 0');
        return { ok: true, name: '' };
      },
    });
    const [instance] = await current.plugins.list();
    socket.emit('add /graph/Other ' + gainUri + ' 0.0 0.0 0 1.0.0.0 0'); // so the plugin below still exists after the reset
    const loading = client.device.loadDefault();
    const moving = instance.move({ x: 1, y: 2 }).then(() => order.push('move'), (e) => order.push('move rejected: ' + e.message));
    await loading;
    await moving;
    expect(order.slice(0, 2)).toEqual(['reset', 'load']);
    expect(order[2]).toMatch(/^move/);
  });
});
