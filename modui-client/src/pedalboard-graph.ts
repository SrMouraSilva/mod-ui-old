// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Plugins, ports and connections of the running pedalboard, and the engine behind
 * `device.currentPedalboard.plugins`, `.connections` and `.ports` ({@link PedalboardGraph}, internal).
 * @module
 */

import { ModUiError } from './errors';
import type { EventChannel } from './events';
import type { HttpTransport } from './http';
import type { GraphModel, GraphState, ModelPlugin } from './graph-state';
import { PluginPatchParams, patchFrameValue } from './patch-params';
import type { PluginsApi } from './plugins';
import type { PluginInfo, PluginPortInfo, PluginTarget, PortDirection, PortType, Position } from './types';

/** Runs a task after the pending device operations (see `Device`), so it never overlaps a load or a save. */
export type Enqueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A connectable port of the running pedalboard: a port of a plugin instance, or one of the pedalboard itself
 * (physical inputs/outputs, MIDI ports, ...; {@link Port.owner} is `null`).
 *
 * `direction` is seen from the graph: an `output` is a signal source, an `input` a sink. The pedalboard's own
 * capture ports are therefore *outputs* and its playback ports *inputs*.
 */
export class Port {
  /** @internal Built by the client. */
  constructor(
    /** Port id used in URLs and WebSocket frames: `/graph/capture_1`, `/graph/Gain/out`. */
    readonly id: string,
    /** Last segment of the id: the LV2 port symbol, or the pedalboard port name. */
    readonly symbol: string,
    /** Display name (plugin port name, or the title of a pedalboard port). */
    readonly name: string,
    readonly type: PortType,
    readonly direction: PortDirection,
    /** The plugin instance this port belongs to; `null` for a port of the pedalboard itself. */
    readonly owner: PluginInstance | null,
  ) {}
}

/** What a {@link PluginInstance} asks the engine to do (internal). */
export interface InstanceOps {
  /** The current model entry of a plugin, or `undefined` when it is not in the pedalboard (any more). */
  live(instance: string): ModelPlugin | undefined;
  remove(instance: string): Promise<void>;
  setParam(instance: string, symbol: string, value: number): Promise<void>;
  /** Sends `patch_set` with the already validated and encoded value. */
  setPatch(instance: string, uri: string, typeChar: string, encoded: string): Promise<void>;
  /** Sends `patch_get` and resolves with the raw text of the answer. */
  refreshPatch(instance: string, uri: string, timeoutMs?: number): Promise<string>;
  isActive(instance: string): Promise<boolean>;
  setActive(instance: string, active: boolean): Promise<void>;
  toggle(instance: string): Promise<boolean>;
  move(instance: string, position: Position): Promise<void>;
}

/** Control ports the host drives itself: `param_set` on them is refused. */
const HOST_DESIGNATIONS = [
  'http://lv2plug.in/ns/lv2core#enabled',
  'http://lv2plug.in/ns/lv2core#freeWheeling',
  'http://lv2plug.in/ns/ext/time#beatsPerBar',
  'http://lv2plug.in/ns/ext/time#beatsPerMinute',
  'http://lv2plug.in/ns/ext/time#speed',
];

/**
 * A control input of a plugin instance: a knob, a switch, a selector. Get them with `instance.params.list()` or
 * `instance.params.get('gain')`.
 *
 * The description (`symbol`, `name`, `default`, `minimum`, `maximum`, ...) never changes. {@link Param.value} is read from
 * the live state each time, so it follows changes made by this client, by the classic UI and by other clients.
 */
export class Param {
  readonly symbol: string;
  readonly name: string;
  readonly default: number;
  /** `-Infinity` when the plugin does not say. */
  readonly minimum: number;
  /** `Infinity` when the plugin does not say. */
  readonly maximum: number;
  /** LV2 designation URI, empty when none. Ports with a designation the host drives (enabled, transport, ...) cannot be set. */
  readonly designation: string;
  /** LV2 port properties such as `toggled`, `integer`, `enumeration`, `logarithmic`, `trigger`, `notOnGUI`. */
  readonly properties: string[];

  /** @internal Built by the client. */
  constructor(readonly owner: PluginInstance, port: PluginPortInfo, private readonly ops: InstanceOps) {
    this.symbol = port.symbol;
    this.name = port.name;
    this.default = port.ranges?.default ?? 0;
    this.minimum = port.ranges?.minimum ?? -Infinity;
    this.maximum = port.ranges?.maximum ?? Infinity;
    this.designation = port.designation ?? '';
    this.properties = port.properties ?? [];
  }

  /**
   * The current value: the last one the backend announced (`param_set`) or this client sent, `default` when none is known
   * yet. Synchronous: it reads memory, it makes no request.
   */
  get value(): number {
    return this.owner.liveModel().values.get(this.symbol) ?? this.default;
  }

  /**
   * Changes the value in the audio engine.
   *
   * The backend does not confirm a `param_set` to the socket that sent it (only to the other sockets), so there is nothing
   * to wait for: the promise resolves once the message was sent, and {@link Param.value} already shows the new value.
   * The call is queued behind loads, resets and saves.
   *
   * Checked before anything is sent (the backend would close the socket on some bad messages): the value is a finite
   * number between `minimum` and `maximum`, the port is not driven by the host, and the plugin is still in the pedalboard.
   *
   * WebSocket: `param_set <instance>/<symbol> <value>` (see `connectMainWebSocket`).
   * @throws {ModUiError} for an invalid value, a host-driven port, or a plugin that is not in the pedalboard.
   * @example
   * const gain = instance.params.get('gain')!;
   * await gain.setValue(gain.default);
   * await gain.setValue(gain.maximum / 2);
   */
  setValue(value: number): Promise<void> {
    if (typeof value !== 'number' || !isFinite(value)) {
      return Promise.reject(new ModUiError(`"${this.symbol}": expected a finite number, got ${String(value)}`));
    }
    if (value < this.minimum || value > this.maximum) {
      return Promise.reject(
        new ModUiError(`"${this.symbol}": ${value} is outside the range ${this.minimum} .. ${this.maximum}`),
      );
    }
    if (HOST_DESIGNATIONS.includes(this.designation)) {
      return Promise.reject(new ModUiError(`"${this.symbol}" is driven by the host (${this.designation}) and cannot be set`));
    }
    return this.ops.setParam(this.owner.instance, this.symbol, value);
  }
}

/** The control inputs of a plugin instance (`instance.params`). */
export class PluginParams {
  /** @internal Built by the client. */
  constructor(private readonly items: Param[]) {}

  /**
   * Every control input, in the order of the plugin. Synchronous: the description is already known when the instance
   * exists. Empty when the plugin is not installed.
   * @example
   * for (const param of instance.params.list()) console.log(param.symbol, param.value, param.minimum, param.maximum);
   */
  list(): Param[] {
    return [...this.items];
  }

  /**
   * Finds a control input by symbol.
   * @example
   * await instance.params.get('gain')?.setValue(3.5);
   */
  get(symbol: string): Param | undefined {
    return this.items.find((param) => param.symbol === symbol);
  }
}

/**
 * A plugin in the running pedalboard.
 *
 * `x`, `y`, {@link Param.value} and the active state are read from the live state, so they follow changes made through this
 * client, the classic UI or other clients. The object keeps its identity and its ports; list again to learn about plugins
 * that were added or removed.
 */
export class PluginInstance {
  /** Instance path, e.g. `/graph/Gain`. */
  readonly instance: string;
  /** LV2 URI of the plugin. */
  readonly uri: string;
  /**
   * Connectable ports by type and direction: `ports.audio.input`, `ports.audio.output`, `ports.midi.input`, ...
   * Control ports are not connectable and are not listed.
   */
  readonly ports: PortGroups = emptyPortGroups();
  /** The control inputs (knobs, switches, ...): `params.list()`, `params.get('gain')`. */
  readonly params: PluginParams;
  /** The patch parameters (strings, paths, booleans, ...): `patchParams.list()`, `patchParams.get(uri)`. */
  readonly patchParams: PluginPatchParams;

  /** @internal Built by the client. */
  constructor(
    private readonly last: ModelPlugin,
    /** Description of the plugin; `null` when the plugin is not installed. */
    readonly info: PluginInfo | null,
    private readonly ops: InstanceOps,
  ) {
    this.instance = last.instance;
    this.uri = last.uri;
    const params: Param[] = [];
    if (info) {
      for (const type of PORT_TYPES) {
        for (const direction of ['input', 'output'] as const) {
          for (const port of info.ports[type]?.[direction] ?? []) {
            this.ports[type][direction].push(
              new Port(`${this.instance}/${port.symbol}`, port.symbol, port.name, type, direction, this),
            );
          }
        }
      }
      for (const port of info.ports.control?.input ?? []) {
        params.push(new Param(this, port, ops));
      }
    }
    this.params = new PluginParams(params);
    this.patchParams = new PluginPatchParams(this, info?.parameters ?? [], ops);
  }

  /** @internal The live state of this plugin (the last known one when it was removed). */
  liveModel(): ModelPlugin {
    return this.ops.live(this.instance) ?? this.last;
  }

  /** Horizontal position of the block in the canvas. */
  get x(): number {
    return this.liveModel().x;
  }

  /** Vertical position of the block in the canvas. */
  get y(): number {
    return this.liveModel().y;
  }

  /**
   * Finds a port by symbol, whatever its type and direction.
   * @example
   * const input = instance.port('in');   // same as instance.ports.audio.input[0] for a mono effect
   */
  port(symbol: string): Port | undefined {
    return allPorts(this.ports).find((port) => port.symbol === symbol);
  }

  /**
   * Whether the plugin is processing audio (`true`) or bypassed (`false`). Reads the live state, after the socket is in sync.
   * @throws {ModUiError} when the plugin is not in the pedalboard (any more).
   * @example
   * if (await instance.isActive()) console.log('on');
   */
  isActive(): Promise<boolean> {
    return this.ops.isActive(this.instance);
  }

  /**
   * Turns the plugin on (`true`) or bypasses it (`false`). Like {@link Param.setValue}, the backend sends no confirmation to
   * the sender: the promise resolves once the message was sent.
   *
   * WebSocket: `param_set <instance>/:bypass <0|1>` (`1` bypasses).
   * @throws {ModUiError} when the plugin is not in the pedalboard.
   * @example
   * await instance.setActive(false);   // bypass
   */
  setActive(active: boolean): Promise<void> {
    if (typeof active !== 'boolean') {
      return Promise.reject(new ModUiError('Expected true (on) or false (bypassed)'));
    }
    return this.ops.setActive(this.instance, active);
  }

  /**
   * Switches between on and bypassed and resolves with the new state (`true` = active).
   * @throws {ModUiError} when the plugin is not in the pedalboard.
   * @example
   * const active = await instance.toggle();
   */
  toggle(): Promise<boolean> {
    return this.ops.toggle(this.instance);
  }

  /**
   * Moves the block in the canvas and resolves once the message was sent (no confirmation is sent to the sender). The
   * position is stored with the pedalboard at the next save, and `x` / `y` already show it.
   *
   * WebSocket: `plugin_pos <instance> <x> <y>`.
   * @throws {ModUiError} for coordinates that are not finite numbers, or a plugin that is not in the pedalboard.
   * @example
   * await instance.move({ x: 320, y: 140 });
   */
  move(position: Position): Promise<void> {
    if (!position || !isFinite(position.x) || !isFinite(position.y) || typeof position.x !== 'number' || typeof position.y !== 'number') {
      return Promise.reject(new ModUiError('Expected a position { x, y } with finite numbers'));
    }
    return this.ops.move(this.instance, position);
  }

  /**
   * Removes this plugin (and its connections) from the pedalboard. Same as `plugins.remove(instance)`.
   * @throws {ModUiError} see {@link PedalboardPlugins.remove}.
   */
  remove(): Promise<void> {
    return this.ops.remove(this.instance);
  }
}

/** The ports of one type, split by direction. */
export interface PortsByDirection {
  /** Sinks. */
  input: Port[];
  /** Sources. */
  output: Port[];
}

/** Ports by type and direction: `groups.audio.input`, `groups.midi.output`, ... */
export type PortGroups = Record<PortType, PortsByDirection>;

function emptyPortGroups(): PortGroups {
  return {
    audio: { input: [], output: [] },
    midi: { input: [], output: [] },
    cv: { input: [], output: [] },
  };
}

function allPorts(groups: PortGroups): Port[] {
  const result: Port[] = [];
  for (const type of PORT_TYPES) {
    result.push(...groups[type].input, ...groups[type].output);
  }
  return result;
}

/** A connection between an output and an input of the running pedalboard. */
export class PedalboardConnection {
  /** @internal Built by the client. */
  constructor(
    /** The source: an output port. */
    readonly from: Port,
    /** The sink: an input port. */
    readonly to: Port,
  ) {}

  /** `"<from id>,<to id>"`, the form used in URLs. */
  get id(): string {
    return `${this.from.id},${this.to.id}`;
  }
}

const PORT_TYPES: PortType[] = ['audio', 'midi', 'cv'];
/** Sources before sinks. */
const DIRECTION_ORDER: PortDirection[] = ['output', 'input'];

/** Everything the graph holds at one moment. */
interface GraphView {
  instances: PluginInstance[];
  /** Ports of the pedalboard itself. */
  pedalboardPorts: Port[];
  connections: PedalboardConnection[];
  /** Finds a port by object or id, any port of the pedalboard. */
  port(ref: Port | string): Port;
}

/** `graph/Gain` and `/graph/Gain` are the same port; the client always uses the leading slash. */
function normalizeId(id: string): string {
  return id.startsWith('/') ? id : '/' + id;
}

/**
 * Instance path for a new plugin, as the classic UI does (`generateInstance` in `html/js/pedalboard.js`): last URI
 * segment, invalid characters → `_`, `_` prefix when it starts with a digit, `/graph/cv` is reserved, then `_1`,
 * `_2`, ... until it is unused.
 */
export function generateInstance(uri: string, used: { has(instance: string): boolean }): string {
  const lastDelimiter = (text: string): number => {
    for (let i = text.length - 1; i > 0; --i) {
      if ('/?#:'.includes(text[i])) {
        return i;
      }
    }
    return -1;
  };
  let name = uri;
  let delimiter = lastDelimiter(name);
  while (delimiter !== -1 && !/[a-zA-Z0-9]/.test(name.slice(delimiter))) {
    name = name.slice(0, delimiter);
    delimiter = lastDelimiter(name);
  }
  name = name.slice(delimiter + 1).replace(/[^_a-zA-Z0-9]+/g, '_');
  if (name === '') {
    name = 'plugin';
  }
  if (/^[0-9]/.test(name)) {
    name = '_' + name;
  }
  let instance = '/graph/' + name;
  if (instance === '/graph/cv') {
    instance += 'x';
  }
  if (used.has(instance)) {
    const base = instance;
    let n = 1;
    do {
      instance = `${base}_${n++}`;
    } while (used.has(instance));
  }
  return instance;
}

/**
 * Engine of `device.currentPedalboard.plugins`, `.connections` and `.ports` (internal).
 *
 * Reads come from the WebSocket-fed {@link GraphState}; writes are HTTP requests confirmed by the matching
 * WebSocket frame. Everything runs through the `Device` queue.
 */
export class PedalboardGraph {
  constructor(
    private readonly http: HttpTransport,
    private readonly events: EventChannel,
    private readonly state: GraphState,
    private readonly plugins: PluginsApi,
    private readonly enqueue: Enqueue,
    private readonly confirmTimeoutMs: number,
  ) {}

  // ---- reads --------------------------------------------------------------------------------------------------------

  /** Plugin instances of the running pedalboard. */
  listInstances(): Promise<PluginInstance[]> {
    return this.enqueue(async () => (await this.view()).instances);
  }

  /** Ports of the pedalboard itself, optionally of one type and direction: audio, MIDI, CV; sources first; by index. */
  listPedalboardPorts(type?: PortType, direction?: PortDirection): Promise<Port[]> {
    return this.enqueue(async () =>
      (await this.view()).pedalboardPorts.filter(
        (port) => (type === undefined || port.type === type) && (direction === undefined || port.direction === direction),
      ),
    );
  }

  /** Connections of the running pedalboard. */
  listConnections(): Promise<PedalboardConnection[]> {
    return this.enqueue(async () => (await this.view()).connections);
  }

  // ---- writes -------------------------------------------------------------------------------------------------------

  addPlugin(target: PluginTarget, position?: Position): Promise<PluginInstance> {
    return this.enqueue(async () => {
      const uri = typeof target === 'string' ? target : target && target.uri;
      if (typeof uri !== 'string' || uri === '') {
        throw new ModUiError('Expected a plugin URI, a Plugin or a PluginInfo');
      }
      const model = await this.state.ready();
      const instance = generateInstance(uri, model.plugins);

      // The backend pushes "add" before it answers the HTTP request: wait first.
      const added = this.events.waitFor('add', this.confirmTimeoutMs, (args) => args.split(' ')[0] === instance);
      let info: PluginInfo | false;
      try {
        info = await this.http.getJson<PluginInfo | false>(`/effect/add/${instance}`, {
          uri,
          x: position?.x ?? 0,
          y: position?.y ?? 0,
        });
      } catch (error) {
        added.cancel();
        throw error;
      }
      if (!info) {
        added.cancel();
        throw new ModUiError(`The backend could not load the plugin "${uri}" (is it installed?)`);
      }
      this.plugins.remember(info);
      await added.promise;

      const created = model.plugins.get(instance);
      if (!created) {
        throw new ModUiError(`The plugin "${instance}" disappeared right after it was added`);
      }
      return this.instanceOf(created, info);
    });
  }

  removePlugin(target: string | { readonly instance: string }): Promise<void> {
    return this.enqueue(async () => {
      const instance = normalizeId(typeof target === 'string' ? target : (target && target.instance) ?? '');
      const model = await this.state.ready();
      if (!model.plugins.has(instance)) {
        throw new ModUiError(`There is no plugin "${instance}" in the running pedalboard`);
      }
      // The backend sends "disconnect" frames and then "remove" before it answers.
      const removed = this.events.waitFor('remove', this.confirmTimeoutMs, (args) => args === instance);
      let ok: boolean;
      try {
        ok = await this.http.getJson<boolean>(`/effect/remove/${instance}`);
      } catch (error) {
        removed.cancel();
        throw error;
      }
      if (ok !== true) {
        removed.cancel();
        throw new ModUiError(`The backend could not remove the plugin "${instance}"`);
      }
      await removed.promise;
    });
  }

  // The backend sends no confirmation to the socket that sent "param_set", "patch_set" or "plugin_pos" (only to the others), so these
  // calls resolve once the message is sent, and update the model themselves.

  setParam(instance: string, symbol: string, value: number): Promise<void> {
    return this.enqueue(async () => {
      const plugin = await this.requirePlugin(instance);
      this.events.send(`param_set ${instance}/${symbol} ${value}`);
      plugin.values.set(symbol, value);
    });
  }

  setPatch(instance: string, uri: string, typeChar: string, encoded: string): Promise<void> {
    return this.enqueue(async () => {
      const plugin = await this.requirePlugin(instance);
      this.events.send(`patch_set ${instance} ${uri} ${typeChar} ${encoded}`);
      plugin.patches.set(uri, encoded);
    });
  }

  /**
   * `patch_get` is answered by a `patch_set` frame to every socket. The wait is registered before the request is sent and
   * the queue is left before waiting, so a slow or silent plugin does not block loads, saves and other calls.
   */
  async refreshPatch(instance: string, uri: string, timeoutMs: number = this.confirmTimeoutMs): Promise<string> {
    const answer = await this.enqueue(async () => {
      await this.requirePlugin(instance);
      const waiting = this.events.waitFor('patch_set', timeoutMs, (args) => {
        const [id, , parameter] = args.split(' ');
        return id === instance && parameter === uri;
      });
      try {
        this.events.send(`patch_get ${instance} ${uri}`);
      } catch (error) {
        waiting.cancel();
        throw error;
      }
      return waiting;
    });
    return patchFrameValue(await answer.promise) ?? '';
  }

  isActive(instance: string): Promise<boolean> {
    return this.enqueue(async () => !(await this.requirePlugin(instance)).bypassed);
  }

  setActive(instance: string, active: boolean): Promise<void> {
    return this.enqueue(async () => {
      const plugin = await this.requirePlugin(instance);
      this.events.send(`param_set ${instance}/:bypass ${active ? '0.0' : '1.0'}`);
      plugin.bypassed = !active;
    });
  }

  toggle(instance: string): Promise<boolean> {
    return this.enqueue(async () => {
      const plugin = await this.requirePlugin(instance);
      const active = plugin.bypassed; // bypassed now -> active after
      this.events.send(`param_set ${instance}/:bypass ${active ? '0.0' : '1.0'}`);
      plugin.bypassed = !active;
      return active;
    });
  }

  move(instance: string, position: Position): Promise<void> {
    return this.enqueue(async () => {
      const plugin = await this.requirePlugin(instance);
      this.events.send(`plugin_pos ${instance} ${position.x} ${position.y}`);
      plugin.x = position.x;
      plugin.y = position.y;
    });
  }

  connect(from: Port | string, to: Port | string): Promise<PedalboardConnection> {
    return this.enqueue(async () => {
      const view = await this.view();
      const source = view.port(from);
      const target = view.port(to);
      validateConnection(source, target);

      const existing = view.connections.find((c) => c.from.id === source.id && c.to.id === target.id);
      if (existing) {
        // The backend answers "true" and sends no frame for a connection that exists.
        return existing;
      }
      const connected = this.events.waitFor('connect', this.confirmTimeoutMs, (args) => args === `${source.id} ${target.id}`);
      let ok: boolean;
      try {
        ok = await this.http.getJson<boolean>(`/effect/connect/${source.id},${target.id}`);
      } catch (error) {
        connected.cancel();
        throw error;
      }
      if (ok !== true) {
        connected.cancel();
        throw new ModUiError(`The backend could not connect "${source.id}" to "${target.id}"`);
      }
      await connected.promise;
      return new PedalboardConnection(source, target);
    });
  }

  disconnect(connection: PedalboardConnection | { readonly from: Port | string; readonly to: Port | string }): Promise<void> {
    return this.enqueue(async () => {
      const model = await this.state.ready();
      const from = normalizeId(typeof connection.from === 'string' ? connection.from : connection.from.id);
      const to = normalizeId(typeof connection.to === 'string' ? connection.to : connection.to.id);
      // The backend answers "true" and broadcasts "disconnect" even when nothing was connected.
      if (!model.hasConnection(from, to)) {
        throw new ModUiError(`"${from}" is not connected to "${to}"`);
      }
      const disconnected = this.events.waitFor('disconnect', this.confirmTimeoutMs, (args) => args === `${from} ${to}`);
      let ok: boolean;
      try {
        ok = await this.http.getJson<boolean>(`/effect/disconnect/${from},${to}`);
      } catch (error) {
        disconnected.cancel();
        throw error;
      }
      if (ok !== true) {
        disconnected.cancel();
        throw new ModUiError(`The backend could not disconnect "${from}" from "${to}"`);
      }
      await disconnected.promise;
    });
  }

  // ---- model → objects ----------------------------------------------------------------------------------------------

  private readonly ops: InstanceOps = {
    live: (instance) => this.state.peek().plugins.get(instance),
    remove: (instance) => this.removePlugin(instance),
    setParam: (instance, symbol, value) => this.setParam(instance, symbol, value),
    setPatch: (instance, uri, typeChar, encoded) => this.setPatch(instance, uri, typeChar, encoded),
    refreshPatch: (instance, uri, timeoutMs) => this.refreshPatch(instance, uri, timeoutMs),
    isActive: (instance) => this.isActive(instance),
    setActive: (instance, active) => this.setActive(instance, active),
    toggle: (instance) => this.toggle(instance),
    move: (instance, position) => this.move(instance, position),
  };

  private instanceOf(model: ModelPlugin, info: PluginInfo | null): PluginInstance {
    return new PluginInstance(model, info, this.ops);
  }

  /** The model entry of a plugin. The backend raises (and closes the socket) for an unknown instance, so check first. */
  private async requirePlugin(instance: string): Promise<ModelPlugin> {
    const plugin = (await this.state.ready()).plugins.get(instance);
    if (!plugin) {
      throw new ModUiError(`There is no plugin "${instance}" in the running pedalboard`);
    }
    return plugin;
  }

  /** Builds the objects for the current model. Must run inside the queue. */
  private async view(): Promise<GraphView> {
    const model: GraphModel = await this.state.ready();
    const infos = await this.plugins.infosOf(Array.from(model.plugins.values()).map((plugin) => plugin.uri));

    const instances = Array.from(model.plugins.values()).map((plugin) => this.instanceOf(plugin, infos.get(plugin.uri) ?? null));
    const pedalboardPorts = Array.from(model.hardware.values())
      .sort((a, b) => PORT_TYPES.indexOf(a.type) - PORT_TYPES.indexOf(b.type) || DIRECTION_ORDER.indexOf(a.direction) - DIRECTION_ORDER.indexOf(b.direction) || a.index - b.index)
      .map((port) => new Port(port.id, port.id.slice(port.id.lastIndexOf('/') + 1), port.title, port.type, port.direction, null));

    const ports = new Map<string, Port>();
    for (const port of pedalboardPorts) {
      ports.set(port.id, port);
    }
    for (const instance of instances) {
      for (const port of allPorts(instance.ports)) {
        ports.set(port.id, port);
      }
    }
    const find = (ref: Port | string): Port => {
      const id = normalizeId(typeof ref === 'string' ? ref : ref && ref.id);
      const port = ports.get(id);
      if (!port) {
        throw new ModUiError(`There is no port "${id}" in the running pedalboard`);
      }
      return port;
    };

    // Connections whose ports are unknown (a plugin that is not installed) are left out.
    const connections: PedalboardConnection[] = [];
    for (const { from, to } of model.connections) {
      const source = ports.get(from);
      const target = ports.get(to);
      if (source && target) {
        connections.push(new PedalboardConnection(source, target));
      }
    }
    return { instances, pedalboardPorts, connections, port: find };
  }
}

/** Throws {@link ModUiError} unless `from` is an output, `to` an input of the same type, on different plugins. */
function validateConnection(from: Port, to: Port): void {
  if (from.direction !== 'output') {
    throw new ModUiError(`"${from.id}" is an input: the first port of a connection must be an output`);
  }
  if (to.direction !== 'input') {
    throw new ModUiError(`"${to.id}" is an output: the second port of a connection must be an input`);
  }
  if (from.type !== to.type) {
    throw new ModUiError(`Cannot connect ${from.type} "${from.id}" to ${to.type} "${to.id}": the types differ`);
  }
  if (from.owner !== null && to.owner !== null && from.owner.instance === to.owner.instance) {
    throw new ModUiError(`Cannot connect two ports of the same plugin ("${from.owner.instance}")`);
  }
}
