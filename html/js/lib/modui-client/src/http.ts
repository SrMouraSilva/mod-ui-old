// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HTTP transport (internal): every request of the client goes through {@link HttpTransport}.
 * @module
 */

import { ModUiHttpError } from './errors';
import type { FetchLike } from './runtime';

/** Query string or form values. */
export type Query = Record<string, string | number | boolean>;

/** Thin `fetch` wrapper: builds URLs, decodes JSON and turns non-2xx answers into {@link ModUiHttpError}. */
export class HttpTransport {
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
