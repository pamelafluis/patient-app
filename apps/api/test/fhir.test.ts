import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig, type AppConfig, type ConfigProvider } from "../src/config.ts";
import { FhirClient, FhirError } from "../src/fhir/client.ts";
import { CursorError, nextLinkOf, signCursor, verifyCursor } from "../src/fhir/paging.ts";

const KEY = "k".repeat(40);
const BASE = "https://fhir.example.org/r4";
const baseEnv = { FHIR_BASE_URL: BASE, CURSOR_KEY: KEY };

describe("parseConfig", () => {
  test("normalizes the base URL and treats a blank token as none", () => {
    const c = parseConfig({ ...baseEnv, FHIR_BASE_URL: BASE + "/?x=1", FHIR_BEARER_TOKEN: "  " });
    expect(c.fhir.baseUrl).toBe(BASE);
    expect(c.fhir.token).toBeUndefined();
  });
  test("requires https except for localhost", () => {
    expect(() => parseConfig({ ...baseEnv, FHIR_BASE_URL: "http://fhir.example.org/r4" })).toThrow(ConfigError);
    expect(parseConfig({ ...baseEnv, FHIR_BASE_URL: "http://localhost:8080/fhir" }).fhir.baseUrl).toBe("http://localhost:8080/fhir");
  });
  test("rejects credentials in the URL, short keys and bad demo dates", () => {
    expect(() => parseConfig({ ...baseEnv, FHIR_BASE_URL: "https://u:p@fhir.example.org/r4" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...baseEnv, CURSOR_KEY: "short" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...baseEnv, DEMO_AS_OF: "24/11/2026" })).toThrow(ConfigError);
  });
});

describe("cursors", () => {
  const next = BASE + "?_getpages=abc&_getpagesoffset=20&_count=20";
  test("round-trips a next link", async () => {
    const c = await signCursor(next, BASE, KEY);
    expect(await verifyCursor(c, BASE, KEY)).toBe(next);
  });
  test("accepts servers whose paging path is the bare base or has a trailing slash", async () => {
    const root = "https://sandbox.example.org";
    expect(await verifyCursor(await signCursor(root + "/?_getpages=1", root, KEY), root, KEY)).toBe(root + "/?_getpages=1");
    expect(await signCursor(BASE + "/?q=1", BASE, KEY)).toBeString();
  });
  test("refuses to sign a link on another host, port or path", async () => {
    for (const bad of ["https://evil.example.com/r4?x=1", "https://fhir.example.org:8443/r4?x=1", "http://evil.example.com/r4?x=1", "https://fhir.example.org/r45?x=1", "https://fhir.example.org/other"]) {
      await expect(signCursor(bad, BASE, KEY)).rejects.toThrow(CursorError);
    }
  });
  test("upgrades an http next link from a proxied server to https", async () => {
    const c = await signCursor("http://fhir.example.org/r4/Patient?_getpages=1", BASE, KEY);
    expect(await verifyCursor(c, BASE, KEY)).toBe("https://fhir.example.org/r4/Patient?_getpages=1");
  });
  test("never downgrades: an https link is refused when the configured base is http", async () => {
    const local = "http://localhost:8080/fhir";
    await expect(signCursor("https://localhost:8080/fhir?x=1", local, KEY)).rejects.toThrow(CursorError);
  });
  test("rejects altered, unsigned and wrongly keyed cursors", async () => {
    const c = await signCursor(next, BASE, KEY);
    const [p, s] = c.split(".") as [string, string];
    await expect(verifyCursor(`${p}x.${s}`, BASE, KEY)).rejects.toThrow(CursorError);
    await expect(verifyCursor(p, BASE, KEY)).rejects.toThrow(CursorError);
    await expect(verifyCursor("", BASE, KEY)).rejects.toThrow(CursorError);
    await expect(verifyCursor(c, BASE, "z".repeat(40))).rejects.toThrow(CursorError);
  });
  test("a valid cursor stops working if the configured server changes", async () => {
    const c = await signCursor(next, BASE, KEY);
    await expect(verifyCursor(c, "https://other.example.org/r4", KEY)).rejects.toThrow(CursorError);
  });
  test("nextLinkOf finds the next relation", () => {
    expect(nextLinkOf({ link: [{ relation: "self", url: "a" }, { relation: "next", url: "b" }] })).toBe("b");
    expect(nextLinkOf({})).toBeUndefined();
  });
});

type Call = { url: string; init: RequestInit };
function setup(responses: (Response | Error)[], token: string | null = "SECRET-TOKEN-123") {
  const calls: Call[] = [];
  let loads = 0, forces = 0;
  const provider: ConfigProvider = {
    get: async (force) => {
      loads++;
      if (force) forces++;
      const cfg: AppConfig = { fhir: { baseUrl: BASE, token: force ? "FRESH-TOKEN" : (token ?? undefined) }, cursorKey: KEY };
      return cfg;
    },
  };
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("unexpected extra fetch");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const client = new FhirClient({ config: provider, fetch: f, retryDelayMs: 0 });
  return { client, calls, stats: () => ({ loads, forces }) };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/fhir+json", ...headers } });
const headerOf = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe("FhirClient", () => {
  test("builds the URL, sends the bearer token and returns the ETag", async () => {
    const { client, calls } = setup([json({ resourceType: "Patient" }, 200, { ETag: 'W/"3"' })]);
    const r = await client.get("Patient/1");
    expect(calls[0]?.url).toBe(BASE + "/Patient/1");
    expect(headerOf(calls[0]!, "Authorization")).toBe("Bearer SECRET-TOKEN-123");
    expect(headerOf(calls[0]!, "Accept")).toBe("application/fhir+json");
    expect(r.etag).toBe('W/"3"');
  });
  test("sends no Authorization header when there is no token", async () => {
    const { client, calls } = setup([json({})], null);
    await client.get("Patient");
    expect(headerOf(calls[0]!, "Authorization")).toBeUndefined();
  });
  test("refuses absolute URLs on another server before sending anything", async () => {
    const { client, calls } = setup([]);
    await expect(client.get("https://evil.example.com/steal")).rejects.toThrow(CursorError);
    expect(calls.length).toBe(0);
  });
  test("on 401 reloads credentials once and retries with the fresh token", async () => {
    const { client, calls, stats } = setup([json({}, 401), json({ ok: true })]);
    await client.get("Patient");
    expect(calls.length).toBe(2);
    expect(headerOf(calls[1]!, "Authorization")).toBe("Bearer FRESH-TOKEN");
    expect(stats().forces).toBe(1);
  });
  test("a second 401 becomes a credentials-rejected error without the token in it", async () => {
    const { client } = setup([json({}, 401), json({}, 401)]);
    const err = await client.get("Patient").catch((e) => e);
    expect(err).toBeInstanceOf(FhirError);
    expect(err.kind).toBe("auth");
    expect(JSON.stringify([err.message, err.stack])).not.toContain("TOKEN");
  });
  test("retries GET on 429 and 503, then succeeds", async () => {
    const { client, calls } = setup([json({}, 429), json({}, 503), json({ ok: 1 })]);
    await client.get("Patient");
    expect(calls.length).toBe(3);
  });
  test("gives up after the retry limit with a throttled error", async () => {
    const { client } = setup([json({}, 429), json({}, 429), json({}, 429)]);
    const err = await client.get("Patient").catch((e) => e);
    expect(err.kind).toBe("throttled");
  });
  test("never retries writes", async () => {
    const { client, calls } = setup([json({}, 503)]);
    await expect(client.post("Patient", { resourceType: "Patient" })).rejects.toBeInstanceOf(FhirError);
    expect(calls.length).toBe(1);
  });
  test("PUT sends If-Match and maps 412 to a conflict", async () => {
    const { client, calls } = setup([json({ resourceType: "OperationOutcome", issue: [{ diagnostics: "stale" }] }, 412)]);
    const err = await client.put("Patient/1", { resourceType: "Patient", id: "1" }, 'W/"3"').catch((e) => e);
    expect(headerOf(calls[0]!, "If-Match")).toBe('W/"3"');
    expect(err.kind).toBe("conflict");
    expect(err.message).toContain("stale");
  });
  test("does not follow redirects, so the token cannot leave the server", async () => {
    const { client, calls } = setup([new Response(null, { status: 302, headers: { Location: "https://evil.example.com" } })]);
    await expect(client.get("Patient")).rejects.toBeInstanceOf(FhirError);
    expect(calls.length).toBe(1);
    expect(calls[0]?.init.redirect).toBe("manual");
  });
  test("maps 404 and network failures", async () => {
    const a = setup([json({}, 404)]);
    expect((await a.client.get("Patient/x").catch((e) => e)).kind).toBe("not-found");
    const b = setup([new TypeError("fetch failed")]);
    expect((await b.client.get("Patient").catch((e) => e)).kind).toBe("upstream");
    const t = new Error("timeout"); t.name = "TimeoutError";
    const c = setup([t]);
    expect((await c.client.get("Patient").catch((e) => e)).kind).toBe("timeout");
  });
});
