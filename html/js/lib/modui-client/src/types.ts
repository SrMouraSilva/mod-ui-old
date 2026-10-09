// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Wire types: mirror `components/schemas` in `docs/openapi.yml`, plus small shared types.
 * @module
 */

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

/** A connection stored in a pedalboard bundle (ports like `/graph/capture_1` or `/graph/Gain/in`). */
export interface PedalboardInfoConnection {
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
  connections: PedalboardInfoConnection[];
  hardware: PedalboardHardware;
  timeInfo: PedalboardTimeInfo;
  version: number;
}

/** Answer of `GET /pedalboard/current` (schema in `docs/openapi.yml`, operationId `getCurrentPedalboard`). */
export interface CurrentPedalboardState {
  /** Absolute bundle path; empty when the running pedalboard was never saved. */
  bundlepath: string;
  /** Title; empty when untitled. */
  title: string;
  /** Changed since it was loaded or last saved. */
  modified: boolean;
}

/** Answer of `POST /pedalboard/save` (operationId `savePedalboard`). */
export interface SavePedalboardResponse {
  ok: boolean;
  /** Bundle that was written; `null` on failure. */
  bundlepath: string | null;
  /** Final title (made unique when a new bundle was created). */
  title: string;
}

/** Answer of `GET /pedalboard/image/check` (operationId `checkPedalboardImage`). */
export interface ImageCheckResponse {
  /** `-1` no thumbnail, `0` generation queued or running, `1` available. */
  status: -1 | 0 | 1;
  /** Creation time of the thumbnail (Unix seconds, one decimal) or `"0.0"`. */
  ctime: string;
}

/** Answer of `GET /pedalboard/image/generate` and `/wait` (schema `ImageJobResult`). */
export interface ImageJobResponse {
  ok: boolean;
  /** Creation time of the thumbnail (Unix seconds, one decimal), `"0.0"` on failure. */
  ctime: string;
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

/** Entry returned by `GET /effect/list` (schema `PluginSummary`). */
export interface PluginSummary {
  uri: string;
  name: string;
  brand: string;
  label: string;
  comment: string;
  /** Build environment tag (empty for non-store builds). */
  buildEnvironment: string;
  category: string[];
  microVersion: number;
  minorVersion: number;
  release: number;
  builder: number;
  /** `-1` trial, `0` non-commercial / free, `1` paid (licensed). */
  licensed: number;
  /** `0` none, `1` mono audio, `2` stereo audio, `3` instrument, `4` MIDI. */
  iotype: number;
  gui?: { resourcesDirectory?: string; screenshot?: string; thumbnail?: string };
}

/** A port of a plugin (schema `PluginPort`). */
export interface PluginPortInfo {
  valid: boolean;
  index: number;
  name: string;
  symbol: string;
  shortName?: string;
  comment?: string;
  designation?: string;
  group?: string;
  properties?: string[];
  ranges?: { minimum: number; maximum: number; default: number };
}

/** Input and output ports of one type (schema `PluginPortsByDirection`). */
export interface PluginPortsByDirection {
  input?: PluginPortInfo[];
  output?: PluginPortInfo[];
}

/** A patch parameter in a plugin description (schema `PluginParameter`). */
export interface PluginParameterInfo {
  valid?: boolean;
  readable: boolean;
  writable: boolean;
  uri: string;
  label: string;
  /** Atom type URI, e.g. `http://lv2plug.in/ns/ext/atom#String`. */
  type: string;
  /** Numbers for numeric types, empty `minimum` / `maximum` and a string `default` for `#String`; `null` or missing when none. */
  ranges?: { minimum?: number | string; maximum?: number | string; default?: number | string } | null;
  comment?: string;
  shortName?: string;
  /** Kinds of user files a path accepts (`/files/list` types). */
  fileTypes?: string[];
  /** File extensions a path accepts, as the plugin lists them. */
  supportedExtensions?: string[];
}

/** Type of a patch parameter (LV2 `patch:writable` / `patch:readable`); see {@link PatchParam}. */
export type PatchParamType = 'bool' | 'int' | 'long' | 'float' | 'double' | 'string' | 'path' | 'uri';

/** A patch parameter value: `boolean` for `bool`, `number` for the numeric types, `string` for `string`, `path` and `uri`. */
export type PatchValue = boolean | number | string;

/**
 * Full description of a plugin: `GET /effect/get` and `POST /effect/bulk/`, and the answer of `GET /effect/add/…`
 * (schema `PluginInfo`). Only the fields this client uses are typed; the server sends more.
 */
export interface PluginInfo extends PluginSummary {
  valid: boolean;
  binary: string;
  hasExternalUI: boolean;
  /** Textual version. */
  version: string;
  stability: string;
  ports: {
    audio?: PluginPortsByDirection;
    control?: PluginPortsByDirection;
    cv?: PluginPortsByDirection;
    midi?: PluginPortsByDirection;
  };
  /** Patch parameters (strings, paths, booleans, ...); use `instance.patchParams` instead of reading this. */
  parameters?: PluginParameterInfo[];
  [other: string]: unknown;
}

/** Position of a plugin block in the pedalboard canvas. */
export interface Position {
  x: number;
  y: number;
}

/** Anything {@link PedalboardPlugins.add} accepts: a plugin URI, a {@link Plugin} or a {@link PluginInfo}. */
export type PluginTarget = string | { readonly uri: string };

/** Signal type of a connectable port. Control ports are not connectable. */
export type PortType = 'audio' | 'midi' | 'cv';

/** Direction of a port, seen from the graph: an `output` is a signal source, an `input` a sink. */
export type PortDirection = 'input' | 'output';
