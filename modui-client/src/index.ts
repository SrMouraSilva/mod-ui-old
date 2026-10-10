// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * # modui-client
 *
 * Typed browser client for the mod-ui backend. It wraps the HTTP API with `fetch` and listens to the
 * main WebSocket (`/websocket`) so that long-running operations can be awaited until the backend
 * really finished them.
 *
 * - Wire contract: `docs/openapi.yml` (each public method names the `operationId` it uses).
 * - Developer guide with diagrams: `docs/modui-client.md`.
 *
 * ## Quick start
 *
 * ```ts
 * const client = new ModUiClient();                 // same origin as the page
 * const pedalboards = await client.pedalboards.list();
 * const info = await pedalboards[0].info();
 * await client.device.load(info);                   // resolves after the WebSocket "loading_end"
 * await client.device.loadDefault();                // empty "Untitled" pedalboard
 * ```
 *
 * In the classic mod-ui page the build output (`html/js/lib/modui-client.js`) is loaded with a
 * `<script>` tag and exposes `window.ModUiClient` (plus `window.ModUi` with the other classes).
 *
 * ## Modules
 *
 * | Module | Content |
 * |--------|---------|
 * | `client.ts` | {@link ModUiClient}, {@link ModUiClientOptions} — entry point, wires everything |
 * | `pedalboards.ts` | {@link PedalboardsApi} (`client.pedalboards`), {@link PedalboardReference} |
 * | `device.ts` | {@link Device} (`client.device`) — load / reset the running pedalboard |
 * | `current-pedalboard.ts` | {@link CurrentPedalboard} (`client.device.currentPedalboard`) — get / save / saveAs |
 * | `plugins.ts` | {@link PluginsApi} (`client.device.plugins`), {@link Plugin} — installed plugins |
 * | `pedalboard-plugins.ts` | {@link PedalboardPlugins} (`currentPedalboard.plugins`) — list / add / remove |
 * | `pedalboard-connections.ts` | {@link PedalboardConnections} (`currentPedalboard.connections`), {@link PedalboardPorts} (`currentPedalboard.ports.list()`, `.audio.input()` …) |
 * | `pedalboard-graph.ts` | {@link PluginInstance}, {@link Port}, {@link PedalboardConnection}, and the internal engine |
 * | `patch-params.ts` | {@link PatchParam}, {@link PluginPatchParams} (`instance.patchParams`) — strings, paths, booleans, ... |
 * | `graph-state.ts` | internal WebSocket-fed model of the running graph |
 * | `pedalboard-images.ts` | {@link PedalboardImages} (`reference.images`), {@link ImageStatus} — screenshot and thumbnail |
 * | `events.ts` | {@link EventChannel} (`client.events`) — the main WebSocket |
 * | `http.ts` | `HttpTransport` — internal `fetch` wrapper |
 * | `errors.ts` | {@link ModUiError}, {@link ModUiHttpError}, {@link ModUiTimeoutError} |
 * | `types.ts` | Wire types (`PedalboardSummary`, `PedalboardInfo`, ...) and shared option/result types |
 * | `runtime.ts` | `FetchLike`, `WebSocketLike`, `WebSocketFactory` — injectable runtime surfaces |
 *
 * @module
 */

import { ModUiClient } from './client';
import { CurrentPedalboard } from './current-pedalboard';
import { Device } from './device';
import { ModUiError, ModUiHttpError, ModUiTimeoutError } from './errors';
import { EventChannel } from './events';
import { ImageStatus, PedalboardImages } from './pedalboard-images';
import { PedalboardConnections, PedalboardPortGroup, PedalboardPorts } from './pedalboard-connections';
import { Param, PedalboardConnection, PluginInstance, PluginParams, Port } from './pedalboard-graph';
import { PatchParam, PluginPatchParams } from './patch-params';
import { PedalboardPlugins } from './pedalboard-plugins';
import { PedalboardReference, PedalboardsApi } from './pedalboards';
import { Plugin, PluginsApi } from './plugins';

export { ModUiClient } from './client';
export type { ModUiClientOptions } from './client';
export { CurrentPedalboard } from './current-pedalboard';
export { Device } from './device';
export { ModUiError, ModUiHttpError, ModUiTimeoutError } from './errors';
export { EventChannel } from './events';
export type { MessageHandler, Waiting } from './events';
export { ImageStatus, PedalboardImages } from './pedalboard-images';
export { PedalboardConnections, PedalboardPortGroup, PedalboardPorts } from './pedalboard-connections';
export { Param, PedalboardConnection, PluginInstance, PluginParams, Port } from './pedalboard-graph';
export type { PortGroups, PortsByDirection } from './pedalboard-graph';
export { PatchParam, PluginPatchParams } from './patch-params';
export { PedalboardPlugins } from './pedalboard-plugins';
export { PedalboardReference, PedalboardsApi } from './pedalboards';
export { Plugin, PluginsApi } from './plugins';
export type { FetchLike, WebSocketFactory, WebSocketLike } from './runtime';
export type * from './types';

// Browser globals: the build is an IIFE loaded with a <script> tag.
if (typeof window !== 'undefined') {
  const globals = window as unknown as Record<string, unknown>;
  globals.ModUiClient = ModUiClient;
  globals.ModUi = {
    ModUiClient,
    ModUiError,
    ModUiHttpError,
    ModUiTimeoutError,
    PedalboardReference,
    PedalboardsApi,
    PedalboardImages,
    ImageStatus,
    Device,
    CurrentPedalboard,
    EventChannel,
    Plugin,
    PluginsApi,
    PluginInstance,
    Param,
    PluginParams,
    PatchParam,
    PluginPatchParams,
    PedalboardPlugins,
    PedalboardConnection,
    PedalboardConnections,
    PedalboardPorts,
    PedalboardPortGroup,
    Port,
  };
}
