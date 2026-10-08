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
import type { PluginsApi } from './plugins';
import type { PluginInfo, PluginTarget, PortDirection, PortType, Position } from './types';

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

/**
 * A plugin in the running pedalboard. It is a snapshot taken when it was listed or created: `x`, `y` and
 * `bypassed` do not follow later changes.
 */
export class PluginInstance {
  /** Instance path, e.g. `/graph/Gain`. */
  readonly instance: string;
  /** LV2 URI of the plugin. */
  readonly uri: string;
  readonly x: number;
  readonly y: number;
  readonly bypassed: boolean;
  /**
   * Connectable ports by type and direction: `ports.audio.input`, `ports.audio.output`, `ports.midi.input`, ...
   * Control ports are not connectable and are not listed.
   */
  readonly ports: PortGroups = emptyPortGroups();

  /** @internal Built by the client. */
  constructor(
    model: ModelPlugin,
    /** Description of the plugin; `null` when the plugin is not installed. */
    readonly info: PluginInfo | null,
    private readonly removeInstance: (instance: string) => Promise<void>,
  ) {
    this.instance = model.instance;
    this.uri = model.uri;
    this.x = model.x;
    this.y = model.y;
    this.bypassed = model.bypassed;
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
    }
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
   * Removes this plugin (and its connections) from the pedalboard. Same as `plugins.remove(instance)`.
   * @throws {ModUiError} see {@link PedalboardPlugins.remove}.
   */
  remove(): Promise<void> {
    return this.removeInstance(this.instance);
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

  private instanceOf(model: ModelPlugin, info: PluginInfo | null): PluginInstance {
    return new PluginInstance(model, info, (instance) => this.removePlugin(instance));
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
