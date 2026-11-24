import type { Page, Route } from "@playwright/test";

const PAGE = 10;

export const person = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `p${n}`,
  displayName: `Person${String(n).padStart(3, "0")}, Test`,
  gender: n % 2 ? "female" : "male",
  birthDate: "1990-05-01",
  age: 36,
  ...extra,
});

export interface FakeApi {
  /** Every request the page made, e.g. "GET /api/patients?cursor=c1". */
  requests: string[];
  /** Bodies of POST/PUT requests. */
  writes: { method: string; path: string; body: any }[];
}

/** Serves `total` patients in pages of 10, plus single-patient reads and writes. */
export async function fakeApi(page: Page, total = 95): Promise<FakeApi> {
  const api: FakeApi = { requests: [], writes: [] };
  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    api.requests.push(`${req.method()} ${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (req.method() === "GET" && url.pathname === "/api/patients") {
      const name = (url.searchParams.get("name") ?? "").toLowerCase();
      const all = Array.from({ length: total }, (_, i) => person(i + 1)).filter((p) => !name || p.displayName.toLowerCase().includes(name));
      const start = Number(url.searchParams.get("cursor")?.replace("c", "") ?? 0) * PAGE;
      const items = all.slice(start, start + PAGE);
      const more = start + PAGE < all.length;
      return json({ items, nextCursor: more ? `c${start / PAGE + 1}` : undefined });
    }
    const one = /^\/api\/patients\/(p\d+)$/.exec(url.pathname);
    if (one && req.method() === "GET") {
      return json({ ...person(Number(one[1]!.slice(1))), given: "Test", family: "Person", version: 'W/"1"' });
    }
    if (req.method() === "POST" || req.method() === "PUT") {
      const body = req.postDataJSON();
      api.writes.push({ method: req.method(), path: url.pathname, body });
      return json({ ...person(1), ...body, version: 'W/"2"', conflictProtection: true }, req.method() === "POST" ? 201 : 200);
    }
    return json({ message: "not mocked" }, 500);
  });
  return api;
}
