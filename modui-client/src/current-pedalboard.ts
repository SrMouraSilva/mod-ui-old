// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pedalboard that is running on the device: {@link CurrentPedalboard} (`client.device.currentPedalboard`).
 * @module
 */

import { ModUiError } from './errors';
import type { HttpTransport } from './http';
import { waitForPendingImages } from './pedalboard-images';
import { PedalboardConnections, PedalboardPorts } from './pedalboard-connections';
import type { Enqueue, PedalboardGraph } from './pedalboard-graph';
import { PedalboardPlugins } from './pedalboard-plugins';
import { sameBundle } from './pedalboards';
import type { PedalboardReference, PedalboardsApi } from './pedalboards';
import type { CurrentPedalboardState, SavePedalboardResponse } from './types';

/**
 * The pedalboard running on the device right now (`client.device.currentPedalboard`).
 *
 * It knows how to find out which pedalboard that is ({@link CurrentPedalboard.get}) and how to persist it
 * ({@link CurrentPedalboard.save}, {@link CurrentPedalboard.saveAs}). Operations are queued behind
 * `device.load()` / `device.reset()`, so they never run in the middle of a load.
 *
 * Notes:
 * - The classic UI keeps its own copy of the title and path (taken from its own HTTP responses). It is not
 *   updated when the client saves.
 * - The running pedalboard becomes the saved bundle after a save, so later `save()` calls overwrite it.
 *
 * @example
 * const device = client.device;
 * const current = await device.currentPedalboard.get();       // PedalboardReference | null
 * await device.currentPedalboard.save();                       // overwrite, keep the title
 * await device.currentPedalboard.save('Renamed');              // overwrite and rename
 * const copy = await device.currentPedalboard.saveAs('Solo');  // new bundle, "Solo (2)" if "Solo" exists
 */
export class CurrentPedalboard {
  /** The plugins in the pedalboard: list, add, remove. */
  readonly plugins: PedalboardPlugins;
  /** The connections between plugin ports and pedalboard ports: list, connect, disconnect. */
  readonly connections: PedalboardConnections;
  /** The inputs and outputs of the pedalboard itself, to connect plugins to. */
  readonly ports: PedalboardPorts;

  /** @internal Use `client.device.currentPedalboard`. */
  constructor(
    private readonly http: HttpTransport,
    private readonly pedalboards: PedalboardsApi,
    private readonly enqueue: Enqueue,
    graph: PedalboardGraph,
  ) {
    this.plugins = new PedalboardPlugins(graph);
    this.connections = new PedalboardConnections(graph);
    this.ports = new PedalboardPorts(graph);
  }

  /**
   * The library entry of the running pedalboard, or `null` when it is untitled (after `device.reset()`, after
   * `device.loadDefault()`, or a pedalboard that was never saved): such a pedalboard has no bundle yet.
   *
   * Backend: `GET /pedalboard/current` (operationId `getCurrentPedalboard`) and `GET /pedalboard/list`.
   * @throws {ModUiError} when the running bundle is not in the pedalboard list.
   * @example
   * const current = await client.device.currentPedalboard.get();
   * if (current) console.log(current.title, current.bundlepath);
   */
  get(): Promise<PedalboardReference | null> {
    return this.enqueue(async () => {
      const state = await this.readState();
      if (!state.bundlepath) {
        return null;
      }
      return this.findInLibrary(state.bundlepath);
    });
  }

  /**
   * Saves the running pedalboard **over its own bundle** ("Save").
   *
   * @param newTitle Title to store. When omitted, the current title of the pedalboard is read from the backend and
   *   kept. When given, the pedalboard is renamed.
   *
   * Special cases decided by the backend (see `savePedalboard` in `docs/openapi.yml`):
   * - a **factory** pedalboard is never modified: the result is a copy in the user's directory;
   * - a pedalboard that has no bundle yet (untitled) is saved as a **new** bundle, which needs a title.
   *
   * Backend: `GET /pedalboard/current` (only when `newTitle` is omitted), `POST /pedalboard/save` with `asNew=0`,
   * `GET /pedalboard/list` to build the result, and `GET /pedalboard/image/wait` so the promise resolves only after
   * the thumbnail and the screenshot (regenerated in the background when the graph changed) are ready.
   * @returns The saved pedalboard (its `bundlepath` can differ from the previous one, see above).
   * @throws {ModUiError} when no title is given and the pedalboard is untitled, when the title is blank, or when
   *   the backend fails to save.
   * @example
   * await client.device.currentPedalboard.save();
   * await client.device.currentPedalboard.save('New name');
   */
  save(newTitle?: string): Promise<PedalboardReference> {
    if (newTitle !== undefined && !isValidTitle(newTitle)) {
      return Promise.reject(blankTitleError());
    }
    return this.enqueue(async () => {
      let title = newTitle;
      if (title === undefined) {
        title = (await this.readState()).title;
        if (!title.trim()) {
          throw new ModUiError(
            'The running pedalboard has no title yet: pass a title to save() or use saveAs(title)',
          );
        }
      }
      return this.persist(title, false);
    });
  }

  /**
   * Saves the running pedalboard as a **new** pedalboard ("Save as"). The previous bundle is left untouched, and the
   * running pedalboard becomes the new one.
   *
   * @param suggestedTitle Wished title. The backend makes it unique among the user's pedalboards: if
   *   `"Solo"` exists the result is titled `"Solo (2)"`. Read the real title from the returned reference.
   *
   * Backend: `POST /pedalboard/save` with `asNew=1` (operationId `savePedalboard`), `GET /pedalboard/list`, and
   * `GET /pedalboard/image/wait` (the promise resolves only after the images of the new pedalboard are ready).
   * @returns The new pedalboard.
   * @throws {ModUiError} when the title is blank or the backend fails to save.
   * @example
   * const copy = await client.device.currentPedalboard.saveAs('Solo');
   * console.log(copy.title); // "Solo", or "Solo (2)" when taken
   */
  saveAs(suggestedTitle: string): Promise<PedalboardReference> {
    if (!isValidTitle(suggestedTitle)) {
      return Promise.reject(blankTitleError());
    }
    return this.enqueue(() => this.persist(suggestedTitle, true));
  }

  // ------------------------------------------------------------------------------------------------------------------

  private readState(): Promise<CurrentPedalboardState> {
    return this.http.getJson<CurrentPedalboardState>('/pedalboard/current');
  }

  private async findInLibrary(bundlepath: string): Promise<PedalboardReference> {
    const references = await this.pedalboards.list();
    const reference = references.find((ref) => sameBundle(ref.bundlepath, bundlepath));
    if (!reference) {
      throw new ModUiError(`The pedalboard "${bundlepath}" is not in the pedalboard list`);
    }
    return reference;
  }

  private async persist(title: string, asNew: boolean): Promise<PedalboardReference> {
    const response = await this.http.postForm<SavePedalboardResponse>('/pedalboard/save', {
      title,
      asNew: asNew ? 1 : 0,
    });
    if (!response || !response.ok || !response.bundlepath) {
      throw new ModUiError(`The backend failed to save the pedalboard "${title}"`);
    }
    const reference = await this.findInLibrary(response.bundlepath);
    await this.waitForImages(reference.bundlepath);
    return reference;
  }

  /**
   * A save regenerates the screenshot and the thumbnail in the background when the graph changed; wait for it so
   * the saved pedalboard is complete when the promise resolves. The pedalboard is already saved at this point, so a
   * failure of this wait (or of the rendering itself) must not make the save look failed: it is ignored.
   */
  private async waitForImages(bundlepath: string): Promise<void> {
    try {
      await waitForPendingImages(this.http, bundlepath);
    } catch {
      // best effort, see above
    }
  }
}

function isValidTitle(title: string): boolean {
  return typeof title === 'string' && title.trim() !== '';
}

function blankTitleError(): ModUiError {
  return new ModUiError('The pedalboard title must be a non-empty string');
}
