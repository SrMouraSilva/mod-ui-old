# Plan: `ModUiClient` – pedalboard graph (plugins and connections)

Status: **implemented** (2026-10-07), except the items under "Separate suggestions" (`plugins.remove` and, on 2026-10-08, parameters, bypass and move were added on request). Builds on `2026-10-modui-client-pedalboard.md` (the `Device` queue,
`client.events`, `currentPedalboard`).

## Context
Live editing of the running pedalboard is documented in `docs/openapi.yml` under the tag *Pedalboard graph*. This plan covers the
part the project owner designed (plugins and connections); everything else is listed as **separate suggestions** at the end, to be
picked up later.

## Requested API (the owner's design, verbatim)
```ts
const plugins: Plugin[] = async device.plugins.list() // Listar todos os plugins

const instances: PluginInstance[] = async device.currentPedalboard.plugins.list()
const instanceCreated: PluginInstance = async device.currentPedalboard.plugins.add(plugin: Plugin, position: {x: number, y: number}?)

device.currentPedalboard.connections.list(): PedalboardConnection[] (não sei se é async)
const connection = await device.currentPedalboard.connections.connect(x, y)

await device.currentPedalboard.connections.disconnect(connection)
```
`x` and `y` are plugin ports. Wishes: validate that they are valid ports (`x` is always an output, `y` always an input, and
probably of the same type), and allow ports that are not from plugins: the pedalboard's own inputs and outputs.

Mapping to the endpoints:

| API | Endpoint (operationId) | Confirmation |
|-----|------------------------|--------------|
| `device.plugins.list()` | `GET /effect/list` (`listPlugins`); `Plugin.info()` → `GET /effect/get` (`getPlugin`) | – |
| `currentPedalboard.plugins.list()` | none: state built from the WebSocket (see below) | – |
| `currentPedalboard.plugins.add(plugin, position?)` | `GET /effect/add/{instance}?uri&x&y` (`addPlugin`) | WS `add` |
| `currentPedalboard.connections.list()` | none: WebSocket state | – |
| `currentPedalboard.connections.connect(x, y)` | `GET /effect/connect/{from},{to}` (`connectPorts`) | WS `connect` |
| `currentPedalboard.connections.disconnect(connection)` | `GET /effect/disconnect/{from},{to}` (`disconnectPorts`) | WS `disconnect` |
| `currentPedalboard.plugins.remove(instance)` (added on request) | `GET /effect/remove/{instance}` (`removePlugin`) | WS `remove` |
| `currentPedalboard.ports.list()` and `.<audio\|midi\|cv>.<input\|output>()` (needed by the "pedalboard ports" wish) | none: WS `add_hw_port` | – |

## Answers to the open design questions
- **`connections.list()` is async.** No endpoint lists the plugins or connections of the running pedalboard. The only source is the
  WebSocket state replay (`add`, `connect`, `add_hw_port`, … ending in `loading_end`) plus the live frames, so the call has to wait for
  the socket to be connected and in sync. The same holds for `currentPedalboard.plugins.list()`.
  `GET /pedalboard/info/` is not an option: it describes the **saved** bundle, not unsaved edits.
- **No change to `events.ts` is needed.** `EventChannel.on()` handlers already receive the replay frames (only `waitFor` waiters
  ignore it). An internal `GraphState` model registers its handlers **before** `events.connect()` and is fed by `add`, `remove`
  (including `:all`), `connect`, `disconnect`, `add_hw_port`, `remove_hw_port`, `loading_start` / `loading_end`.
  Limitation: with a shared socket (`options.webSocket`) the replay has already passed. See open question 1.
- **`Plugin` vs `PluginInstance`.** `Plugin` is an installed LV2 plugin (summary from `/effect/list`, `info()` returns `PluginInfo`
  from `/effect/get`, like `PedalboardReference.info()`). `PluginInstance` is a plugin in the running pedalboard: `instance`
  (`/graph/<name>`), `uri`, `x`, `y`, `bypassed`, `info`, `ports`.
- **Instance name.** The backend needs a name chosen by the caller. `plugins.add()` generates it like the classic UI does
  (`generateInstance`, `html/js/pedalboard.js`): last URI segment, `[^_a-zA-Z0-9]+` → `_`, `_` prefix if it starts with a digit,
  `/graph/cv` is reserved (`cvx`), then `_1`, `_2`, … until unused in the model.

## Ports and validation (client side, before any request)
`Port { id, symbol, type: 'audio' | 'midi' | 'cv', direction: 'input' | 'output', owner: PluginInstance | null, title }`.
- **Plugin ports** come from `PluginInfo.ports[type].input|output` (control ports are not connectable). `PluginInstance.ports`
  exposes them (`/graph/Gain/in`, …).
- **Pedalboard ports** (`owner: null`) come from `add_hw_port <port> <type> <direction> <title> <index>`. The backend's `direction`
  `0` is an *input of the device*, which is a **source** in the graph → client direction `output`; `1` → `input`. They are
  exposed as `currentPedalboard.ports` (`/graph/capture_1`, `/graph/playback_1`, `/graph/midi_merger_out`, …).
- `connect(x, y)` rejects with `ModUiError`, **without any request**, when: `x` is not an `output`; `y` is not an `input`;
  `x.type !== y.type` (the classic UI refuses different types too, `html/js/pedalboard.js`, `connect`); a port is unknown or not in
  the pedalboard; both belong to the same instance. It accepts `Port` objects. Both ends may be pedalboard ports.
- Already connected: the backend answers `true` and sends **no** `connect` frame, so the client returns the existing
  `PedalboardConnection` without waiting.

## Operation flow
- `plugins.add(plugin, position?)`: through the `Device` queue; `events.connect()`; generate the instance; register
  `events.waitFor('add', …)` **before** `GET /effect/add/…` (the frame precedes the HTTP response); `false` → cancel the waiter and
  throw `ModUiError`; return a `PluginInstance` built from the returned `PluginInfo`. Default position `{x: 0, y: 0}`.
- `connections.connect(x, y)`: validate → waiter for `connect <from> <to>` → HTTP → `false` throws → returns
  `PedalboardConnection { from, to }`.
- `connections.disconnect(connection)`: the backend **always** answers `true` and broadcasts `disconnect`, even when nothing was
  connected. The client checks the model first and throws `ModUiError` if the connection is not there; otherwise waiter → HTTP.
- Every call goes through the `Device` queue, so it never interleaves with `load()`, `reset()` or `save()`.
- A load or reset (`loading_start`, `remove :all`) clears the model; `loading_end` completes the rebuild.
- Known backend quirk: if `get_plugin_info` fails *after* mod-host created the plugin, `add` answers `404` and the plugin stays in
  the pedalboard. Documented in `docs/openapi.yml`; not fixed (backend policy).

## Decisions (owner, 2026-10-07)
1. `plugins.add()` always **generates** the instance name (no `instance` argument).
2. `connect()` **throws** on invalid pairs; it never swaps `x` and `y`.
3. Shared socket (`options.webSocket`): the snapshot is read through a short-lived second socket (the proposal; no answer
   was given, the default was used). Needs a `WebSocket` class, otherwise `ModUiError`.
4. `plugins.remove(instance)` is implemented too (it was listed as a suggestion).
5. (2026-10-08) Parameters, bypass and position are implemented, modelled with the author's PluginsManager as a reference
   (see `docs/modui-client/implementation-progress.md`):
   - `instance.params.list(): Param[]` and `instance.params.get(symbol): Param | undefined`. Synchronous: the description is
     part of the instance (`PluginInfo.ports.control.input`), so nothing is asynchronous.
   - `Param { symbol, name, default, minimum, maximum, designation, properties, value }` and `await param.setValue(v)`.
   - `await instance.isActive()`, `await instance.setActive(active)`, `await instance.toggle()` (resolves with the new state).
   - `await instance.move({ x, y })`.

## Implementation notes (differences from the draft)
- The wire interface `PedalboardConnection` of `types.ts` (a connection stored in a bundle: `source` / `target`) was renamed
  **`PedalboardInfoConnection`**, because `PedalboardConnection` is now the class of the API (`from` / `to` as `Port`).
- `loading_start` clears plugins and connections but **not** the pedalboard ports: a load does not send `add_hw_port` again
  (only a new socket does). `remove :all` behaves the same.
- `EventChannel` only got a read-only `ownsSocket` getter; the replay hook was not needed.
- New option `ModUiClientOptions.graphTimeoutMs` (default 10 000 ms): how long to wait for the confirming frame.
- `HttpTransport.postJson()` was added for `POST /effect/bulk/`.
- Plugin descriptions are cached in `PluginsApi`; `add()` stores the one the backend returns.
- `bypassed` of a `PluginInstance` follows `add` and `param_set <instance> :bypass` (value >= 0.5 = bypassed).
- `connect` between ports of the same plugin is refused (draft rule kept). Control ports are not ports of the graph.
- Ports are grouped by type and direction: `pluginInstance.ports.audio.input`, `.audio.output`, `.midi.*`, `.cv.*` (arrays; `port(symbol)` stays). `currentPedalboard.ports` has the same layout, but the lists are **functions** that return a promise (`await currentPedalboard.ports.audio.output()`), because the pedalboard's ports come from the WebSocket. Rule: an attribute is never asynchronous, a function may be. `ports.list()` stays and returns every port as one flat list (audio, MIDI, CV; sources first; by index).
- Connections whose ports cannot be resolved (plugin not installed) are left out of `connections.list()`.
- Files: `src/plugins.ts`, `src/pedalboard-plugins.ts`, `src/pedalboard-connections.ts` (also `PedalboardPorts`),
  `src/pedalboard-graph.ts` (`PluginInstance`, `Port`, `PedalboardConnection`, engine), `src/graph-state.ts`; tests
  `test/plugins.test.ts`, `test/pedalboard-graph.test.ts`. `docs/openapi.yml` documents the quirks; `docs/modui-client.md`
  has the class diagram and the flow 5.6.

### Notes on parameters, bypass and move
- All of them are WebSocket messages (`param_set <instance>/<symbol> <value>`, `param_set <instance>/:bypass <1.0|0.0>`,
  `plugin_pos <instance> <x> <y>`). The backend broadcasts them to the **other** sockets and never answers the sender, so the
  calls cannot wait for a confirmation: they resolve once the message is sent, and update the local model at once.
- The backend raises (and closes the socket) for an instance that does not exist, so the client checks the model first and
  rejects with `ModUiError` without sending. It also refuses `NaN`, values outside `minimum`..`maximum`, and the ports the host
  drives itself (designations enabled, free-wheeling, beats per bar, beats per minute, speed), which the host would ignore.
- The model keeps `values` per plugin (fed by `param_set` frames, including the replay) and `bypassed`; `x`, `y`, `Param.value`
  and `isActive()` read it live. The `bypassed` attribute of `PluginInstance` was removed in favour of `isActive()`
  (`active = !bypassed`), and `x` / `y` stopped being a snapshot (reading from the model is synchronous, so an attribute is fine).
- `setValue()` does not apply the plugin's `integer` / `toggled` / enumeration properties; it only checks the range.

## Backend change policy for this area
No backend change is planned. Candidates to **ask the user before doing** (record the answer here):

| Date | Change | Decision |
|------|--------|----------|
| 2026-10-07 | No backend change was needed or made | – |
| – | Candidate: `GET /pedalboard/graph` returning plugins + connections (removes the WebSocket-replay dependency and the shared-socket limitation) | not asked yet |
| – | Candidate: `disconnect` answering `false` when nothing was connected | not asked yet |

## Files (when implemented)
`src/plugins.ts` (`PluginsApi` = `device.plugins`, `Plugin`), `src/graph-state.ts` (internal model),
`src/pedalboard-plugins.ts` (`PedalboardPlugins`, `PluginInstance`), `src/pedalboard-connections.ts`
(`PedalboardConnections`, `PedalboardConnection`, `Port`), `src/types.ts` (wire types), `src/current-pedalboard.ts`
(`plugins`, `connections`, `ports`), `src/device.ts` (`plugins`), `src/index.ts` (exports), one test file per module,
`docs/openapi.yml` (disconnect always `true`, duplicate connect without frame, `add` 404 after create, WS-before-HTTP order,
`add_hw_port` direction), `docs/modui-client.md` (+ Mermaid class and sequence diagrams), README section, CLAUDE.md "Current scope".

## Tests
Fakes from `test/helpers.ts`. `plugins.list` maps summaries and `info()`. Instances and connections built from a replay (add +
hardware ports + connect) and updated live. `add`: WS-first and HTTP-first order, `false`, timeout, generated names (`Gain`,
`Gain_1`, `Gain_2`, digit prefix, `cv`). `connect` rejects (output→output, input→input, audio→midi, unknown port, same instance)
with no request; connect between pedalboard ports; duplicate connect; `disconnect` of an unknown connection; queue order vs `load()`;
model reset on `remove :all` / `loading_start`.

## Verification
`cd html/js/lib/modui-client && npm test`; `npx @redocly/cli lint docs/openapi.yml` (skip-rules in CLAUDE.md). Manual with
`MOD_DEV_HOST=1 MOD_DEV_ENVIRONMENT=0 python3 ./server.py`: add Gain, connect `/graph/capture_1` → Gain → `/graph/playback_1`, watch
the classic UI follow. If no server is available, report that this step was not run.

## Separate suggestions (not designed; to be included later)

| Idea | Endpoint / message | Notes |
|------|--------------------|-------|
| Patch parameters (`instance.patch...`) | WS `patch_get`, `patch_set` | LV2 patch parameters (strings, paths, ...); not control ports |
| `port.address(...)` / `unaddress()` | `POST /effect/parameter/address/{port}` (`addressParameter`), WS `hw_map` / `midi_map` / `cv_map` | belongs to a future "addressing" area with actuators (`act_add`, `hw_*`) |
| `reportParameterToHmi` | `POST /effect/parameter/set/` | internal helper of `setParam` for addressed ports; the body is a JSON string |
| `cv.addPluginPort` / `removePluginPort` | `POST /pedalboard/cv_addressing_plugin_port/{add,remove}` (`addCvPluginPort`, `removeCvPluginPort`), WS `add_cv_port` | same area as addressing |
| `device.transport.setSyncMode(mode)` | `POST /pedalboard/transport/set_sync_mode/{mode}` (`setTransportSyncMode`), WS `transport` | also listed in the pedalboard plan |
| Presets (`instance.presets…`) | `/effect/preset/*` | tag *Presets* |
| Plugin catalogue extras | `/effect/bulk/`, `/effect/get_non_cached`, images, favorites | tag *Plugins*; only `list` and `get` are used here |
| `connection.disconnect()`, filters such as `connections.for(port)` | – | convenience over the model |
| Typed events (`currentPedalboard.on('plugin-added' \| 'connected' …)`) | WS frames | almost free once the model exists |

## Revisions
- **2026-10-08 (2)** — `instance.params`, `Param.setValue`, `isActive` / `setActive` / `toggle`, `move` implemented (design by the author, PluginsManager as reference).
- **2026-10-07** — First draft.
- **2026-10-08** — Ports API simplified: `PluginInstance.ports` is `{ audio, midi, cv } x { input, output }`; `currentPedalboard.ports` follows the same pattern, with `input()` / `output()` as functions returning promises; `ports.list()` is kept.
- **2026-10-07 (2)** — Implemented (see "Decisions" and "Implementation notes"); `plugins.remove` added.
