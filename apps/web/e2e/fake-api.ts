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
    const chart = /^\/api\/patients\/(p\d+)\/(summary|vitals|history)(?:\/(\w+))?$/.exec(url.pathname);
    if (chart && req.method() === "GET") {
      const n = Number(chart[1]!.slice(1));
      if (n > total) return json({ message: "Patient not found" }, 404);
      if (chart[2] === "summary") {
        const ok = (data: unknown) => ({ status: "ok", data });
        return json({
          patient: { ...person(n), given: "Test", family: "Person", version: 'W/"1"' },
          asOf: "2026-11-24",
          vitals: ok({
            bp: { text: "148/92", systolic: 148, diastolic: 92, unit: "mmHg", date: "2026-11-02" },
            heartRate: { text: "76", value: 76, unit: "/min", date: "2026-11-02" },
            temperature: { text: "37", value: 37, unit: "°C", date: "2023-11-01" },
            respiration: null,
            spo2: null,
          }),
          conditions: ok({ items: [{ id: "c1", name: "Hypertension", since: "2019-02-03" }], more: false }),
          medications: ok({ items: [{ id: "m1", name: "Lisinopril", dose: "10 mg daily", source: "Prescribed" }], more: false }),
        });
      }
      if (chart[2] === "vitals") {
        const readings = Array.from({ length: 6 }, (_, i) => ({
          text: `${150 - i * 5}/${95 - i * 2}`,
          systolic: 150 - i * 5,
          diastolic: 95 - i * 2,
          unit: "mmHg",
          date: `2026-0${6 - i}-01`,
        }));
        return json({ readings: chart[3] === "bp" ? readings : [] });
      }
      return json({ items: [{ id: "h1", title: "Influenza", status: "Resolved", date: "2020-02-02" }] });
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
