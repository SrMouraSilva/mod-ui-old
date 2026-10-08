// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What runs on the device right now: {@link Device} (`client.device`).
 * @module
 */

import { CurrentPedalboard } from './current-pedalboard';
import { ModUiError } from './errors';
import type { EventChannel } from './events';
import { GraphState } from './graph-state';
import type { HttpTransport } from './http';
import { PedalboardGraph } from './pedalboard-graph';
import type { PedalboardsApi } from './pedalboards';
import type { PluginsApi } from './plugins';
import type { LoadOptions, LoadResult, PedalboardTarget } from './types';

/**
 * What runs on the device right now (`client.device`).
 *
 * Operations are serialized: a second `load()` starts only after the previous one finished, and saves made
 * through {@link Device.currentPedalboard} wait for a running load.
 *
 * Note: when another client (or the HMI) loads a pedalboard at the same moment, its `loading_end` may
 * resolve this client's wait. mod-ui gives no way to correlate them.
 */
export class Device {
  private queue: Promise<unknown> = Promise.resolve();

  /** The pedalboard that is running now: find it, save it, edit its plugins and connections. */
  readonly currentPedalboard: CurrentPedalboard;

  /** The plugins installed on the device. */
  readonly plugins: PluginsApi;

  /** @internal Use `client.device`. */
  constructor(
    private readonly http: HttpTransport,
    private readonly events: EventChannel,
    private readonly pedalboards: PedalboardsApi,
    plugins: PluginsApi,
    private readonly defaultTimeoutMs: number,
    graph: { confirmTimeoutMs: number; openSnapshotChannel: () => EventChannel | null },
  ) {
    this.plugins = plugins;
    const enqueue = <T>(task: () => Promise<T>) => this.enqueue(task);
    const state = new GraphState(events, graph.openSnapshotChannel);
    const pedalboardGraph = new PedalboardGraph(http, events, state, plugins, enqueue, graph.confirmTimeoutMs);
    this.currentPedalboard = new CurrentPedalboard(http, pedalboards, enqueue, pedalboardGraph);
  }

  /**
   * Replaces the running pedalboard and resolves once the backend finished loading it.
   *
   * Steps (same as the classic UI):
   * 1. make sure the WebSocket is connected and in sync;
   * 2. `GET /reset` — clear the current graph (operationId `resetPedalboard`);
   * 3. `POST /pedalboard/load_bundle/` with `bundlepath` (operationId `loadPedalboardBundle`);
   * 4. wait for the WebSocket `loading_end <snapshotId>`.
   *
   * @param target Bundle path, {@link PedalboardReference} or {@link PedalboardInfo}.
   * @throws {ModUiError} when the backend refuses (e.g. the bundle does not exist).
   * @throws {ModUiTimeoutError} when `loading_end` does not arrive in time.
   * @throws {ModUiHttpError} on HTTP errors.
   * @example
   * const [first] = await client.pedalboards.list();
   * const { name, snapshotId } = await client.device.load(first);
   */
  load(target: PedalboardTarget, options: LoadOptions = {}): Promise<LoadResult> {
    let bundlepath: string;
    try {
      bundlepath = bundlepathOf(target);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() => this.loadBundle(bundlepath, false, options));
  }

  /**
   * Loads the built-in empty pedalboard, shown as "Untitled".
   *
   * The bundle path is taken from `GET /pedalboard/list` (the entry whose bundle is `…/default.pedalboard`)
   * and it is loaded with `isDefault=1`, so the backend clears the current title and path.
   * @throws {ModUiError} when the list has no default pedalboard.
   * @example
   * await client.device.loadDefault();
   */
  loadDefault(options: LoadOptions = {}): Promise<LoadResult> {
    return this.enqueue(async () => {
      const references = await this.pedalboards.list();
      const reference = references.find((ref) => ref.isDefault);
      if (!reference) {
        throw new ModUiError('The backend does not list a default pedalboard');
      }
      return this.loadBundle(reference.bundlepath, true, options);
    });
  }

  /**
   * Clears the running pedalboard (all plugins, connections and addressings). The WebSocket broadcasts `remove :all`.
   *
   * Backend: `GET /reset` (operationId `resetPedalboard`).
   * @throws {ModUiError} when the backend refuses.
   */
  reset(): Promise<void> {
    return this.enqueue(() => this.resetNow());
  }

  // ------------------------------------------------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async resetNow(): Promise<void> {
    const ok = await this.http.getJson<boolean>('/reset');
    if (ok !== true) {
      throw new ModUiError('The backend refused to reset the pedalboard');
    }
  }

  private async loadBundle(bundlepath: string, isDefault: boolean, options: LoadOptions): Promise<LoadResult> {
    await this.events.connect();
    await this.resetNow();

    // The backend emits "loading_end" before answering the HTTP request: start waiting first.
    const loaded = this.events.waitFor('loading_end', options.timeoutMs ?? this.defaultTimeoutMs);
    let response: { ok: boolean; name: string };
    try {
      response = await this.http.postForm('/pedalboard/load_bundle/', {
        bundlepath,
        isDefault: isDefault ? 1 : 0,
      });
    } catch (error) {
      loaded.cancel();
      throw error;
    }
    if (!response || !response.ok) {
      loaded.cancel();
      throw new ModUiError(`The backend could not load "${bundlepath}" (does the bundle exist?)`);
    }

    const snapshotId = parseInt(await loaded.promise, 10);
    return { bundlepath, name: response.name, snapshotId: isNaN(snapshotId) ? 0 : snapshotId };
  }
}

function bundlepathOf(target: PedalboardTarget): string {
  const bundlepath = typeof target === 'string' ? target : target && target.bundlepath;
  if (typeof bundlepath !== 'string' || bundlepath === '') {
    throw new ModUiError('Expected a bundle path, a PedalboardReference or a PedalboardInfo');
  }
  return bundlepath;
}
