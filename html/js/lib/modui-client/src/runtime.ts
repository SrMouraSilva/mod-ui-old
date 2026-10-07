// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pluggable runtime: the minimal `fetch` / `WebSocket` surfaces the client needs, so it runs in browsers,
 * Node and tests (where fakes are injected).
 * @module
 */

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
