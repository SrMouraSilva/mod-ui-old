// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pedalboard library: {@link PedalboardsApi} (`client.pedalboards`) and {@link PedalboardReference}.
 * @module
 */

import type { HttpTransport } from './http';
import type { PedalboardInfo, PedalboardSummary } from './types';

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
