// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pedalboard library: {@link PedalboardsApi} (`client.pedalboards`) and {@link PedalboardReference}.
 * @module
 */

import { ModUiError } from './errors';
import type { HttpTransport } from './http';
import type { PedalboardInfo, PedalboardSummary } from './types';

/** Compares two bundle paths ignoring trailing slashes. */
export function sameBundle(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** True for the bundle of the built-in default pedalboard (`<pedalboards dir>/default.pedalboard`). */
function isDefaultBundle(bundlepath: string): boolean {
  return /(^|\/)default\.pedalboard\/?$/.test(bundlepath);
}

/**
 * A pedalboard of the library, as listed by {@link PedalboardsApi.list}. Lightweight: call
 * {@link PedalboardReference.info} for the full content, or pass it straight to {@link Device.load}.
 */
export class PedalboardReference {
  /** Absolute bundle path (`summary.bundle`). */
  readonly bundlepath: string;
  readonly title: string;
  readonly uri: string;
  readonly broken: boolean;
  readonly factory: boolean;
  readonly hasTrialPlugins: boolean;
  readonly version: number;

  /** @internal Use {@link PedalboardsApi.list}. */
  constructor(readonly summary: PedalboardSummary, private readonly http: HttpTransport) {
    this.bundlepath = summary.bundle;
    this.title = summary.title;
    this.uri = summary.uri;
    this.broken = summary.broken;
    this.factory = summary.factory;
    this.hasTrialPlugins = summary.hasTrialPlugins;
    this.version = summary.version;
  }

  /** True for the built-in default (empty) pedalboard. */
  get isDefault(): boolean {
    return isDefaultBundle(this.bundlepath);
  }

  /**
   * Reads the full pedalboard content.
   *
   * Backend: `GET /pedalboard/info/?bundlepath=…` (operationId `getPedalboardInfo`).
   * @example
   * const info = await reference.info();
   * console.log(info.plugins.map((p) => p.instance));
   */
  async info(): Promise<PedalboardInfo> {
    const info = await this.http.getJson<Omit<PedalboardInfo, 'bundlepath'>>('/pedalboard/info/', {
      bundlepath: this.bundlepath,
    });
    return { ...info, bundlepath: this.bundlepath };
  }

  /**
   * Deletes this pedalboard from the device (its bundle directory, and its entries in all banks).
   *
   * Only **user** pedalboards can be removed. The check is done here, before any request is sent:
   * factory pedalboards (`factory`) and the built-in default one (`isDefault`) are refused, exactly as the
   * classic UI does not offer them. The backend itself does not validate the path (see
   * `removePedalboard` in `docs/openapi.yml`).
   *
   * Removing the pedalboard that is currently running does not unload it; it keeps running with a stale path.
   *
   * Backend: `GET /pedalboard/remove/?bundlepath=…` (operationId `removePedalboard`).
   * @throws {ModUiError} when the pedalboard is a factory or default one (no request is made), or when the backend
   *   answers `false` (the bundle does not exist any more).
   * @example
   * const mine = (await client.pedalboards.list()).filter((pb) => !pb.factory && !pb.isDefault);
   * await mine[0].remove();
   */
  async remove(): Promise<void> {
    if (this.factory) {
      throw new ModUiError(`"${this.title}" is a factory pedalboard and cannot be removed`);
    }
    if (this.isDefault) {
      throw new ModUiError('The default pedalboard cannot be removed');
    }
    const ok = await this.http.getJson<boolean>('/pedalboard/remove/', { bundlepath: this.bundlepath });
    if (ok !== true) {
      throw new ModUiError(`The backend could not remove "${this.bundlepath}" (does the bundle still exist?)`);
    }
  }
}

/**
 * The pedalboard library (`client.pedalboards`).
 *
 * @example
 * const all = await client.pedalboards.list();
 * const mine = all.filter((pb) => !pb.factory && !pb.isDefault);
 */
export class PedalboardsApi {
  /** @internal Use `client.pedalboards`. */
  constructor(private readonly http: HttpTransport) {}

  /**
   * Lists user and factory pedalboards (including the default one, titled `"Default"`).
   *
   * Backend: `GET /pedalboard/list` (operationId `listPedalboards`).
   */
  async list(): Promise<PedalboardReference[]> {
    const summaries = await this.http.getJson<PedalboardSummary[]>('/pedalboard/list');
    return summaries.map((summary) => new PedalboardReference(summary, this.http));
  }
}
