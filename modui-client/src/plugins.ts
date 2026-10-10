// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The installed plugins: {@link PluginsApi} (`client.device.plugins`) and {@link Plugin}.
 * @module
 */

import { ModUiError } from './errors';
import type { HttpTransport } from './http';
import type { PluginInfo, PluginSummary } from './types';

/**
 * An installed LV2 plugin, as listed by {@link PluginsApi.list}. Lightweight: call {@link Plugin.info} for the
 * ports and the rest of the description, or pass it to `device.currentPedalboard.plugins.add()`.
 */
export class Plugin {
  readonly uri: string;
  readonly name: string;
  readonly brand: string;
  readonly label: string;
  readonly category: string[];

  /** @internal Use {@link PluginsApi.list}. */
  constructor(readonly summary: PluginSummary, private readonly api: PluginsApi) {
    this.uri = summary.uri;
    this.name = summary.name;
    this.brand = summary.brand;
    this.label = summary.label;
    this.category = summary.category;
  }

  /**
   * Reads the full description (ports, parameters, presets, ...). The answer is cached by the client.
   *
   * Backend: `GET /effect/get?uri=…` (operationId `getPlugin`).
   * @throws {ModUiHttpError} `404` when the plugin is not installed.
   * @example
   * const info = await plugin.info();
   * console.log(info.ports.audio?.input?.map((port) => port.symbol));
   */
  info(): Promise<PluginInfo> {
    return this.api.info(this.uri);
  }
}

/**
 * The plugins installed on the device (`client.device.plugins`).
 *
 * @example
 * const plugins = await client.device.plugins.list();
 * const gain = plugins.find((plugin) => plugin.label === 'Gain');
 */
export class PluginsApi {
  private readonly infos = new Map<string, PluginInfo>();

  /** @internal Use `client.device.plugins`. */
  constructor(private readonly http: HttpTransport) {}

  /**
   * Lists every installed plugin (summaries only).
   *
   * Backend: `GET /effect/list` (operationId `listPlugins`). The first call makes the server scan the LV2 plugins.
   * @example
   * const plugins = await client.device.plugins.list();
   * console.log(plugins.length, 'plugins installed');
   */
  async list(): Promise<Plugin[]> {
    const summaries = await this.http.getJson<PluginSummary[]>('/effect/list');
    return summaries.map((summary) => new Plugin(summary, this));
  }

  /** @internal Full description of one plugin, cached. */
  async info(uri: string): Promise<PluginInfo> {
    const cached = this.infos.get(uri);
    if (cached) {
      return cached;
    }
    const info = await this.http.getJson<PluginInfo>('/effect/get', { uri });
    this.infos.set(uri, info);
    return info;
  }

  /** @internal Remembers a description the backend already returned (e.g. by `GET /effect/add/…`). */
  remember(info: PluginInfo): void {
    this.infos.set(info.uri, info);
  }

  /**
   * @internal Descriptions of several plugins with one request. Unknown plugins are missing from the result
   * (the backend skips them).
   *
   * Backend: `POST /effect/bulk/` (operationId `getPluginsBulk`).
   */
  async infosOf(uris: string[]): Promise<Map<string, PluginInfo>> {
    const missing = uris.filter((uri, index) => !this.infos.has(uri) && uris.indexOf(uri) === index);
    if (missing.length > 0) {
      const found = await this.http.postJson<Record<string, PluginInfo>>('/effect/bulk/', missing);
      if (!found || typeof found !== 'object') {
        throw new ModUiError('Unexpected answer of POST /effect/bulk/');
      }
      for (const uri of Object.keys(found)) {
        this.infos.set(uri, found[uri]);
      }
    }
    const result = new Map<string, PluginInfo>();
    for (const uri of uris) {
      const info = this.infos.get(uri);
      if (info) {
        result.set(uri, info);
      }
    }
    return result;
  }
}
