// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Patch parameters of a plugin instance (`instance.patchParams`): typed values that are not LV2 control ports, such as
 * strings, file paths, URIs, booleans and integers (LV2 `patch:writable` / `patch:readable`).
 * @module
 */

import { ModUiError } from './errors';
import type { InstanceOps, PluginInstance } from './pedalboard-graph';
import type { PatchParamType, PatchValue, PluginParameterInfo } from './types';

interface TypeSpec {
  /** Type character of the WebSocket frames. */
  char: string;
  /** Atom type URI, as in `PluginInfo.parameters[].type`. */
  atom: string;
}

const ATOM = 'http://lv2plug.in/ns/ext/atom#';

const TYPES: Record<PatchParamType, TypeSpec> = {
  bool: { char: 'b', atom: ATOM + 'Bool' },
  int: { char: 'i', atom: ATOM + 'Int' },
  long: { char: 'l', atom: ATOM + 'Long' },
  float: { char: 'f', atom: ATOM + 'Float' },
  double: { char: 'g', atom: ATOM + 'Double' },
  string: { char: 's', atom: ATOM + 'String' },
  path: { char: 'p', atom: ATOM + 'Path' },
  uri: { char: 'u', atom: ATOM + 'URI' },
};

const NUMERIC: PatchParamType[] = ['int', 'long', 'float', 'double'];
const INTEGER: PatchParamType[] = ['int', 'long'];

/** Maps an atom type URI to a {@link PatchParamType}; `undefined` for the types the backend does not track (vectors, objects, ...). */
function typeOfAtom(atom: string): PatchParamType | undefined {
  return (Object.keys(TYPES) as PatchParamType[]).find((type) => TYPES[type].atom === atom);
}

/** NUL, newlines and the other control characters: a newline would split the command that mod-ui sends to mod-host. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Parses the raw text of a value as the WebSocket and mod-host report it. Lenient: a bool is `1` / `true` or `0` / `false`.
 * `undefined` when the text does not fit the type.
 */
function parseValue(type: PatchParamType, raw: string): PatchValue | undefined {
  if (type === 'bool') {
    const text = raw.trim().toLowerCase();
    return text === '1' || text === 'true' ? true : text === '0' || text === 'false' ? false : undefined;
  }
  if (INTEGER.includes(type)) {
    const value = parseInt(raw, 10);
    return isNaN(value) ? undefined : value;
  }
  if (NUMERIC.includes(type)) {
    const value = parseFloat(raw);
    return isNaN(value) ? undefined : value;
  }
  return raw;
}

/** The text the classic UI sends for a value (`html/js/modgui.js`): bool `1` / `0`, integers without decimals. */
function encodeValue(type: PatchParamType, value: PatchValue): string {
  if (type === 'bool') {
    return value ? '1' : '0';
  }
  if (INTEGER.includes(type)) {
    return (value as number).toFixed(0);
  }
  return String(value);
}

/** The value of a `patch_set <instance> <writable> <uri> <type> <value...>` frame, or `undefined` when it is malformed. */
export function patchFrameValue(args: string): string | undefined {
  const parts = args.split(' ');
  return parts.length >= 4 ? parts.slice(4).join(' ') : undefined;
}

/**
 * A patch parameter of a plugin instance: a typed value that is not a control port (a label, a sample path, a switch).
 * Get them with `instance.patchParams.list()` or `instance.patchParams.get(uri)`.
 *
 * Unlike {@link Param} (always a number, write only), a patch parameter has a {@link PatchParam.type}, can be read from the
 * plugin with {@link PatchParam.refresh} and is written with a value that fits that type.
 *
 * The description (`uri`, `label`, `type`, `minimum`, ...) never changes. {@link PatchParam.value} is read from the live state
 * each time, so it follows changes made by this client, by the classic UI, by other clients and by the plugin itself.
 */
export class PatchParam {
  readonly uri: string;
  readonly label: string;
  readonly comment: string;
  readonly type: PatchParamType;
  /** The plugin can be asked for the value ({@link PatchParam.refresh}). */
  readonly readable: boolean;
  /** The value can be changed ({@link PatchParam.setValue}). */
  readonly writable: boolean;
  /** Default value from the plugin; `undefined` when it gives none. */
  readonly default: PatchValue | undefined;
  /** Numeric types only: smallest accepted value, when the plugin says. */
  readonly minimum?: number;
  /** Numeric types only: largest accepted value, when the plugin says. */
  readonly maximum?: number;
  /** Paths only: kinds of user files the plugin accepts (`/files/list` types). */
  readonly fileTypes: string[];
  /** Paths only: extensions the plugin accepts, as it lists them (empty: any). */
  readonly supportedExtensions: string[];

  /** @internal Built by the client. */
  constructor(readonly owner: PluginInstance, info: PluginParameterInfo, type: PatchParamType, private readonly ops: InstanceOps) {
    this.uri = info.uri;
    this.label = info.label ?? '';
    this.comment = info.comment ?? '';
    this.type = type;
    this.readable = !!info.readable;
    this.writable = !!info.writable;
    this.fileTypes = info.fileTypes ?? [];
    this.supportedExtensions = info.supportedExtensions ?? [];

    const ranges = info.ranges ?? undefined;
    if (NUMERIC.includes(type)) {
      if (typeof ranges?.minimum === 'number') this.minimum = ranges.minimum;
      if (typeof ranges?.maximum === 'number') this.maximum = ranges.maximum;
    }
    const fallback = ranges?.default;
    this.default = fallback === undefined || fallback === null ? undefined : parseValue(type, String(fallback));
  }

  /**
   * The current value: the last one the backend announced (`patch_set`: state replay, snapshot loads, answers to
   * {@link PatchParam.refresh}, changes from the plugin or from other clients) or this client sent. `undefined` until a value
   * is known. Synchronous: it reads memory, it makes no request.
   */
  get value(): PatchValue | undefined {
    const raw = this.owner.liveModel().patches.get(this.uri);
    return raw === undefined ? undefined : parseValue(this.type, raw);
  }

  /**
   * Asks the plugin for the current value and resolves with it.
   *
   * The call is queued behind loads, resets and saves, but it does not hold the queue while it waits for the plugin, so a slow
   * plugin blocks nothing else. {@link PatchParam.value} is updated too.
   *
   * WebSocket: `patch_get <instance> <uri>`, answered by `patch_set <instance> <writable> <uri> <type> <value>` (see
   * `connectMainWebSocket`).
   * @param options.timeoutMs How long to wait for the plugin, in ms. Defaults to {@link ModUiClientOptions.graphTimeoutMs}.
   * @throws {ModUiError} when the parameter is not `readable` or the plugin is not in the pedalboard (the backend would close
   * the socket on `patch_get` of an unknown instance).
   * @throws {ModUiTimeoutError} when the plugin does not answer in time.
   * @example
   * const label = instance.patchParams.get('http://example.org/plugin#label')!;
   * console.log(await label.refresh());
   */
  async refresh(options: { timeoutMs?: number } = {}): Promise<PatchValue | undefined> {
    if (!this.readable) {
      throw new ModUiError(`"${this.uri}" is not readable`);
    }
    const raw = await this.ops.refreshPatch(this.owner.instance, this.uri, options.timeoutMs);
    return parseValue(this.type, raw);
  }

  /**
   * Changes the value in the plugin.
   *
   * The backend does not confirm a `patch_set` to the socket that sent it (only to the other sockets), so there is nothing
   * to wait for: the promise resolves once the message was sent and {@link PatchParam.value} already shows the new value.
   * The call is queued behind loads, resets and saves.
   *
   * Checked before anything is sent: the parameter is `writable`, the plugin is still in the pedalboard, and the value fits
   * the type — `boolean` for `bool`; an integer for `int` and `long`; a finite number for `float` and `double` (numbers inside
   * `minimum`..`maximum` when known); a non-empty string without control characters for `string`; the same for `path`, with
   * an extension from `supportedExtensions` when the plugin lists them; a non-empty string without whitespace for `uri`.
   *
   * WebSocket: `patch_set <instance> <uri> <type> <value>` (see `connectMainWebSocket`). Only `"` is escaped on the way to
   * mod-host, so a backslash in a string reaches the plugin as it is.
   * @throws {ModUiError} for a value that does not fit, a parameter that is not writable, or a plugin that is not in the pedalboard.
   * @example
   * await instance.patchParams.get('http://example.org/plugin#label')!.setValue('Verse');
   */
  setValue(value: PatchValue): Promise<void> {
    try {
      this.validate(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.ops.setPatch(this.owner.instance, this.uri, TYPES[this.type].char, encodeValue(this.type, value));
  }

  private validate(value: PatchValue): void {
    const fail = (message: string): never => {
      throw new ModUiError(`"${this.uri}" (${this.type}): ${message}`);
    };
    if (!this.writable) {
      fail('the parameter is not writable');
    }
    switch (this.type) {
      case 'bool':
        if (typeof value !== 'boolean') fail(`expected true or false, got ${String(value)}`);
        break;
      case 'int':
      case 'long':
      case 'float':
      case 'double':
        if (typeof value !== 'number' || !isFinite(value)) fail(`expected a finite number, got ${String(value)}`);
        if (INTEGER.includes(this.type) && !Number.isInteger(value)) fail(`expected an integer, got ${String(value)}`);
        if ((this.minimum !== undefined && (value as number) < this.minimum) || (this.maximum !== undefined && (value as number) > this.maximum)) {
          fail(`${String(value)} is outside the range ${this.minimum ?? -Infinity} .. ${this.maximum ?? Infinity}`);
        }
        break;
      case 'string':
      case 'path':
        if (typeof value !== 'string' || value === '') fail('expected a non-empty string');
        if (CONTROL.test(value as string)) fail('the string has control characters (newline, NUL, ...)');
        if (this.type === 'path' && !this.hasSupportedExtension(value as string)) {
          fail(`the file extension must be one of: ${this.supportedExtensions.join(', ')}`);
        }
        break;
      case 'uri':
        if (typeof value !== 'string' || value === '') fail('expected a non-empty URI');
        if (CONTROL.test(value as string) || /\s/.test(value as string)) fail('a URI cannot have whitespace or control characters');
        break;
    }
  }

  private hasSupportedExtension(path: string): boolean {
    if (this.supportedExtensions.length === 0) {
      return true;
    }
    const dot = path.lastIndexOf('.');
    const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
    return this.supportedExtensions.some((item) => item.replace(/^\./, '').toLowerCase() === extension);
  }
}

/** The patch parameters of a plugin instance (`instance.patchParams`). */
export class PluginPatchParams {
  private readonly items: PatchParam[] = [];

  /** @internal Built by the client. */
  constructor(owner: PluginInstance, parameters: PluginParameterInfo[], ops: InstanceOps) {
    for (const info of parameters) {
      const type = typeOfAtom(info.type);
      if (type !== undefined && info.uri) {
        this.items.push(new PatchParam(owner, info, type, ops));
      }
    }
  }

  /**
   * Every patch parameter of a type this client handles (bool, int, long, float, double, string, path, uri), in the order of
   * the plugin. Synchronous: the description is already known when the instance exists. Parameters of other atom types
   * (vectors, objects) stay in `instance.info.parameters`. Empty when the plugin is not installed.
   * @example
   * for (const param of instance.patchParams.list()) console.log(param.uri, param.type, param.value);
   */
  list(): PatchParam[] {
    return [...this.items];
  }

  /**
   * Finds a patch parameter by URI.
   * @example
   * await instance.patchParams.get('http://example.org/plugin#label')?.setValue('Chorus');
   */
  get(uri: string): PatchParam | undefined {
    return this.items.find((param) => param.uri === uri);
  }
}
