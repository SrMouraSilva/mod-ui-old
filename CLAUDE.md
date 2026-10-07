# CLAUDE.md

Guidance for AI assistants (and humans) working on mod-ui.

## What this project is

mod-ui is the web interface of MOD audio devices.

- **Backend**: Python 3 + Tornado 4.3 (`mod/webserver.py` routes, `mod/session.py`, `mod/host.py` talks to
  mod-host over TCP, `mod/hmi.py` talks to the hardware over serial, `modtools/utils.py` wraps the C
  library `utils/libmod_utils.so`).
- **Frontend**: classic jQuery code in `html/` (`html/js/*.js`, templates in `html/*.html` and `html/include/`).
- **API contract**: `docs/openapi.yml` documents every HTTP endpoint, every WebSocket message
  (`/websocket`, `/rpbsocket`, `/rplsocket`), the server-rendered pages and the other channels.
- **Typed client**: `html/js/lib/modui-client/` (sources in `src/`, tests in `test/`), a class-based TypeScript
  client built on `fetch` and the main WebSocket. Current scope: pedalboards (list, info, load, loadDefault, reset).
  Developer guide with diagrams: `docs/modui-client.md`.
- **Plans**: `docs/plans/` (see "Plans" below).

## Commands

```sh
# backend (development; fake audio host, no JACK needed)
pip3 install -r requirements.txt && make -C utils
MOD_DEV_HOST=1 MOD_DEV_ENVIRONMENT=0 python3 ./server.py      # http://localhost:8888/

# TypeScript client (Node.js >= 22.12)
cd html/js/lib/modui-client
npm install
npm test          # tsc --noEmit + vitest
npm run build     # writes html/js/lib/modui-client.js (generated, git-ignored)
npm run watch     # rebuild on change

# API contract
npx @redocly/cli lint docs/openapi.yml
```

## Rules

### Keep the contract and the client in sync
Whenever you **add, remove or change** an HTTP endpoint (route in `mod/webserver.py`, arguments, response shape)
or a WebSocket message (`msg_callback`/`write_message` in `mod/host.py`, `mod/session.py`, `mod/addressings.py`,
`mod/webserver.py`, or a command handled by `ServerWebSocket.on_message`):

1. Update `docs/openapi.yml` (path, parameters, schemas, and the WebSocket tables in `connectMainWebSocket`).
   It must stay valid: `npx @redocly/cli lint docs/openapi.yml`. The trailing-slash, 2XX and 4XX rules flag
   real routes, so they can be skipped
   (`--skip-rule=no-path-trailing-slash --skip-rule=operation-2xx-response --skip-rule=operation-4xx-response --skip-rule=no-unused-components`).
2. Update the client in `html/js/lib/modui-client/src/` (wire types in `types.ts`, behaviour in the area module)
   when the change affects an area the client covers (today: pedalboards). New areas are added on request and
   planned first (see "Plans").
3. Add or adjust tests in `html/js/lib/modui-client/test/` and run `npm test`.
4. Update `docs/modui-client.md` (including its Mermaid diagrams) and the README section
   "TypeScript client (modui-client)" when the API or its usage changes.

### TypeScript client conventions
- One module per concern in `src/` (`client.ts`, `pedalboards.ts`, `device.ts`, `events.ts`, `http.ts`,
  `errors.ts`, `types.ts`, `runtime.ts`); `src/index.ts` is the build entry, re-exports the public API and sets
  `window.ModUiClient` / `window.ModUi`. New areas get their own module and test file.
- Tests: one file per area in `test/`, sharing fakes from `test/helpers.ts` (`makeClient`, `connected`,
  `FakeWebSocket`, `flush`).
- The build (esbuild, IIFE, ES2018) produces a single `html/js/lib/modui-client.js` that is **never committed**.
  `index.html` loads it.
- No runtime dependencies. Dev dependencies only: `typescript`, `esbuild`, `vitest`, pinned to exact versions.
  (The repository ignores `package-lock.json`.)
- Classes per feature area, reachable from `ModUiClient`: `client.pedalboards` (library), `client.device`
  (what is running), `client.events` (raw WebSocket). Future areas follow the same shape.
- All HTTP goes through `HttpTransport` (`fetch`, `cache: 'no-store'`, non-2xx → `ModUiHttpError`).
  Inject `fetch`/`WebSocket` through `ModUiClientOptions`, never use them directly, so tests can fake them.
- Operations that the backend confirms over the WebSocket must be awaited until the confirmation arrives.
  Register `events.waitFor(...)` **before** sending the HTTP request: mod-ui often pushes the WebSocket
  message before the HTTP response. `EventChannel.connect()` swallows the initial state replay, which ends with
  `loading_end`.
- Loading a pedalboard is always `GET /reset` → `POST /pedalboard/load_bundle/` → wait for `loading_end`,
  the same sequence as the classic UI (`html/js/desktop.js`).
- A socket opened by the client answers `ping` (`pong`) and `data_ready <n>` (echo). A socket shared through
  `options.webSocket` is only listened to.
- Every public symbol has TSDoc in English: what it does, which backend calls it makes (with the OpenAPI
  `operationId`), errors thrown, and an `@example`. Write it for both developers and AI tools.

### Backend facts that are easy to get wrong
- Most handlers answer `200` with a bare `true`/`false`; `false` is a failure, not an HTTP error.
- Many state-changing endpoints use `GET` (`/effect/add/...`, `/reset`, `/snapshot/load`, ...).
- `get_argument` reads both the query string and the form body. Trailing slashes in routes matter
  (`/pedalboard/load_bundle/`, `/pedalboard/info/`).
- `POST /pedalboard/load_bundle/` does not clear the current graph; `/reset` does.

### General
- Code, comments and docs in English.
- Do not commit generated files (`html/js/lib/modui-client.js`, `node_modules/`).

## Plans

Implementation plans are saved in `docs/plans/` as Markdown, named `YYYY-MM-<topic>.md`
(e.g. `docs/plans/2026-10-modui-client.md`). Write the plan there before implementing a non-trivial change and
keep it updated with the final decisions. Plans may also list suggested future work that is not implemented yet;
check the plan before extending an area.
