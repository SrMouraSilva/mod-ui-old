// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The plugins of the running pedalboard: {@link PedalboardPlugins} (`client.device.currentPedalboard.plugins`).
 * @module
 */

import type { PedalboardGraph, PluginInstance } from './pedalboard-graph';
import type { PluginTarget, Position } from './types';

/**
 * The plugin instances of the running pedalboard (`client.device.currentPedalboard.plugins`).
 *
 * There is no HTTP endpoint that lists them: the client keeps a model fed by the main WebSocket (the state replay of
 * a new socket plus the live frames), so the first call waits for the socket to be connected and in sync. Changes made
 * by the classic UI or by other clients are therefore visible too.
 *
 * Calls are queued behind `device.load()`, `device.reset()` and saves, so they never run in the middle of one.
 *
 * @example
 * const { plugins } = client.device.currentPedalboard;
 * const gain = (await client.device.plugins.list()).find((p) => p.label === 'Gain')!;
 * const instance = await plugins.add(gain, { x: 200, y: 100 });   // "/graph/Gain"
 * console.log((await plugins.list()).map((i) => i.instance));
 * await plugins.remove(instance);
 */
export class PedalboardPlugins {
  /** @internal Use `client.device.currentPedalboard.plugins`. */
  constructor(private readonly graph: PedalboardGraph) {}

  /**
   * The plugins that are in the pedalboard now.
   *
   * Backend: none for the list itself (WebSocket state); `POST /effect/bulk/` (operationId `getPluginsBulk`) for the
   * description of the plugins whose ports are not known yet.
   * @throws {ModUiTimeoutError} when the WebSocket does not get in sync.
   * @example
   * const instances = await client.device.currentPedalboard.plugins.list();
   */
  list(): Promise<PluginInstance[]> {
    return this.graph.listInstances();
  }

  /**
   * Adds a plugin to the pedalboard and resolves once the backend confirmed it with the WebSocket `add` frame.
   *
   * The instance name is generated like the classic UI does it: the last part of the URI, made of letters, digits and
   * `_`, with `_1`, `_2`, ... added when the name is taken (`/graph/Gain`, `/graph/Gain_1`, ...).
   *
   * Backend: `GET /effect/add/{instance}?uri&x&y` (operationId `addPlugin`). The plugin starts enabled, and the
   * pedalboard is marked as modified.
   * @param plugin A {@link Plugin} (from `device.plugins.list()`), a plugin URI, or anything with a `uri`.
   * @param position Place of the block in the canvas. Default `{ x: 0, y: 0 }`.
   * @throws {ModUiError} when the backend refuses (the plugin is not installed).
   * @throws {ModUiHttpError} on HTTP errors. Note: `404` can also mean that the plugin was created but its description
   * could not be read; it then stays in the pedalboard.
   * @example
   * const created = await client.device.currentPedalboard.plugins.add(gain, { x: 200, y: 100 });
   * console.log(created.instance, created.ports.audio.input.map((port) => port.id));
   */
  add(plugin: PluginTarget, position?: Position): Promise<PluginInstance> {
    return this.graph.addPlugin(plugin, position);
  }

  /**
   * Removes a plugin and its connections, and resolves after the WebSocket `remove` frame.
   *
   * Backend: `GET /effect/remove/{instance}` (operationId `removePlugin`). The backend also drops the addressings
   * of the plugin.
   * @param instance A {@link PluginInstance} or its path (`/graph/Gain`; the leading slash is optional).
   * @throws {ModUiError} when there is no such plugin in the pedalboard, or the backend refuses.
   * @example
   * await client.device.currentPedalboard.plugins.remove('/graph/Gain');
   */
  remove(instance: string | { readonly instance: string }): Promise<void> {
    return this.graph.removePlugin(instance);
  }
}
