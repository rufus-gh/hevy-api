/**
 * Fetch wrapper for the Hevy client. Adds per-request auth headers via an async
 * provider and transparently retries once on 401 after refreshing the token.
 */

export interface HttpClientOptions {
  /** Base URL, e.g. https://api.hevyapp.com */
  baseUrl: string;
  /** Static headers attached to every request (app version, api key, etc.). */
  headers?: Record<string, string>;
  /** Async provider for auth headers, resolved per request. */
  authHeaders?: () => Promise<Record<string, string>>;
  /** Called once when a request 401s; should force a token refresh. Return value ignored. */
  onUnauthorized?: () => Promise<void>;
  /** Override fetch (for tests or non-browser runtimes). */
  fetch?: typeof fetch;
}

export class HevyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "HevyApiError";
  }
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Set false to skip auth headers (e.g. unauthenticated endpoints). */
  auth?: boolean;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly authHeaders?: () => Promise<Record<string, string>>;
  private readonly onUnauthorized?: () => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.defaultHeaders = opts.headers ?? {};
    this.authHeaders = opts.authHeaders;
    this.onUnauthorized = opts.onUnauthorized;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation available; pass one via options.");
    }
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const useAuth = opts.auth !== false;
    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = { ...this.defaultHeaders };
      if (useAuth && this.authHeaders) Object.assign(headers, await this.authHeaders());
      Object.assign(headers, opts.headers);

      let body: BodyInit | undefined;
      if (opts.body !== undefined) {
        body = JSON.stringify(opts.body);
        headers["content-type"] ??= "application/json";
      }
      // Hevy sends a client clock with each request.
      headers["x-client-time"] ??= (Date.now() / 1000).toFixed(3);

      return this.fetchImpl(url.toString(), {
        method: opts.method ?? "GET",
        headers,
        body,
        signal: opts.signal,
      });
    };

    let res = await send();
    if (res.status === 401 && useAuth && this.onUnauthorized) {
      await this.onUnauthorized();
      res = await send();
    }

    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;

    if (!res.ok) {
      throw new HevyApiError(
        `Hevy API ${res.status} on ${opts.method ?? "GET"} ${path}`,
        res.status,
        url.toString(),
        parsed ?? text,
      );
    }

    return parsed as T;
  }

  get<T>(path: string, opts?: Omit<RequestOptions, "method" | "body">) {
    return this.request<T>(path, { ...opts, method: "GET" });
  }
  post<T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method">) {
    return this.request<T>(path, { ...opts, method: "POST", body });
  }
  put<T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method">) {
    return this.request<T>(path, { ...opts, method: "PUT", body });
  }
  delete<T>(path: string, opts?: Omit<RequestOptions, "method">) {
    return this.request<T>(path, { ...opts, method: "DELETE" });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
