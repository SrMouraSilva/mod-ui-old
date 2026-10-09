# Plan: `ModUiClient` – patch parameters (strings, paths, bools, ...)

Status: **implemented** (2026-10-08), unit tests only; not yet checked against a real mod-host (see "Open items"). Builds on `2026-10-modui-client-pedalboard-graph.md` (the live graph model,
`PluginInstance`, `instance.params`, the device queue). Related to `2026-10-modui-client-plugin-gui.md` (the modgui runtime
needs the same `patch_get` / `patch_set` calls).

## Context
`instance.params` only covers the LV2 **control ports**: always a `float`, changed with the WebSocket message `param_set`.
Plugins can also have **patch parameters** (LV2 `patch:writable` / `patch:readable`): typed values that are not ports, such as
strings, file paths, URIs, booleans and integers. They use other WebSocket messages, `patch_set` and `patch_get`.

Real case from the author's own plugin, `plugins-lv2/plugins/resources/gossiper.lv2/modgui/gossiper.js`: the footswitch
labels are strings.

```js
funcs.patch_set(uri, "s", sanitized);               // write a string
footswitchLabelUris.forEach((uri) => funcs.patch_get(uri));   // ask for the current value (in the 'start' event)
// the answer arrives as event { type: 'change', uri, value }
```

The client must offer the same for any frontend that does not run the classic modgui.

## Requested API (the owner's design)
```ts
instance.patchParams.list(): PatchParam[]
instance.patchParams.get(uri): PatchParam | undefined

PatchParam { uri, label, type: 'bool' | 'int' | 'long' | 'float' | 'double' | 'string' | 'path' | 'uri', writable, readable, value }

await patchParam.refresh()        // sends patch_get and waits for the answer
await patchParam.setValue(v)      // v typed by `type` and validated: non-empty string for 's', finite number for the numeric ones, ...
```
Kept separate from `instance.params` on purpose: control ports are numbers that only write; patch parameters are typed and can
also be read with a request that has an answer.

## Findings (verified in the code, 2026-10-08)
**Description** (`GET /effect/get`, schema `PluginParameter`, already in `PluginInfo.parameters`, not typed by the client yet):
`uri`, `label`, `type` (atom URI), `readable`, `writable`, `ranges` (`minimum`, `maximum`, `default`; numbers for numeric types,
a string default for `#String`), `units`, `comment`, `shortName`, and **`fileTypes`** / `supportedExtensions` for paths (used
by `html/js/modgui.js`; they were already documented in `docs/openapi.yml`).

**Wire messages** (`mod/webserver.py` `ServerWebSocket.on_message`, `mod/session.py`, `mod/host.py`):
| Direction | Message | Behaviour |
|---|---|---|
| client -> server | `patch_set <instance> <uri> <type:char> <value...>` | parsed with `split(" ", 3)`, so the value is the rest of the line and may contain spaces. The **type char is only used for the echo**; mod-host receives `patch_set <id> <uri> "<value>"` and only `"` is escaped (`host.patch_set`). Marks the pedalboard as modified. Echoed to the **other** sockets as `patch_set <instance> <writable> <uri> <type> <value>` (`msg_callback_broadcast(..., ws)`): the sender gets no confirmation. |
| client -> server | `patch_get <instance> <uri>` | forwarded to mod-host; the plugin answers with its value. |
| server -> all | `patch_set <instance> <writable:0\|1> <uri> <type:char> <value...>` | the answer to `patch_get`, any change the plugin reports on its own, the state replay of a new socket (one frame per tracked parameter, the default value included) and snapshot / pedalboard loads. Goes to **every** socket, including the one that asked. `writable` is `1` when the host tracks the parameter, else `0`. |

**What the host tracks** (`Host.add_plugin`): only parameters with ranges and an atom type among Bool, Int, Long, Float, Double,
String, Path, URI; numeric ones whose minimum equals their maximum are skipped. Strings and paths have no range. Other types
(vectors, `chunk`, `object`) are not tracked; the classic UI sends vectors as type `v` (`"<n>-<child>-v1:v2:..."`), which is out of
scope here.

**Dangers on the backend** (the client has to prevent them):
- An unknown instance in `patch_get` raises (`mapper.get_id_without_creating`) and the socket is closed; in `patch_set` the
  parameter is simply untracked (`writable` 0) but the line is still sent to mod-host.
- The line to mod-host is text: a newline in a string would split the command; only `"` is escaped, a backslash is not.
- Format used by the classic UI to send values (`html/js/modgui.js`): bool `'1'` / `'0'`; int and long `value.toFixed(0)`; float
  and double `value.toString()`; string, path, URI as they are.

## Design

### Types
| `type` | char | atom URI | TypeScript value | Check before sending | Sent as |
|---|---|---|---|---|---|
| `bool` | `b` | `atom#Bool` | `boolean` | `typeof v === 'boolean'` | `1` / `0` |
| `int` | `i` | `atom#Int` | `number` | integer (`Number.isInteger`), inside `minimum`..`maximum` | `v.toFixed(0)` |
| `long` | `l` | `atom#Long` | `number` | same as int | `v.toFixed(0)` |
| `float` | `f` | `atom#Float` | `number` | finite, inside the range | `String(v)` |
| `double` | `g` | `atom#Double` | `number` | finite, inside the range | `String(v)` |
| `string` | `s` | `atom#String` | `string` | **non-empty**, no control characters (newline, NUL, ...) | as is |
| `path` | `p` | `atom#Path` | `string` | non-empty, no control characters; extension in `supportedExtensions` when the plugin lists them | as is |
| `uri` | `u` | `atom#URI` | `string` | non-empty, no whitespace or control characters | as is |

`PatchValue = boolean | number | string`. Parameters of other atom types are not listed by `list()` (they stay in `info.parameters`).

### Classes (`src/patch-params.ts`, plus changes in `src/pedalboard-graph.ts` and `src/graph-state.ts`)
```ts
type PatchParamType = 'bool' | 'int' | 'long' | 'float' | 'double' | 'string' | 'path' | 'uri';
type PatchValue = boolean | number | string;

class PatchParam {
  readonly owner: PluginInstance;
  readonly uri: string; readonly label: string; readonly comment: string;
  readonly type: PatchParamType;
  readonly readable: boolean; readonly writable: boolean;
  readonly default: PatchValue | undefined;            // from ranges.default, parsed by type
  readonly minimum?: number; readonly maximum?: number; // numeric types only
  readonly fileTypes: string[]; readonly supportedExtensions: string[];   // paths
  get value(): PatchValue | undefined;                 // live; undefined until a value is known
  refresh(options?: { timeoutMs?: number }): Promise<PatchValue>;
  setValue(value: PatchValue): Promise<void>;
}
class PluginPatchParams { list(): PatchParam[]; get(uri: string): PatchParam | undefined; }   // instance.patchParams
```
`list()` and `get()` are synchronous for the same reason as `instance.params`: the description is part of the instance. `value` is
a live attribute (reads memory). `refresh()` and `setValue()` are methods because they send messages.

### Model (`GraphModel`)
`ModelPlugin` gets `patches: Map<uri, string>` holding the **raw text** of the last `patch_set <instance> <writable> <uri> <type>
<value...>` frame (replay, live, answers to `patch_get`, snapshot loads). `PatchParam.value` parses it by `type` on every read
(`b`: `1` / `true`; `i` / `l`: `parseInt`; `f` / `g`: `parseFloat`; the rest as is). Frame parsing must not split the value
(`args.split(' ')` is not enough: take the first four tokens and keep the rest). `setValue()` also writes the model.

### Flows
- **`setValue(v)`**: validate `v` by type, range and `writable` (all before queueing: a rejected promise, nothing sent); then in the
  device queue: `state.ready()`, the instance must still exist (else `ModUiError`, because the backend closes the socket), send
  `patch_set <instance> <uri> <typeChar> <encoded value>`, store the value. Resolves once sent, like `Param.setValue`.
- **`refresh()`**: refuse when `readable` is false, or the instance is gone. In the queue: `state.ready()`, register
  `events.waitFor('patch_set', timeout, frame => same instance and uri)` **before** sending `patch_get <instance> <uri>`, send, and
  **leave the queue** before awaiting the answer (so a slow or silent plugin does not block loads, saves and other calls). Resolves
  with the parsed value; `ModUiTimeoutError` when the plugin never answers (default `graphTimeoutMs`, 10 s; `options.timeoutMs`
  overrides it).
- A `patch_set` received from the plugin itself or from another client only updates the model (so `value` is live).

### Errors
`ModUiError` for: wrong JS type for the `type`, empty string, control characters, number out of range or not an integer, not
`writable` (setValue) or not `readable` (refresh), plugin gone, unknown uri (`get()` returns `undefined`; calling through a stale
object rejects). `ModUiTimeoutError` for `refresh()` without an answer.

## Files to touch (when implemented)
`src/patch-params.ts` (new: `PatchParam`, `PluginPatchParams`, value encoding and checks), `src/graph-state.ts` (`patches`, frame
parsing), `src/pedalboard-graph.ts` (`PluginInstance.patchParams`, engine `setPatch`, `refreshPatch`, `InstanceOps`), `src/types.ts`
(`PluginParameterInfo`, `PatchParamType`, `PatchValue`; type `PluginInfo.parameters`), `src/index.ts` (exports and `window.ModUi`),
`test/patch-params.test.ts`, `test/helpers.ts` (a plugin fixture with a string, a path, a bool and an int parameter).
Docs: `docs/openapi.yml` (`PluginParameter.fileTypes` and `supportedExtensions`; the `patch_set` / `patch_get` rows: sender not
confirmed, answer goes to every socket, `patch_get` of an unknown instance closes the socket, newlines in values),
`docs/modui-client.md` (quick start, class diagram, limitation notes), `docs/modui-client/implementation-progress.md` (the
`/websocket` row, then run `python3 docs/modui-client/sync-progress.py`), README, `CLAUDE.md` (scope line).

## Tests
Fixture with the four parameter kinds. `list()` / `get()` from `PluginInfo.parameters`, other atom types left out, defaults parsed.
`value` from the replay frame (value with spaces, bool `1` / `true`), from live frames and from `setValue()`. `setValue()` per type:
accepted values produce the exact frame (`patch_set /graph/X <uri> s some text`, `... b 1`, `... i 3`); rejected ones (wrong JS type,
empty string, newline, NaN, non-integer for `i`, out of range, not writable, plugin gone) send nothing. `refresh()`: the waiter is
registered before the send, resolves on the matching frame only (other uri or instance ignored), also when the answer arrives before
the send returns, rejects for non-readable / gone plugins, times out (small `timeoutMs`), and does not block the device queue
(`move()` called meanwhile is sent). Frame arriving from "another client" updates `value`.

## Verification
`npm test` in `html/js/lib/modui-client`; `npx @redocly/cli lint docs/openapi.yml`; `python3 docs/modui-client/sync-progress.py --check`.
On a device or the dev server with the gossiper plugin (or any plugin with a string parameter): `setValue('Hello')`, watch the
classic UI label change; change the label in the UI and check `value`; `refresh()` returns it. **Not verifiable without a real
mod-host**, to confirm there before relying on it (see the open items).

## Implementation notes (2026-10-08)
- Files: `src/patch-params.ts` (new), `graph-state.ts` (`ModelPlugin.patches`, `patch_set` frame parsing that keeps the whole value),
  `pedalboard-graph.ts` (`PluginInstance.patchParams`, `setPatch`, `refreshPatch`, two new `InstanceOps`), `types.ts`
  (`PluginParameterInfo`, `PatchParamType`, `PatchValue`, `PluginInfo.parameters`), `index.ts`, `test/patch-params.test.ts`, fixture
  `patchInfo` in `test/helpers.ts`.
- `refresh()` resolves with `PatchValue | undefined` (`undefined` when the plugin's text does not parse for the type).
- Path extensions are compared case-insensitively and with or without a leading dot (the exact text the plugin reports was not verified).
- The docs updated: `docs/openapi.yml` (`patch_set` / `patch_get` rows), `docs/modui-client.md`, `README.rst`, `CLAUDE.md`,
  `implementation-progress.md` (+ sync script).

## Open items and questions
Decisions taken in the implementation are marked **Decided**; the others still need a device.
1. **Empty strings**: the author asked for "non-empty" for strings. For the record, an empty value can reach the backend (trailing
   space after the type) and becomes `patch_set <id> <uri> ""` for mod-host; whether plugins accept it was not checked. Keep the
   rule (non-empty) unless a plugin needs to clear a label. **Decided:** non-empty is enforced.
2. **Backslashes and quotes** in strings: only `"` is escaped for mod-host. Decide whether the client should refuse a backslash too
   or leave it to the plugin (check mod-host's parser). **Decided:** the client passes backslashes through and documents it
   (`setValue` TSDoc, `docs/modui-client.md`); control characters are refused.
3. **Bool text** reported by the plugin (`1` / `0` or `true` / `false`) and the exact text of numbers: parse leniently, confirm on a
   device.
4. **Typing**: a single `PatchParam` with a runtime-checked `PatchValue` (**decided:** single class) or a union of per-type classes
   (`StringPatchParam`, `NumberPatchParam`, ...) that makes `setValue('x')` on a number a compile error. The second is safer but
   heavier; it can be added later without changing the method names.
5. **`path` parameters** also need the Files section (`/files/list`, `/files/upload`) to choose or upload a file; out of scope here,
   already in the recommendations of `implementation-progress.md`.
6. **Vectors** (type `v`, used by the classic UI) are not listed. Add them only if a plugin needs them.
7. Where the **timeout** for `refresh()` comes from: reuse `graphTimeoutMs` (**decided**; `refresh({ timeoutMs })` overrides it per call).

## Backend change policy for this area
No backend change is planned. Candidate to ask **before** doing anything: `patch_set` / `patch_get` for an unknown instance raising
and closing the socket (the client avoids it); a confirmation frame to the sender of `patch_set`.

| Date | Change | Decision |
|------|--------|----------|
| – | `patch_set` confirmation to the sender | not asked yet |

## Revisions
- **2026-10-08** — First draft, from the author's design and the findings above.
- **2026-10-08** — Implemented; status, implementation notes and decisions on the open items added.
