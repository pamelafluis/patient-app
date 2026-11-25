import { afterEach, describe, expect, test } from "bun:test";
import { api, setAuthHandlers } from "../src/lib/api.ts";
import { allowReauth, loadRuntimeConfig, signOutUrl } from "../src/lib/auth.tsx";

const cfg = { authority: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", clientId: "cid", hostedUiDomain: "https://x.auth.us-east-1.amazoncognito.com" };
const json = (v: unknown, status = 200) => (async () => new Response(JSON.stringify(v), { status })) as unknown as typeof fetch;

afterEach(() => setAuthHandlers({ getToken: () => undefined, onUnauthorized: () => {} }));

describe("runtime config", () => {
  test("a valid config.json turns login on", async () => {
    expect(await loadRuntimeConfig(json(cfg))).toEqual(cfg);
  });
  test("missing, non-JSON or incomplete config means no login (local dev)", async () => {
    expect(await loadRuntimeConfig(json({}, 404))).toBeNull();
    expect(await loadRuntimeConfig((async () => new Response("<html>")) as unknown as typeof fetch)).toBeNull();
    expect(await loadRuntimeConfig(json({ authority: "a" }))).toBeNull();
    expect(await loadRuntimeConfig((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
  test("sign-out URL returns to the app root", () => {
    const u = new URL(signOutUrl(cfg, "https://d1.cloudfront.net"));
    expect(u.origin + u.pathname).toBe("https://x.auth.us-east-1.amazoncognito.com/logout");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("logout_uri")).toBe("https://d1.cloudfront.net/");
  });
});

describe("api auth", () => {
  test("sends the bearer token when signed in, none otherwise", async () => {
    let auth: string | null = "unset";
    globalThis.fetch = (async (_u: any, init: any) => {
      auth = new Headers(init.headers).get("Authorization");
      return new Response("{}");
    }) as unknown as typeof fetch;
    await api.getPatient("1");
    expect(auth).toBeNull();
    setAuthHandlers({ getToken: () => "tok", onUnauthorized: () => {} });
    await api.getPatient("1");
    expect(auth).toBe("Bearer tok");
  });
  test("a 401 triggers the sign-in handler", async () => {
    let called = 0;
    setAuthHandlers({ getToken: () => "old", onUnauthorized: () => called++ });
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    await api.getPatient("1").catch(() => {});
    expect(called).toBe(1);
  });
});

describe("re-sign-in guard", () => {
  test("allows one forced sign-in per 30 seconds, so a broken API can't cause a redirect loop", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(allowReauth(store, 100_000)).toBe(true);
    expect(allowReauth(store, 110_000)).toBe(false);
    expect(allowReauth(store, 131_000)).toBe(true);
  });
});
