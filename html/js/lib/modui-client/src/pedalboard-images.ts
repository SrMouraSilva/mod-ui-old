// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Screenshot and thumbnail of a pedalboard: {@link PedalboardImages} (`reference.images`).
 * @module
 */

import { ModUiError } from './errors';
import type { HttpTransport } from './http';
import type { ImageCheckResponse, ImageJobResponse } from './types';

/** State of the images of a pedalboard, as reported by {@link PedalboardImages.status}. */
export enum ImageStatus {
  /** The bundle has no images (never saved after a change, or never generated). The image URLs answer `404`. */
  Missing = 'missing',
  /** A generation job for this bundle is queued or running. */
  Generating = 'generating',
  /** The images exist and can be shown. */
  Available = 'available',
}

/**
 * The screenshot and the thumbnail of one pedalboard (`reference.images`).
 *
 * How mod-ui handles them (see `getPedalboardImage` in `docs/openapi.yml`):
 * - the files are `screenshot.png` and `thumbnail.png` inside the pedalboard bundle, and work for **any**
 *   pedalboard of the library, not only the running one;
 * - they are rendered by a background process from the **saved bundle** (never from the running state), when a
 *   pedalboard is saved after its graph changed or on demand with {@link PedalboardImages.generate}.
 *   Unsaved edits are not reflected;
 * - generating **replaces** the files, so it needs a writable bundle: it fails for factory pedalboards on a device.
 *
 * @example
 * const [reference] = await client.pedalboards.list();
 * img.src = reference.images.getThumbnailUrl();
 * img.onerror = async () => {
 *   if ((await reference.images.status()) === ImageStatus.Missing) {
 *     await reference.images.generate();
 *     img.src = reference.images.getThumbnailUrl();
 *   }
 * };
 */
export class PedalboardImages {
  /** Creation time of the images when known, used to bust the (one year) browser cache of the image URLs. */
  private ctime: string | null = null;

  /** @internal Use `reference.images`. */
  constructor(
    private readonly bundlepath: string,
    private readonly version: number,
    private readonly http: HttpTransport,
  ) {}

  /**
   * URL of the thumbnail (small image), ready for an `<img src>`. No request is made.
   *
   * The server caches images for a year, so the URL carries `v` (pedalboard version) and, once known (after
   * {@link PedalboardImages.status} or {@link PedalboardImages.generate} reported it), `tstamp` (creation time). Ask for the URL again after regenerating to get the new image.
   *
   * Backend: `GET /pedalboard/image/thumbnail.png?bundlepath=…` (operationId `getPedalboardImage`).
   */
  getThumbnailUrl(): string {
    return this.imageUrl('thumbnail');
  }

  /**
   * URL of the screenshot (full size image). No request is made; see {@link PedalboardImages.getThumbnailUrl}.
   *
   * Backend: `GET /pedalboard/image/screenshot.png?bundlepath=…` (operationId `getPedalboardImage`).
   */
  getScreenshotUrl(): string {
    return this.imageUrl('screenshot');
  }

  /**
   * Whether the images exist, are being generated, or are missing.
   *
   * Backend: `GET /pedalboard/image/check?bundlepath=…` (operationId `checkPedalboardImage`).
   * @example
   * if ((await reference.images.status()) === ImageStatus.Available) show(reference.images.getThumbnailUrl());
   */
  async status(): Promise<ImageStatus> {
    const response = await this.http.getJson<ImageCheckResponse>('/pedalboard/image/check', {
      bundlepath: this.bundlepath,
    });
    if (response.status === 1) {
      this.ctime = response.ctime;
      return ImageStatus.Available;
    }
    return response.status === 0 ? ImageStatus.Generating : ImageStatus.Missing;
  }

  /**
   * Waits until the generation jobs of this pedalboard are finished and tells whether the images are available.
   * Answers right away when nothing is pending. Used by {@link PedalboardImages.generate}; saving does the same
   * through {@link waitForPendingImages}.
   */
  private async waitPending(): Promise<ImageStatus> {
    const ctime = await waitForPendingImages(this.http, this.bundlepath);
    if (ctime === null) {
      return ImageStatus.Missing;
    }
    this.ctime = ctime;
    return ImageStatus.Available;
  }

  /**
   * (Re)generates the screenshot and the thumbnail from the saved bundle and resolves when they are ready.
   * The existing files are deleted when the job starts.
   *
   * It asks the backend to generate (which already answers when the job finished) and then waits for the pending
   * jobs of this pedalboard, so it resolves only when none is left. After it,
   * {@link PedalboardImages.getThumbnailUrl} returns a URL that bypasses the browser cache.
   *
   * Backend: `GET /pedalboard/image/generate?bundlepath=…` (operationId `generatePedalboardImage`), then `/wait`.
   * @throws {ModUiError} when the images could not be generated (e.g. read-only factory bundle, renderer failure).
   * @example
   * await reference.images.generate();
   * img.src = reference.images.getThumbnailUrl();
   */
  async generate(): Promise<void> {
    const job = await this.http.getJson<ImageJobResponse>('/pedalboard/image/generate', {
      bundlepath: this.bundlepath,
    });
    if (!job.ok) {
      throw new ModUiError(`The backend could not generate the images of "${this.bundlepath}"`);
    }
    if ((await this.waitPending()) !== ImageStatus.Available) {
      throw new ModUiError(`The images of "${this.bundlepath}" are not available after generating them`);
    }
  }

  private imageUrl(kind: 'thumbnail' | 'screenshot'): string {
    const query: Record<string, string | number> = { bundlepath: this.bundlepath, v: this.version };
    if (this.ctime !== null) {
      query.tstamp = this.ctime;
    }
    return this.http.url(`/pedalboard/image/${kind}.png`, query);
  }
}

/**
 * @internal Not exported from the package. Waits until the generation jobs of a bundle are finished.
 *
 * Backend: `GET /pedalboard/image/wait?bundlepath=…` (operationId `waitPedalboardImage`). It answers at once when no
 * job is queued or running.
 * @returns The creation time of the thumbnail, or `null` when there are no images (nothing was generated).
 */
export async function waitForPendingImages(http: HttpTransport, bundlepath: string): Promise<string | null> {
  const response = await http.getJson<ImageJobResponse>('/pedalboard/image/wait', { bundlepath });
  return response.ok ? response.ctime : null;
}
