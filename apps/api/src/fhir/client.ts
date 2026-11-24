import type { ConfigProvider } from "../config.ts";
import { assertSameServer } from "./paging.ts";

export class FhirError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** "auth" = credentials rejected, "conflict" = stale version, "upstream" = anything else */
    readonly kind: "auth" | "conflict" | "not-found" | "throttled" | "timeout" | "upstream",
  ) {
    super(message);
  }
}

export interface FhirClientOptions {
  config: ConfigProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts for GET on 429/503. */
  maxRetries?: number;
  /** Retry backoff in ms; tests set this to 0. */
  retryDelayMs?: number;
}

type Json = Record<string, unknown>;

function describe(status: number, body: unknown): string {
  // Only OperationOutcome text is surfaced; headers (and so the token) never are.
  const issue = (body as { issue?: { diagnostics?: string; details?: { text?: string } }[] } | null)?.issue?.[0];
  const detail = issue?.details?.text ?? issue?.diagnostics;
  return detail ? `FHIR server returned ${status}: ${String(detail).slice(0, 200)}` : `FHIR server returned ${status}`;
}

export class FhirClient {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: FhirClientOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 300;
  }

  /** GET a relative path ("Patient?_count=20") or an absolute URL on the configured server. */
  get<T = Json>(pathOrUrl: string, signal?: AbortSignal): Promise<{ body: T; etag?: string }> {
    return this.request<T>("GET", pathOrUrl, undefined, {}, signal);
  }

  post<T = Json>(path: string, resource: Json, headers: Record<string, string> = {}) {
    return this.request<T>("POST", path, resource, headers);
  }

  /** `ifMatch` is the version the user opened, e.g. W/"3". */
  put<T = Json>(path: string, resource: Json, ifMatch?: string) {
    return this.request<T>("PUT", path, resource, ifMatch ? { "If-Match": ifMatch } : {});
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    pathOrUrl: string,
    body: Json | undefined,
    extraHeaders: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ body: T; etag?: string }> {
    let forced = false;
    for (let attempt = 0; ; attempt++) {
      const cfg = await this.opts.config.get(forced);
      const url = /^https?:\/\//i.test(pathOrUrl)
        ? assertSameServer(pathOrUrl, cfg.fhir.baseUrl).toString()
        : `${cfg.fhir.baseUrl}/${pathOrUrl.replace(/^\/+/, "")}`;
      const headers: Record<string, string> = {
        Accept: "application/fhir+json",
        ...(body ? { "Content-Type": "application/fhir+json" } : {}),
        ...extraHeaders,
        ...(cfg.fhir.token ? { Authorization: `Bearer ${cfg.fhir.token}` } : {}),
      };

      let res: Response;
      try {
        res = await this.doFetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          redirect: "manual", // never follow a redirect with the token attached
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new FhirError(timedOut ? "FHIR server timed out" : "Could not reach the FHIR server", 0, timedOut ? "timeout" : "upstream");
      }

      if (res.status >= 300 && res.status < 400) {
        throw new FhirError("FHIR server redirected the request; redirects are not followed", res.status, "upstream");
      }
      if (res.ok) {
        const text = await res.text();
        return { body: (text ? JSON.parse(text) : {}) as T, etag: res.headers.get("ETag") ?? undefined };
      }

      const errBody = await res.json().catch(() => null);
      if (res.status === 401 && !forced) {
        forced = true; // reload credentials once, then retry
        continue;
      }
      if (method === "GET" && (res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
        continue;
      }
      const message = describe(res.status, errBody);
      if (res.status === 401 || res.status === 403) throw new FhirError("FHIR credentials rejected", res.status, "auth");
      if (res.status === 404 || res.status === 410) throw new FhirError(message, res.status, "not-found");
      if (res.status === 409 || res.status === 412) throw new FhirError(message, res.status, "conflict");
      if (res.status === 429) throw new FhirError(message, res.status, "throttled");
      throw new FhirError(message, res.status, "upstream");
    }
  }
}
