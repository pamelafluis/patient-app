import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { envConfigProvider } from "../src/config.ts";
import { applyEdit, pickName, toListItem } from "../src/mappers/patient.ts";

const BASE = "https://fhir.example.org/r4";
const env = { FHIR_BASE_URL: BASE, CURSOR_KEY: "k".repeat(40), FHIR_BEARER_TOKEN: "SECRET-TOKEN" };
const NOW = () => new Date("2026-11-24T12:00:00Z");

const stored = () => ({
  resourceType: "Patient",
  id: "p1",
  meta: { versionId: "3", tag: [{ code: "SUBSETTED" }, { code: "keep" }] },
  identifier: [{ value: "MRN-1" }],
  extension: [{ url: "x", valueString: "y" }],
  name: [
    { use: "official", family: "Adams", given: ["Daniel", "X."] },
    { use: "maiden", family: "Old", given: ["D"] },
  ],
  gender: "male",
  birthDate: "1950",
});

function mock(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init);
    calls.push(req);
    return handler(req);
  }) as unknown as typeof fetch;
  const app = createApp({ config: envConfigProvider(env), fetch: fetchFn, now: NOW, retryDelayMs: 0 });
  return { app, calls };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/fhir+json", ...headers } });

describe("mappers", () => {
  test("picks official name, never a nickname or old name when others exist", () => {
    expect(pickName([{ use: "nickname", family: "N" }, { use: "old", family: "O" }, { use: "official", family: "A" }])?.family).toBe("A");
    expect(pickName([{ use: "old", family: "O" }])?.family).toBe("O");
  });
  test("missing data renders safely", () => {
    const i = toListItem({ id: "1" }, "2026-11-24");
    expect(i).toMatchObject({ displayName: "Unnamed patient", gender: "unknown", birthDate: "", age: null });
  });
  test("age handles partial dates and birthdays not yet reached", () => {
    expect(toListItem({ id: "1", birthDate: "1925-12-23" }, "2026-11-24").age).toBe(100);
    expect(toListItem({ id: "1", birthDate: "1925" }, "2026-11-24").age).toBe(101);
  });
  test("edit preserves identifiers, extensions, other names and other tags", () => {
    const out = applyEdit(stored(), { given: "Dan", family: "Adams", gender: "male", birthDate: "1950" });
    expect(out.identifier).toEqual([{ value: "MRN-1" }]);
    expect(out.extension).toBeDefined();
    expect(out.name[1].family).toBe("Old");
    expect(out.name[0].given).toEqual(["Dan"]);
    expect(out.meta.tag).toEqual([{ code: "keep" }]);
  });
});

describe("GET /api/patients", () => {
  const bundle = {
    entry: [{ resource: { resourceType: "Patient", id: "p1", name: [{ family: "Adams", given: ["D"] }], gender: "male", birthDate: "1925-12-23" } }],
    link: [{ relation: "next", url: `${BASE}?_getpages=1&_offset=20` }],
  };
  test("requests lean fields, one name= per word, and signs the next link", async () => {
    const { app, calls } = mock(() => json(bundle));
    const res = await app.request("/api/patients?name=ada%20dan");
    const body = (await res.json()) as any;
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("_elements")).toBe("name,gender,birthDate");
    expect(url.searchParams.getAll("name")).toEqual(["ada", "dan"]);
    expect(body.items[0]).toMatchObject({ id: "p1", displayName: "Adams, D", age: 100 });
    expect(body.nextCursor).not.toContain("_getpages");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  test("rejects a tampered cursor with 400 and never calls upstream", async () => {
    const { app, calls } = mock(() => json(bundle));
    const res = await app.request("/api/patients?cursor=abc.def");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  test("upstream failure is a clean error without the token", async () => {
    const { app } = mock(() => json({ issue: [{ diagnostics: "boom" }] }, 500));
    const res = await app.request("/api/patients");
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("SECRET-TOKEN");
  });
});

describe("write routes", () => {
  const input = { given: "Dan", family: "Adams", gender: "male", birthDate: "1950" };
  test("create validates before touching upstream", async () => {
    const { app, calls } = mock(() => json({}));
    const res = await app.request("/api/patients", { method: "POST", body: JSON.stringify({ ...input, family: "", birthDate: "2999-01-01" }) });
    expect(res.status).toBe(422);
    expect(Object.keys(((await res.json()) as any).fields).sort()).toEqual(["birthDate", "family"]);
    expect(calls).toHaveLength(0);
  });
  test("edit sends the opened version as If-Match and keeps an unchanged partial date", async () => {
    const { app, calls } = mock((r) => (r.method === "GET" ? json(stored(), 200, { ETag: 'W/"3"' }) : json({ ...stored(), meta: { versionId: "4" } }, 200, { ETag: 'W/"4"' })));
    const res = await app.request("/api/patients/p1", { method: "PUT", body: JSON.stringify({ ...input, version: 'W/"3"' }) });
    expect(res.status).toBe(200);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.headers.get("If-Match")).toBe('W/"3"');
    const sent = (await put.json()) as any;
    expect(sent.birthDate).toBe("1950");
    expect(sent.identifier).toBeDefined();
  });
  test("stale version returns 409 with current values and does not write", async () => {
    const { app, calls } = mock(() => json(stored(), 200, { ETag: 'W/"5"' }));
    const res = await app.request("/api/patients/p1", { method: "PUT", body: JSON.stringify({ ...input, version: 'W/"3"' }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).current.version).toBe('W/"5"');
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
  test("server-side 412 also becomes the conflict response", async () => {
    let gets = 0;
    const { app } = mock((r) => (r.method === "PUT" ? json({}, 412) : json(stored(), 200, { ETag: gets++ === 0 ? 'W/"3"' : 'W/"4"' })));
    const res = await app.request("/api/patients/p1", { method: "PUT", body: JSON.stringify({ ...input, version: 'W/"3"' }) });
    expect(res.status).toBe(409);
  });
  test("without a version the save proceeds and reports no conflict protection", async () => {
    const { app } = mock((r) => (r.method === "GET" ? json(stored(), 200, { ETag: 'W/"3"' }) : json(stored(), 200)));
    const res = await app.request("/api/patients/p1", { method: "PUT", body: JSON.stringify(input) });
    expect(((await res.json()) as any).conflictProtection).toBe(false);
  });
});
