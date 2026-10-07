// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * # modui-client
 *
 * Typed browser client for the mod-ui backend. It wraps the HTTP API with `fetch` and listens to the
 * main WebSocket (`/websocket`) so that long-running operations can be awaited until the backend
 * really finished them.
 *
 * The wire contract (every endpoint and every WebSocket message) is described in `docs/openapi.yml`.
 * Each public method below names the OpenAPI `operationId` it relies on.
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
 * ## Architecture
 *
 * - {@link ModUiClient} — entry point, owns the transports and the feature areas.
 * - {@link PedalboardsApi} (`client.pedalboards`) — the pedalboard library.
 * - {@link Device} (`client.device`) — what is running on the device right now.
 * - {@link EventChannel} (`client.events`) — the main WebSocket: raw message subscription and waiting.
 * - Errors: {@link ModUiError}, {@link ModUiHttpError}, {@link ModUiTimeoutError}.
 *
 * ## WebSocket notes
 *
 * - WebSocket frames are plain text: `"<command> <args...>"` (see `connectMainWebSocket` in `docs/openapi.yml`).
 * - A new socket first receives a replay of the whole current state, which ends with `loading_end`.
 *   {@link EventChannel.connect} resolves only after that replay, so later `loading_end` messages always
 *   belong to new operations.
 * - A socket opened by this client answers `ping` and `data_ready` itself (mod-host flow control).
 *   When an existing socket is passed through {@link ModUiClientOptions.webSocket} (e.g. the page's `ws`
 *   from `host.js`), the owner keeps answering and this client only listens.
 */

// =====================================================================================================================
// Wire types (mirror `components/schemas` in docs/openapi.yml)
// =====================================================================================================================

/** Entry returned by `GET /pedalboard/list` (schema `PedalboardSummary`). */
export interface PedalboardSummary {
  /** The pedalboard uses plugins that are not installed. */
  broken: boolean;
  /** Factory pedalboard (read-only, shipped with the device). */
  factory: boolean;
  /** The pedalboard uses trial (unlicensed) plugins. */
  hasTrialPlugins: boolean;
  /** LV2 URI of the pedalboard. */
  uri: string;
  /** Absolute path of the `.pedalboard` bundle directory. */
  bundle: string;
  /** Display title. The default pedalboard is always reported as `"Default"`. */
  title: string;
  /** Incremented on every save; useful as a cache buster. */
  version: number;
}

/** MIDI CC assignment stored in a pedalboard (schema `MidiControl`). `channel` is `-1` when unmapped. */
export interface MidiControl {
  channel: number;
  control: number;
  hasRanges: boolean;
  minimum: number;
  maximum: number;
}

/** A control port value stored in a pedalboard. */
export interface PedalboardPluginPort {
  valid: boolean;
  symbol: string;
  value: number;
  midiCC: MidiControl;
}

/** A plugin instance stored in a pedalboard. */
export interface PedalboardPlugin {
  valid: boolean;
  bypassed: boolean;
  instanceNumber: number;
  /** Instance path, e.g. `/graph/Gain`. */
  instance: string;
  /** Plugin LV2 URI. */
  uri: string;
  bypassCC: MidiControl;
  x: number;
  y: number;
  ports: PedalboardPluginPort[];
  /** Preset URI, empty when none. */
  preset: string;
}

/** A connection stored in a pedalboard (ports like `/graph/capture_1` or `/graph/Gain/in`). */
export interface PedalboardConnection {
  valid: boolean;
  source: string;
  target: string;
}

/** A hardware MIDI port referenced by a pedalboard. */
export interface PedalboardHardwareMidiPort {
  valid: boolean;
  symbol: string;
  name: string;
}

/** Hardware ports a pedalboard expects. */
export interface PedalboardHardware {
  audio_ins: number;
  audio_outs: number;
  cv_ins: number;
  cv_outs: number;
  midi_ins: PedalboardHardwareMidiPort[];
  midi_outs: PedalboardHardwareMidiPort[];
  serial_midi_in: boolean;
  serial_midi_out: boolean;
  midi_merger_out: boolean;
  midi_broadcaster_in: boolean;
}

/** Transport settings stored in a pedalboard. `available` is a bit mask: 1 = BPB, 2 = BPM, 4 = rolling. */
export interface PedalboardTimeInfo {
  available: number;
  bpb: number;
  bpbCC: MidiControl;
  bpm: number;
  bpmCC: MidiControl;
  rolling: boolean;
  rollingCC: MidiControl;
}

/**
 * Full content of a pedalboard bundle: `GET /pedalboard/info/` (schema `PedalboardInfo`)
 * plus {@link PedalboardInfo.bundlepath}, which the server does not return and this client adds.
 *
 * Can be passed directly to {@link Device.load}.
 */
export interface PedalboardInfo {
  /** Absolute bundle path this info was read from (added by the client). */
  bundlepath: string;
  title: string;
  width: number;
  height: number;
  factory: boolean;
  midi_separated_mode: boolean;
  midi_loopback: boolean;
  plugins: PedalboardPlugin[];
  connections: PedalboardConnection[];
  hardware: PedalboardHardware;
  timeInfo: PedalboardTimeInfo;
  version: number;
}

/** Anything {@link Device.load} accepts: a bundle path, a {@link PedalboardReference} or a {@link PedalboardInfo}. */
export type PedalboardTarget = string | { readonly bundlepath: string };

/** Result of {@link Device.load} and {@link Device.loadDefault}. */
export interface LoadResult {
  /** Bundle that was loaded. */
  bundlepath: string;
  /** Title reported by the backend (empty for the default pedalboard, which is shown as "Untitled"). */
  name: string;
  /** Snapshot active after loading (argument of the WebSocket `loading_end`). */
  snapshotId: number;
}

/** Per-call options of {@link Device.load} and {@link Device.loadDefault}. */
export interface LoadOptions {
  /** Maximum time to wait for the WebSocket `loading_end`, in ms. Defaults to {@link ModUiClientOptions.loadTimeoutMs}. */
  timeoutMs?: number;
}

// =====================================================================================================================
// Pluggable runtime (lets the client run in browsers, Node and tests)
// =====================================================================================================================

/** Minimal `fetch` signature used by the client. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Minimal WebSocket surface used by the client. The browser `WebSocket` satisfies it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

/** Constructor of {@link WebSocketLike} objects (the browser `WebSocket` class satisfies it). */
export type WebSocketFactory = new (url: string) => WebSocketLike;

/** Options of {@link ModUiClient}. All are optional in a mod-ui page. */
export interface ModUiClientOptions {
  /**
   * Origin of the mod-ui server, e.g. `"http://modduo.local"`. Defaults to `location.origin`.
   * The WebSocket URL is derived from it (`http` → `ws`, `https` → `wss`).
   */
  baseUrl?: string;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** WebSocket class used to open the client's own socket. Defaults to the global `WebSocket`. */
  WebSocket?: WebSocketFactory;
  /**
   * Reuse an already open socket instead of opening a new one (in the classic UI: `window.ws`).
   * The client then never answers `ping`/`data_ready` and never closes it.
   */
  webSocket?: WebSocketLike;
  /** Default timeout for pedalboard loads, in ms. Default: 60000. */
  loadTimeoutMs?: number;
  /** Timeout for opening the WebSocket and receiving the initial state replay, in ms. Default: 30000. */
  connectTimeoutMs?: number;
}

// =====================================================================================================================
// Errors
// =====================================================================================================================

/** Base class of every error thrown by this client. */
export class ModUiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModUiError';
  }
}

/** The server answered with a non-2xx HTTP status. */
export class ModUiHttpError extends ModUiError {
  /**
   * @param status HTTP status code.
   * @param url Requested URL.
   * @param body Raw response body (Tornado error pages are HTML).
   */
  constructor(readonly status: number, readonly url: string, readonly body: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'ModUiHttpError';
  }
}

/** An awaited WebSocket message did not arrive in time. */
export class ModUiTimeoutError extends ModUiError {
  constructor(message: string) {
    super(message);
    this.name = 'ModUiTimeoutError';
  }
}

// =====================================================================================================================
// HTTP transport (internal)
// =====================================================================================================================

type Query = Record<string, string | number | boolean>;

/** Thin `fetch` wrapper: builds URLs, decodes JSON and turns non-2xx answers into {@link ModUiHttpError}. */
class HttpTransport {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: FetchLike) {}

  /** `GET path?query`, decoded as JSON. */
  getJson<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>(this.url(path, query), { method: 'GET' });
  }

  /** `POST path` with an `application/x-www-form-urlencoded` body, decoded as JSON. */
  postForm<T>(path: string, form: Query): Promise<T> {
    return this.request<T>(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: toSearchParams(form).toString(),
    });
  }

  private url(path: string, query?: Query): string {
    const search = query ? toSearchParams(query).toString() : '';
    return this.baseUrl + path + (search ? '?' + search : '');
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    // The backend sends no cache headers for these endpoints; never let the browser reuse an answer.
    const response = await this.fetchImpl(url, { ...init, cache: 'no-store' });
    const text = await response.text();
    if (!response.ok) {
      throw new ModUiHttpError(response.status, url, text);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function toSearchParams(values: Query): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(values)) {
    params.append(key, String(values[key]));
  }
  return params;
}

// =====================================================================================================================
// WebSocket channel
// =====================================================================================================================

/** Handler of a WebSocket message: `args` is everything after the command (empty string when none). */
export type MessageHandler = (args: string, command: string) => void;

/** Handle returned by {@link EventChannel.waitFor}. */
export interface Waiting {
  /** Resolves with the message arguments, rejects on timeout, `stop` or socket close. */
  promise: Promise<string>;
  /** Stops waiting; the promise then never settles. */
  cancel(): void;
}

interface Waiter {
  command: string;
  predicate: (args: string) => boolean;
  resolve(args: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * The main WebSocket (`/websocket`, operationId `connectMainWebSocket`).
 *
 * Available as `client.events`. Feature areas use it to await backend confirmations; applications can use
 * {@link EventChannel.on} to observe raw messages (`param_set`, `transport`, `stats`, ...).
 *
 * @example
 * const off = client.events.on('stats', (args) => {
 *   const [cpuLoad, xruns] = args.split(' ');
 *   console.log(`CPU ${cpuLoad}% / ${xruns} xruns`);
 * });
 * await client.connect();
 * // later: off();
 */
export class EventChannel {
  private socket: WebSocketLike | null = null;
  private connecting: Promise<void> | null = null;
  private synced = false;
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private readonly waiters = new Set<Waiter>();
  private readonly owned: boolean;

  /**
   * @param url WebSocket URL (`ws://host/websocket`).
   * @param factory Class used to open the client's own socket.
   * @param shared Existing socket to reuse instead (see {@link ModUiClientOptions.webSocket}).
   * @param connectTimeoutMs Timeout for {@link EventChannel.connect}.
   */
  constructor(
    private readonly url: string,
    private readonly factory: WebSocketFactory | undefined,
    private readonly shared: WebSocketLike | undefined,
    private readonly connectTimeoutMs: number,
  ) {
    this.owned = shared === undefined;
  }

  /** True when the socket is open and the initial state replay has been received. */
  get connected(): boolean {
    return this.synced && this.socket !== null && this.socket.readyState === WS_OPEN;
  }

  /**
   * Opens the socket (once) and resolves when the client is in sync with the backend.
   *
   * - Own socket: resolves after the initial state replay (first `loading_end`).
   * - Shared socket: resolves as soon as it is open (its owner already handled the replay).
   *
   * Safe to call many times; feature methods call it for you.
   * @throws {ModUiTimeoutError} when the backend does not answer within `connectTimeoutMs`.
   */
  connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = (this.owned ? this.openOwnSocket() : this.attachSharedSocket()).then(
        () => {
          this.synced = true;
        },
        (error) => {
          this.connecting = null;
          throw error;
        },
      );
    }
    return this.connecting;
  }

  /**
   * Subscribes to a WebSocket command (`'*'` receives every message).
   * Does not open the socket by itself; call {@link EventChannel.connect} (or any feature method).
   * @returns A function that removes the subscription.
   */
  on(command: string, handler: MessageHandler): () => void {
    let set = this.handlers.get(command);
    if (!set) {
      set = new Set();
      this.handlers.set(command, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /**
   * Waits for the next message `command` whose arguments satisfy `predicate`.
   * Register the wait **before** triggering the action that produces the message: mod-ui often pushes
   * WebSocket messages before the HTTP response of the request that caused them.
   */
  waitFor(command: string, timeoutMs: number, predicate: (args: string) => boolean = () => true): Waiting {
    let waiter!: Waiter;
    const promise = new Promise<string>((resolve, reject) => {
      waiter = {
        command,
        predicate,
        resolve: (args) => {
          this.removeWaiter(waiter);
          resolve(args);
        },
        reject: (error) => {
          this.removeWaiter(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          waiter.reject(new ModUiTimeoutError(`No "${command}" message within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
    // Avoid "unhandled rejection" noise while the caller is still awaiting something else.
    promise.catch(() => undefined);
    return { promise, cancel: () => this.removeWaiter(waiter) };
  }

  /** Sends a raw text frame. The socket must be connected. */
  send(text: string): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      throw new ModUiError('WebSocket is not connected');
    }
    this.socket.send(text);
  }

  /** Detaches from the socket; closes it only if this client opened it. Pending waits are rejected. */
  close(): void {
    const socket = this.socket;
    this.detach();
    this.failWaiters(new ModUiError('Client closed'));
    if (socket && this.owned) {
      socket.close();
    }
  }

  // ------------------------------------------------------------------------------------------------------------------

  private openOwnSocket(): Promise<void> {
    if (!this.factory) {
      return Promise.reject(new ModUiError('No WebSocket implementation available; pass options.WebSocket'));
    }
    const socket = new this.factory(this.url);
    this.attach(socket);
    // The initial state replay always ends with "loading_end".
    const replay = this.waitFor('loading_end', this.connectTimeoutMs);
    return replay.promise.then(
      () => undefined,
      (error) => {
        this.detach();
        socket.close();
        throw error;
      },
    );
  }

  private attachSharedSocket(): Promise<void> {
    const socket = this.shared!;
    this.attach(socket);
    if (socket.readyState === WS_OPEN) {
      return Promise.resolve();
    }
    if (socket.readyState !== WS_CONNECTING) {
      this.detach();
      return Promise.reject(new ModUiError('The shared WebSocket is closed'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener('open', onOpen);
        this.detach();
        reject(new ModUiTimeoutError(`Shared WebSocket not open within ${this.connectTimeoutMs} ms`));
      }, this.connectTimeoutMs);
      const onOpen = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        resolve();
      };
      socket.addEventListener('open', onOpen);
    });
  }

  private attach(socket: WebSocketLike): void {
    this.socket = socket;
    socket.addEventListener('message', this.onMessage);
    socket.addEventListener('close', this.onClose);
  }

  private detach(): void {
    if (this.socket) {
      this.socket.removeEventListener('message', this.onMessage);
      this.socket.removeEventListener('close', this.onClose);
    }
    this.socket = null;
    this.connecting = null;
    this.synced = false;
  }

  private readonly onMessage = (event: { data?: unknown }): void => {
    if (typeof event.data !== 'string') {
      return;
    }
    const space = event.data.indexOf(' ');
    const command = space < 0 ? event.data : event.data.slice(0, space);
    const args = space < 0 ? '' : event.data.slice(space + 1);

    if (this.owned) {
      if (command === 'ping') {
        this.socket?.send('pong');
      } else if (command === 'data_ready') {
        // Flow control: mod-host stays silent until the counter is echoed back.
        this.socket?.send('data_ready ' + args);
      }
    }

    for (const key of [command, '*']) {
      const set = this.handlers.get(key);
      if (set) {
        for (const handler of Array.from(set)) {
          handler(args, command);
        }
      }
    }

    if (command === 'stop') {
      this.failWaiters(new ModUiError('The backend stopped (audio host restarted or UI disconnected)'));
      return;
    }
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.command === command && waiter.predicate(args)) {
        waiter.resolve(args);
      }
    }
  };

  private readonly onClose = (): void => {
    this.detach();
    this.failWaiters(new ModUiError('WebSocket closed'));
  };

  private removeWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter);
  }

  private failWaiters(error: Error): void {
    for (const waiter of Array.from(this.waiters)) {
      waiter.reject(error);
    }
  }
}

// =====================================================================================================================
// Pedalboards
// =====================================================================================================================

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

// =====================================================================================================================
// Device
// =====================================================================================================================

/**
 * What runs on the device right now (`client.device`).
 *
 * Operations are serialized: a second `load()` starts only after the previous one finished.
 *
 * Note: when another client (or the HMI) loads a pedalboard at the same moment, its `loading_end` may
 * resolve this client's wait. mod-ui gives no way to correlate them.
 */
export class Device {
  private queue: Promise<unknown> = Promise.resolve();

  /** @internal Use `client.device`. */
  constructor(
    private readonly http: HttpTransport,
    private readonly events: EventChannel,
    private readonly pedalboards: PedalboardsApi,
    private readonly defaultTimeoutMs: number,
  ) {}

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
    const bundlepath = bundlepathOf(target);
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

// =====================================================================================================================
// Client
// =====================================================================================================================

/**
 * Entry point of the mod-ui client.
 *
 * @example
 * // In a mod-ui page (same origin)
 * const client = new ModUiClient();
 *
 * // From another origin / Node (Node 22+ has global fetch and WebSocket)
 * const remote = new ModUiClient({ baseUrl: 'http://modduo.local' });
 *
 * // Inside the classic UI, sharing its socket instead of opening a second one
 * const shared = new ModUiClient({ webSocket: window.ws });
 */
export class ModUiClient {
  /** Server origin used for every request, without trailing slash. */
  readonly baseUrl: string;
  /** The running pedalboard. */
  readonly device: Device;
  /** The pedalboard library. */
  readonly pedalboards: PedalboardsApi;
  /** Main WebSocket: raw subscriptions and waits. */
  readonly events: EventChannel;

  constructor(options: ModUiClientOptions = {}) {
    const origin = options.baseUrl ?? (typeof location !== 'undefined' ? location.origin : undefined);
    if (!origin) {
      throw new ModUiError('options.baseUrl is required outside a browser page');
    }
    this.baseUrl = origin.replace(/\/+$/, '');

    const fetchImpl = options.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
    if (!fetchImpl) {
      throw new ModUiError('No fetch implementation available; pass options.fetch');
    }
    const factory =
      options.WebSocket ?? (typeof WebSocket !== 'undefined' ? (WebSocket as unknown as WebSocketFactory) : undefined);

    const http = new HttpTransport(this.baseUrl, fetchImpl);
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/websocket';
    this.events = new EventChannel(wsUrl, factory, options.webSocket, options.connectTimeoutMs ?? 30000);
    this.pedalboards = new PedalboardsApi(http);
    this.device = new Device(http, this.events, this.pedalboards, options.loadTimeoutMs ?? 60000);
  }

  /** Connects the WebSocket ahead of time (feature methods do it on demand). See {@link EventChannel.connect}. */
  connect(): Promise<void> {
    return this.events.connect();
  }

  /** Releases the WebSocket (closes it if the client opened it). */
  close(): void {
    this.events.close();
  }
}

// =====================================================================================================================
// Browser globals (the build is an IIFE loaded with a <script> tag)
// =====================================================================================================================

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
    Device,
    EventChannel,
  };
}
