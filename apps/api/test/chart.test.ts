import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { envConfigProvider } from "../src/config.ts";
import { toCondition, toHistoryItem, toMedication, includedMedications } from "../src/mappers/clinical.ts";
import { readingsOf, toReading } from "../src/mappers/vitals.ts";

const BASE = "https://fhir.example.org/r4";
const env = { FHIR_BASE_URL: BASE, CURSOR_KEY: "k".repeat(40), FHIR_BEARER_TOKEN: "SECRET-TOKEN" };
const NOW = () => new Date("2026-11-24T12:00:00Z");

const loinc = (code: string) => ({ coding: [{ system: "http://loinc.org", code }] });
const bp = (date: string, sys: number, dia: number, extra: Record<string, unknown> = {}) => ({
  resourceType: "Observation",
  id: `bp-${date}`,
  status: "final",
  code: loinc("85354-9"),
  effectiveDateTime: date,
  component: [
    { code: loinc("8480-6"), valueQuantity: { value: sys, unit: "mmHg", code: "mm[Hg]" } },
    { code: loinc("8462-4"), valueQuantity: { value: dia, unit: "mmHg", code: "mm[Hg]" } },
  ],
  ...extra,
});
const hr = (date: string, value: number, extra: Record<string, unknown> = {}) => ({
  resourceType: "Observation",
  id: `hr-${date}`,
  status: "final",
  code: loinc("8867-4"),
  effectiveDateTime: date,
  valueQuantity: { value, unit: "/min", code: "/min" },
  ...extra,
});
const temp = (date: string, value: number, code: string, unit = code) => ({
  resourceType: "Observation",
  id: `t-${date}`,
  status: "final",
  code: loinc("8310-5"),
  effectiveDateTime: date,
  valueQuantity: { value, unit, code },
});

describe("vitals mapper", () => {
  test("blood pressure reads systolic and diastolic components", () => {
    expect(toReading(bp("2026-11-02", 148, 92), "bp")).toMatchObject({ systolic: 148, diastolic: 92, text: "148/92", unit: "mmHg", date: "2026-11-02" });
  });
  test("raw floats from the server are rounded: blood pressure to whole mmHg, others to one decimal", () => {
    expect(toReading(bp("2026-11-02", 193.57441248970937, 116.3585493269368), "bp")).toMatchObject({ systolic: 194, diastolic: 116, text: "194/116" });
    expect(toReading(bp("2026-11-02", 139.6, 89.4), "bp")).toMatchObject({ systolic: 140, diastolic: 89 });
    expect(toReading(hr("2026-01-01", 76.46), "heartRate")).toMatchObject({ value: 76.5, text: "76.5" });
  });
  test("a blood pressure missing a component is dropped, not shown half-empty", () => {
    const o = bp("2026-11-02", 148, 92);
    o.component = o.component.slice(0, 1);
    expect(toReading(o, "bp")).toBeNull();
  });
  test("cancelled and entered-in-error readings are excluded", () => {
    expect(toReading(hr("2026-01-01", 70, { status: "entered-in-error" }), "heartRate")).toBeNull();
    expect(toReading(hr("2026-01-01", 70, { status: "cancelled" }), "heartRate")).toBeNull();
  });
  test("temperature converts only known UCUM codes", () => {
    expect(toReading(temp("2026-01-01", 98.6, "[degF]", "F"), "temperature")).toMatchObject({ value: 37, unit: "°C" });
    expect(toReading(temp("2026-01-01", 310.15, "K"), "temperature")).toMatchObject({ value: 37, unit: "°C" });
    expect(toReading(temp("2026-01-01", 37.2, "Cel"), "temperature")).toMatchObject({ value: 37.2, unit: "°C" });
    // Unknown code: no guess, shown as recorded.
    expect(toReading(temp("2026-01-01", 5, "zz", "widgets"), "temperature")).toMatchObject({ value: 5, unit: "widgets" });
  });
  test("readings come back newest first, with undated ones last", () => {
    const out = readingsOf([hr("2020-01-01", 60), hr("2026-05-05", 80), { ...hr("x", 1), effectiveDateTime: undefined }, hr("2019", 50)], "heartRate");
    expect(out.map((r) => r.value)).toEqual([80, 60, 50, 1]);
  });
  test("a code from another system is not a vital", () => {
    const o = { ...hr("2026-01-01", 70), code: { coding: [{ system: "http://example.org", code: "8867-4" }] } };
    expect(readingsOf([o], "heartRate")).toEqual([]);
  });
});

describe("clinical mappers", () => {
  test("refuted and entered-in-error conditions are dropped; onset falls back to recorded date", () => {
    expect(toCondition({ id: "1", code: { text: "Gout" }, verificationStatus: loinc("refuted") })).toBeNull();
    expect(toCondition({ id: "2", code: { text: "Gout" }, verificationStatus: loinc("entered-in-error") })).toBeNull();
    expect(toCondition({ id: "3", code: { coding: [{ display: "Hypertension" }] }, recordedDate: "2019-03-01" })).toEqual({ id: "3", name: "Hypertension", since: "2019-03-01" });
    expect(toCondition({ id: "4" })?.name).toBe("Unnamed condition");
  });
  test("a MedicationRequest takes its name from the included Medication, and is labelled Prescribed", () => {
    const med = { resourceType: "Medication", id: "m1", code: { text: "Lisinopril 10 mg" } };
    const inc = includedMedications([med]);
    const r = { resourceType: "MedicationRequest", id: "r1", status: "active", medicationReference: { reference: "Medication/m1" }, dosageInstruction: [{ text: "Daily" }] };
    expect(toMedication(r, inc)).toEqual({ id: "r1", name: "Lisinopril 10 mg", dose: "Daily", source: "Prescribed" });
  });
  test("a MedicationStatement is labelled Reported; cancelled ones are dropped", () => {
    const s = { resourceType: "MedicationStatement", id: "s1", status: "active", medicationCodeableConcept: { text: "Aspirin 81 mg" } };
    expect(toMedication(s, new Map())?.source).toBe("Reported");
    expect(toMedication({ ...s, status: "entered-in-error" }, new Map())).toBeNull();
  });
  test("history rows survive missing fields", () => {
    expect(toHistoryItem("encounters", { id: "e1" })?.title).toBe("Encounter");
    expect(toHistoryItem("allergies", { id: "a1", code: { text: "Penicillin" }, reaction: [{ manifestation: [{ text: "Rash" }] }] })).toMatchObject({ title: "Penicillin", detail: "Rash" });
    expect(toHistoryItem("procedures", { id: "p", status: "entered-in-error" })).toBeNull();
  });
});

function mock(handler: (url: URL, req: Request) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    calls.push(url);
    return handler(url, req);
  }) as unknown as typeof fetch;
  const app = createApp({ config: envConfigProvider(env), fetch: fetchFn, now: NOW, retryDelayMs: 0 });
  return { app, calls };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/fhir+json", ...headers } });
const bundle = (resources: unknown[], next?: string) => ({
  resourceType: "Bundle",
  entry: resources.map((resource) => ({ resource })),
  link: next ? [{ relation: "next", url: next }] : [],
});
const patient = { resourceType: "Patient", id: "p1", name: [{ family: "Adams", given: ["Daniel"] }], gender: "male", birthDate: "1925-12-23" };

/** A FHIR server with a patient and whatever the test supplies for each resource type. */
function server(data: Partial<Record<string, unknown>> = {}, status: Partial<Record<string, number>> = {}) {
  return mock((url) => {
    const type = url.pathname.replace(`/r4/`, "").split("/")[0]!;
    if (status[type]) return json({ issue: [{ diagnostics: "no" }] }, status[type]);
    if (type === "Patient") return json(patient, 200, { ETag: 'W/"2"' });
    return json(data[type] ?? bundle([]));
  });
}

describe("GET /api/patients/:id/summary", () => {
  test("combines patient, latest vital of each kind, conditions and both medication sources", async () => {
    const { app, calls } = server({
      Observation: bundle([bp("2026-11-02", 148, 92), bp("2026-06-01", 120, 80), hr("2026-10-01", 76)]),
      Condition: bundle([{ resourceType: "Condition", id: "c1", code: { text: "Hypertension" }, onsetDateTime: "2019-02-03" }]),
      MedicationRequest: bundle([
        { resourceType: "MedicationRequest", id: "r1", status: "active", medicationReference: { reference: "Medication/m1" } },
        { resourceType: "Medication", id: "m1", code: { text: "Lisinopril" } },
      ]),
      MedicationStatement: bundle([{ resourceType: "MedicationStatement", id: "s1", status: "active", medicationCodeableConcept: { text: "Aspirin" } }]),
    });
    const res = await app.request("/api/patients/p1/summary");
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.asOf).toBe("2026-11-24");
    expect(body.patient).toMatchObject({ id: "p1", displayName: "Adams, Daniel", age: 100, version: 'W/"2"' });
    expect(body.vitals.data.bp).toMatchObject({ text: "148/92", date: "2026-11-02" });
    expect(body.vitals.data.heartRate.value).toBe(76);
    expect(body.vitals.data.spo2).toBeNull();
    expect(body.conditions.data.items).toEqual([{ id: "c1", name: "Hypertension", since: "2019-02-03" }]);
    expect(body.medications.data.items.map((m: any) => `${m.name}:${m.source}`)).toEqual(["Lisinopril:Prescribed", "Aspirin:Reported"]);

    const obs = calls.find((u) => u.pathname.endsWith("/Observation"))!;
    expect(obs.searchParams.get("_sort")).toBe("-date");
    // Without offset paging HAPI drops observations that match two codes and sends no next link.
    expect(obs.searchParams.get("_offset")).toBe("0");
    expect(obs.searchParams.get("code")).toContain("http://loinc.org|85354-9");
    const cond = calls.find((u) => u.pathname.endsWith("/Condition"))!;
    expect(cond.searchParams.get("clinical-status")).toBe("active,recurrence,relapse");
    expect(calls.find((u) => u.pathname.endsWith("/MedicationRequest"))!.searchParams.get("_include")).toBe("MedicationRequest:medication");
    // Nothing was truncated, so no per-vital follow-up queries.
    expect(calls.filter((u) => u.pathname.endsWith("/Observation"))).toHaveLength(1);
  });

  test("a vital missing from a truncated page is looked up on its own before saying no reading", async () => {
    const { app, calls } = mock((url) => {
      const type = url.pathname.replace("/r4/", "");
      if (type === "Patient/p1") return json(patient);
      if (type !== "Observation") return json(bundle([]));
      const code = url.searchParams.get("code")!;
      if (code.includes("59408-5") && !code.includes("8867-4")) return json(bundle([{ ...hr("2020-01-01", 97), code: loinc("59408-5"), id: "o2", valueQuantity: { value: 97, unit: "%", code: "%" } }]));
      if (code.includes("9279-1") && !code.includes("8867-4")) return json(bundle([])); // truly none
      if (code.includes("8310-5") && !code.includes("8867-4")) return json(bundle([]));
      return json(bundle([hr("2026-10-01", 76), bp("2026-11-02", 120, 80)], `${BASE}?_getpages=1`));
    });
    const body = (await (await app.request("/api/patients/p1/summary")).json()) as any;
    expect(body.vitals.data.spo2).toMatchObject({ value: 97, unit: "%", date: "2020-01-01" });
    expect(body.vitals.data.respiration).toBeNull();
    expect(calls.filter((u) => u.pathname.endsWith("/Observation")).length).toBe(1 + 3); // combined + spo2, respiration, temperature
    expect(calls.filter((u) => u.pathname.endsWith("/Observation")).every((u) => u.searchParams.get("_offset") === "0")).toBe(true);
  });

  test("one failing section reports itself while the others still load", async () => {
    const { app } = server({ Observation: bundle([hr("2026-10-01", 76)]) }, { Condition: 500 });
    const body = (await (await app.request("/api/patients/p1/summary")).json()) as any;
    expect(body.conditions).toEqual({ status: "error", message: "The FHIR server returned an error" });
    expect(body.vitals.status).toBe("ok");
    expect(body.medications).toEqual({ status: "ok", data: { items: [], more: false } });
  });

  test("none recorded and couldn't load are different answers", async () => {
    const empty = (await (await server().app.request("/api/patients/p1/summary")).json()) as any;
    expect(empty.conditions.status).toBe("ok");
    expect(empty.conditions.data.items).toEqual([]);
    const failed = (await (await server({}, { Condition: 503 }).app.request("/api/patients/p1/summary")).json()) as any;
    expect(failed.conditions.status).toBe("error");
  });

  test("if only one medication source fails, the other is shown with a notice", async () => {
    const { app } = server(
      { MedicationStatement: bundle([{ resourceType: "MedicationStatement", id: "s1", status: "active", medicationCodeableConcept: { text: "Aspirin" } }]) },
      { MedicationRequest: 500 },
    );
    const body = (await (await app.request("/api/patients/p1/summary")).json()) as any;
    expect(body.medications.status).toBe("ok");
    expect(body.medications.notice).toBe("Prescriptions couldn't be loaded.");
    expect(body.medications.data.items).toHaveLength(1);
  });

  test("if both medication sources fail it is an error, not an empty list", async () => {
    const { app } = server({}, { MedicationRequest: 500, MedicationStatement: 500 });
    const body = (await (await app.request("/api/patients/p1/summary")).json()) as any;
    expect(body.medications.status).toBe("error");
  });

  test("unknown patient is a 404 and a rejected token never reaches the response", async () => {
    expect((await server({}, { Patient: 404 }).app.request("/api/patients/nope/summary")).status).toBe(404);
    const res = await server({}, { Patient: 401 }).app.request("/api/patients/p1/summary");
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("SECRET-TOKEN");
  });

  test("the patient id cannot smuggle extra path or query into the upstream URL", async () => {
    const { app, calls } = server();
    await app.request("/api/patients/p1%3F_count%3D1%26x/summary");
    expect(calls.every((u) => !u.pathname.includes("?") && !u.searchParams.has("x"))).toBe(true);
  });
});

describe("GET /api/patients/:id/vitals/:kind", () => {
  test("the first page of a trend asks for offset paging, so no reading is silently dropped", async () => {
    const { app, calls } = server();
    await app.request("/api/patients/p1/vitals/spo2");
    expect(calls.at(-1)!.searchParams.get("_offset")).toBe("0");
  });

  test("returns one vital's readings newest first, with a signed cursor", async () => {
    const { app, calls } = server({ Observation: bundle([hr("2026-01-01", 60), hr("2026-09-01", 80)], `${BASE}?_getpages=1&_offset=50`) });
    const res = await app.request("/api/patients/p1/vitals/heartRate");
    const body = (await res.json()) as any;
    expect(body.readings.map((r: any) => r.value)).toEqual([80, 60]);
    expect(body.nextCursor).toBeTruthy();
    expect(body.nextCursor).not.toContain("_getpages");
    expect(calls[0]!.searchParams.get("code")).toBe("http://loinc.org|8867-4");

    const next = await app.request(`/api/patients/p1/vitals/heartRate?cursor=${encodeURIComponent(body.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(calls.at(-1)!.searchParams.get("_getpages")).toBe("1");
  });
  test("unknown vital is 404; tampered cursor is 400 and never calls upstream", async () => {
    const { app, calls } = server();
    expect((await app.request("/api/patients/p1/vitals/mood")).status).toBe(404);
    expect((await app.request("/api/patients/p1/vitals/bp?cursor=abc.def")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  test("a cursor pointing at another server is refused", async () => {
    const { app } = server({ Observation: bundle([], "https://evil.example.com/r4?x=1") });
    const res = await app.request("/api/patients/p1/vitals/bp");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/patients/:id/history/:section", () => {
  test("resolved conditions use the inactive statuses", async () => {
    const { app, calls } = server({ Condition: bundle([{ resourceType: "Condition", id: "c9", code: { text: "Flu" }, clinicalStatus: { text: "Resolved" }, abatementDateTime: "2020-02-02" }]) });
    const body = (await (await app.request("/api/patients/p1/history/conditions")).json()) as any;
    expect(calls[0]!.searchParams.get("clinical-status")).toBe("resolved,inactive,remission");
    expect(body.items).toEqual([{ id: "c9", title: "Flu", date: "2020-02-02", status: "Resolved" }]);
  });
  test("each section queries its own resource type", async () => {
    for (const [section, type] of [["allergies", "AllergyIntolerance"], ["encounters", "Encounter"], ["procedures", "Procedure"], ["immunizations", "Immunization"]] as const) {
      const { app, calls } = server();
      expect((await app.request(`/api/patients/p1/history/${section}`)).status).toBe(200);
      expect(calls[0]!.pathname.endsWith(`/${type}`)).toBe(true);
    }
  });
  test("past medications page both resource types with one combined cursor", async () => {
    const { app, calls } = mock((url) => {
      const type = url.pathname.replace("/r4/", "");
      if (type === "MedicationRequest") {
        return json(
          url.searchParams.has("_getpages")
            ? bundle([])
            : bundle([{ resourceType: "MedicationRequest", id: "r1", status: "completed", medicationCodeableConcept: { text: "Amoxicillin" } }], `${BASE}/MedicationRequest?_getpages=1`),
        );
      }
      if (type === "MedicationStatement") return json(bundle([{ resourceType: "MedicationStatement", id: "s1", status: "stopped", medicationCodeableConcept: { text: "Ibuprofen" } }]));
      return json(bundle([]));
    });
    const first = (await (await app.request("/api/patients/p1/history/medications")).json()) as any;
    expect(first.items.map((i: any) => i.title)).toEqual(["Amoxicillin", "Ibuprofen"]);
    expect(calls.every((u) => u.searchParams.get("status") === "completed,stopped,on-hold")).toBe(true);
    expect(first.nextCursor).toContain("~");

    const before = calls.length;
    const second = (await (await app.request(`/api/patients/p1/history/medications?cursor=${encodeURIComponent(first.nextCursor)}`)).json()) as any;
    expect(second.items).toEqual([]);
    expect(second.nextCursor).toBeUndefined();
    // The statements were already exhausted, so only the requests link is followed.
    expect(calls.slice(before)).toHaveLength(1);
  });
  test("unknown section is 404; a malformed medication cursor is 400", async () => {
    const { app } = server();
    expect((await app.request("/api/patients/p1/history/diary")).status).toBe(404);
    expect((await app.request("/api/patients/p1/history/medications?cursor=justone")).status).toBe(400);
  });
});
