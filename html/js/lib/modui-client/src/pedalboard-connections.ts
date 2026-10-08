// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The connections of the running pedalboard: {@link PedalboardConnections}
 * (`client.device.currentPedalboard.connections`) and the pedalboard's own ports ({@link PedalboardPorts}).
 * @module
 */

import type { PedalboardConnection, PedalboardGraph, Port } from './pedalboard-graph';
import type { PortType } from './types';

/**
 * The connections of the running pedalboard (`client.device.currentPedalboard.connections`).
 *
 * Like the plugins, they come from the WebSocket state, so {@link PedalboardConnections.list} is asynchronous.
 * Ports are {@link Port} objects, found in `instance.ports.<type>.<direction>` and in `currentPedalboard.ports.<type>.<direction>`; a port id such as
 * `/graph/Gain/out` is accepted too.
 *
 * @example
 * const { connections, ports } = client.device.currentPedalboard;
 * const [capture] = await ports.audio.output();
 * const connection = await connections.connect(capture, gain.ports.audio.input[0]);
 * await connections.disconnect(connection);
 */
export class PedalboardConnections {
  /** @internal Use `client.device.currentPedalboard.connections`. */
  constructor(private readonly graph: PedalboardGraph) {}

  /**
   * The connections that exist now. Connections to plugins that are not installed are left out.
   *
   * Backend: none (WebSocket state).
   * @example
   * for (const { from, to } of await client.device.currentPedalboard.connections.list()) {
   *   console.log(from.id, '→', to.id);
   * }
   */
  list(): Promise<PedalboardConnection[]> {
    return this.graph.listConnections();
  }

  /**
   * Connects an output to an input and resolves after the WebSocket `connect` frame.
   *
   * Checked before any request:
   * - `from` is an **output** and `to` an **input** (a source and a sink; the pedalboard's capture ports are
   *   outputs, its playback ports inputs);
   * - both have the **same type** (`audio`, `midi` or `cv`);
   * - both exist in the running pedalboard, and they are not ports of the same plugin.
   *
   * Either end may be a port of the pedalboard itself. If the connection already exists it is returned and nothing is
   * requested (the backend would answer `true` without a frame).
   *
   * Backend: `GET /effect/connect/{from},{to}` (operationId `connectPorts`).
   * @param from The source: an output {@link Port} or its id.
   * @param to The sink: an input {@link Port} or its id.
   * @throws {ModUiError} for an invalid pair, an unknown port, or when the backend refuses.
   * @example
   * const connection = await connections.connect('/graph/capture_1', '/graph/Gain/in');
   */
  connect(from: Port | string, to: Port | string): Promise<PedalboardConnection> {
    return this.graph.connect(from, to);
  }

  /**
   * Removes a connection and resolves after the WebSocket `disconnect` frame.
   *
   * Backend: `GET /effect/disconnect/{from},{to}` (operationId `disconnectPorts`). The backend answers `true` and
   * announces the removal even when nothing was connected, so the client checks that the connection exists first.
   * @throws {ModUiError} when the connection does not exist.
   * @example
   * await client.device.currentPedalboard.connections.disconnect(connection);
   */
  disconnect(connection: PedalboardConnection): Promise<void> {
    return this.graph.disconnect(connection);
  }
}

/**
 * The ports of the pedalboard itself of one type (`currentPedalboard.ports.audio`, `.midi`, `.cv`), split by direction.
 *
 * The lists come from the WebSocket state, so `input()` and `output()` are methods that return a promise (in this client,
 * a property is never asynchronous). Every call asks for a fresh list.
 */
export class PedalboardPortGroup {
  /** @internal Use `client.device.currentPedalboard.ports`. */
  constructor(private readonly graph: PedalboardGraph, private readonly type: PortType) {}

  /**
   * The sinks of this type: where signal leaves the device (`/graph/playback_1`, `/graph/midi_broadcaster_in`, ...).
   * Ordered by index. Their `owner` is `null`.
   */
  input(): Promise<Port[]> {
    return this.graph.listPedalboardPorts(this.type, 'input');
  }

  /**
   * The sources of this type: where signal enters the device (`/graph/capture_1`, `/graph/midi_merger_out`, ...).
   * Ordered by index. Their `owner` is `null`.
   */
  output(): Promise<Port[]> {
    return this.graph.listPedalboardPorts(this.type, 'output');
  }
}

/**
 * The ports of the pedalboard itself (`client.device.currentPedalboard.ports`): its physical and virtual audio, MIDI
 * and CV inputs and outputs. Same layout as `pluginInstance.ports`, except that the lists are methods returning promises. They can be
 * connected to plugin ports (or to each other).
 *
 * The backend's "input of the device" (a capture port) is a source for the graph, so it is an `output` here, and the
 * other way round.
 *
 * Backend: none (WebSocket `add_hw_port` frames).
 *
 * @example
 * const { ports } = client.device.currentPedalboard;
 * const [capture] = await ports.audio.output();   // /graph/capture_1
 * const [playback] = await ports.audio.input();   // /graph/playback_1
 * const midiSources = await ports.midi.output();
 * const everything = await ports.list();          // all of them, as one flat list
 */
export class PedalboardPorts {
  readonly audio: PedalboardPortGroup;
  readonly midi: PedalboardPortGroup;
  readonly cv: PedalboardPortGroup;

  /** @internal Use `client.device.currentPedalboard.ports`. */
  constructor(private readonly graph: PedalboardGraph) {
    this.audio = new PedalboardPortGroup(graph, 'audio');
    this.midi = new PedalboardPortGroup(graph, 'midi');
    this.cv = new PedalboardPortGroup(graph, 'cv');
  }

  /**
   * Every port of the pedalboard as one flat list, ordered by type (audio, MIDI, CV), direction (sources first) and
   * index. Their `owner` is `null`.
   *
   * Backend: none (WebSocket `add_hw_port` frames).
   * @example
   * const ports = await client.device.currentPedalboard.ports.list();
   * const sources = ports.filter((port) => port.direction === 'output');
   */
  list(): Promise<Port[]> {
    return this.graph.listPedalboardPorts();
  }
}
