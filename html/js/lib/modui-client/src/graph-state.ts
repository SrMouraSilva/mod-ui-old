// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live model of the running pedalboard's graph (internal), fed by the main WebSocket.
 *
 * No HTTP endpoint lists the plugins or the connections of the running pedalboard (`GET /pedalboard/info/` only knows
 * the saved bundle), so the client rebuilds them from the WebSocket: the state replay a fresh socket receives
 * (`add_hw_port`, `add`, `connect`, ... up to `loading_end`) and the live frames after it.
 * @module
 */

import { ModUiError } from './errors';
import type { EventChannel } from './events';
import type { PortDirection, PortType } from './types';

/** A plugin as the WebSocket describes it. */
export interface ModelPlugin {
  /** Instance path, e.g. `/graph/Gain`. */
  instance: string;
  uri: string;
  x: number;
  y: number;
  bypassed: boolean;
  /** Last known value of each control input port (by symbol), from `param_set` frames and from `Param.setValue()`. */
  values: Map<string, number>;
}

/** A port of the pedalboard itself (physical, virtual or MIDI), from `add_hw_port`. */
export interface ModelHardwarePort {
  /** Port id, e.g. `/graph/capture_1`. */
  id: string;
  type: PortType;
  /** Seen from the graph: `output` for an input of the device (a source), `input` for an output of the device. */
  direction: PortDirection;
  title: string;
  index: number;
}

/** A connection as the WebSocket describes it. */
export interface ModelConnection {
  from: string;
  to: string;
}

/** The graph, updated by {@link GraphModel.apply}. */
export class GraphModel {
  readonly plugins = new Map<string, ModelPlugin>();
  readonly hardware = new Map<string, ModelHardwarePort>();
  connections: ModelConnection[] = [];

  /** Applies one WebSocket message; unrelated commands are ignored. */
  apply(command: string, args: string): void {
    const parts = args.split(' ');
    switch (command) {
      case 'add_hw_port': {
        // <port> <type:audio|midi|cv> <direction:0|1> <title> <index>
        const [id, type, direction, title, index] = parts;
        if (id && (type === 'audio' || type === 'midi' || type === 'cv')) {
          this.hardware.set(id, {
            id,
            type,
            direction: direction === '0' ? 'output' : 'input',
            title: title ?? id,
            index: parseInt(index, 10) || 0,
          });
        }
        break;
      }
      case 'remove_hw_port':
        this.hardware.delete(parts[0]);
        this.dropConnectionsOf(parts[0]);
        break;
      case 'add': {
        // <instance> <uri> <x> <y> <bypassed> <version> <officialBuild>
        const [instance, uri, x, y, bypassed] = parts;
        if (instance && uri) {
          this.plugins.set(instance, {
            instance,
            uri,
            x: parseFloat(x) || 0,
            y: parseFloat(y) || 0,
            bypassed: bypassed === '1',
            values: new Map(),
          });
        }
        break;
      }
      case 'remove':
        if (parts[0] === ':all') {
          this.clearPedalboard();
        } else {
          this.plugins.delete(parts[0]);
          this.dropConnectionsOf(parts[0]);
        }
        break;
      case 'loading_start':
        // A (re)load or the initial replay begins. Hardware ports stay: a load does not send them again.
        this.clearPedalboard();
        break;
      case 'connect': {
        const [from, to] = parts;
        if (from && to && !this.hasConnection(from, to)) {
          this.connections.push({ from, to });
        }
        break;
      }
      case 'disconnect':
        this.connections = this.connections.filter((c) => !(c.from === parts[0] && c.to === parts[1]));
        break;
      case 'plugin_pos': {
        const plugin = this.plugins.get(parts[0]);
        if (plugin) {
          plugin.x = parseFloat(parts[1]) || 0;
          plugin.y = parseFloat(parts[2]) || 0;
        }
        break;
      }
      case 'param_set': {
        // <instance> <symbol> <value>; for ":bypass" a value >= 0.5 means bypassed.
        const plugin = this.plugins.get(parts[0]);
        if (plugin && parts[1] === ':bypass') {
          plugin.bypassed = parseFloat(parts[2]) >= 0.5;
        } else if (plugin && parts[1] && !isNaN(parseFloat(parts[2]))) {
          plugin.values.set(parts[1], parseFloat(parts[2]));
        }
        break;
      }
    }
  }

  hasConnection(from: string, to: string): boolean {
    return this.connections.some((c) => c.from === from && c.to === to);
  }

  private clearPedalboard(): void {
    this.plugins.clear();
    this.connections = [];
  }

  private dropConnectionsOf(owner: string): void {
    const prefix = owner + '/';
    this.connections = this.connections.filter(
      (c) => c.from !== owner && c.to !== owner && !c.from.startsWith(prefix) && !c.to.startsWith(prefix),
    );
  }
}

/** Commands that change the {@link GraphModel}. */
const GRAPH_COMMANDS = [
  'add_hw_port',
  'remove_hw_port',
  'add',
  'remove',
  'loading_start',
  'connect',
  'disconnect',
  'plugin_pos',
  'param_set',
];

/**
 * Keeps a {@link GraphModel} in sync with the main WebSocket.
 *
 * The handlers are registered when the object is created, before the socket is opened, so the initial replay
 * of an own socket feeds the model. A shared socket (`options.webSocket`) delivered its replay before the client
 * existed: then {@link GraphState.ready} reads one snapshot through a short-lived second socket.
 */
export class GraphState {
  private model = new GraphModel();
  /** Live frames received while a snapshot is being read; applied on top of it. */
  private buffer: Array<[string, string]> | null = null;
  private snapshot: Promise<void> | null = null;

  /**
   * @param events The main WebSocket.
   * @param openSnapshotChannel Creates an own (non-shared) channel; `null` when no WebSocket class is available.
   */
  constructor(private readonly events: EventChannel, private readonly openSnapshotChannel: () => EventChannel | null) {
    for (const command of GRAPH_COMMANDS) {
      events.on(command, (args) => {
        if (this.buffer) {
          this.buffer.push([command, args]);
        } else {
          this.model.apply(command, args);
        }
      });
    }
  }

  /** The model as it is now, without waiting for the socket. Use {@link GraphState.ready} before trusting it. */
  peek(): GraphModel {
    return this.model;
  }

  /**
   * Connects the socket and resolves with the up-to-date model.
   * @throws {ModUiTimeoutError} when the backend does not answer.
   * @throws {ModUiError} for a shared socket when no `WebSocket` class is available to read the snapshot.
   */
  async ready(): Promise<GraphModel> {
    await this.events.connect();
    if (!this.events.ownsSocket) {
      if (!this.snapshot) {
        this.snapshot = this.readSnapshot().catch((error) => {
          this.snapshot = null;
          throw error;
        });
      }
      await this.snapshot;
    }
    return this.model;
  }

  private async readSnapshot(): Promise<void> {
    const channel = this.openSnapshotChannel();
    if (!channel) {
      throw new ModUiError(
        'The shared WebSocket already delivered its state replay: pass options.WebSocket so the client can read a snapshot',
      );
    }
    const fresh = new GraphModel();
    channel.on('*', (args, command) => fresh.apply(command, args));
    this.buffer = [];
    try {
      await channel.connect();
    } catch (error) {
      this.buffer = null;
      throw error;
    } finally {
      channel.close();
    }
    this.model = fresh;
    const pending = this.buffer;
    this.buffer = null;
    for (const [command, args] of pending) {
      fresh.apply(command, args);
    }
  }
}
