import { Hono } from "hono";
import {
  HISTORY_SECTIONS,
  LOINC,
  VITAL_CODES,
  VITAL_KINDS,
  type ChartSummary,
  type HistoryItem,
  type HistoryPage,
  type HistorySection,
  type Section,
  type VitalHistory,
  type VitalKind,
  type VitalReading,
} from "@patient-app/shared";
import type { ConfigProvider } from "../config.ts";
import { describeFhirError } from "../errors.ts";
import { FhirClient, FhirError } from "../fhir/client.ts";
import { nextLinkOf, signCursor, verifyCursor } from "../fhir/paging.ts";
import { includedMedications, toCondition, toHistoryItem, toMedication } from "../mappers/clinical.ts";
import { toDetail } from "../mappers/patient.ts";
import { readingsOf } from "../mappers/vitals.ts";

type Json = Record<string, any>;
type Bundle = { entry?: { resource?: Json }[]; link?: { relation?: string; url?: string }[] };

const resourcesOf = (b: Bundle): Json[] => (b.entry ?? []).map((e) => e.resource).filter((r): r is Json => !!r);
const codeParam = (kinds: readonly VitalKind[]) =>
  kinds
    .flatMap((k) => VITAL_CODES[k])
    .map((c) => `${LOINC}|${c}`)
    .join(",");
const nonNull = <T>(x: T | null): x is T => x !== null;

const VITALS_PAGE = 50;
const LIST_PAGE = 50;
const HISTORY_PAGE = 20;
/** The per-vital fallback asks for a few, in case the newest is cancelled or has no value. */
const FALLBACK_COUNT = 5;
const PAST_MED_STATUS = "completed,stopped,on-hold";

export interface ChartDeps {
  config: ConfigProvider;
  fhir: FhirClient;
  today: () => Promise<string>;
}

export function chartRoutes({ config, fhir, today }: ChartDeps) {
  const app = new Hono();

  /** A failing section reports itself; the rest of the chart still loads. */
  async function section<T>(load: () => Promise<{ data: T; notice?: string }>, signal: AbortSignal): Promise<Section<T>> {
    try {
      return { status: "ok", ...(await load()) };
    } catch (e) {
      if (e instanceof FhirError && !signal.aborted) {
        return { status: "error", message: describeFhirError(e).message };
      }
      throw e;
    }
  }

  async function latestVitals(id: string, signal: AbortSignal) {
    const q = new URLSearchParams({ patient: id, code: codeParam(VITAL_KINDS), _sort: "-date", _count: String(VITALS_PAGE) });
    const { body } = await fhir.get<Bundle>(`Observation?${q}`, signal);
    const resources = resourcesOf(body);
    const truncated = !!nextLinkOf(body);
    const out = {} as Record<VitalKind, VitalReading | null>;
    await Promise.all(
      VITAL_KINDS.map(async (kind) => {
        let reading = readingsOf(resources, kind)[0] ?? null;
        // Not in the newest page and there is more: ask for this vital alone before saying "no reading".
        if (!reading && truncated) {
          const one = new URLSearchParams({ patient: id, code: codeParam([kind]), _sort: "-date", _count: String(FALLBACK_COUNT) });
          const res = await fhir.get<Bundle>(`Observation?${one}`, signal);
          reading = readingsOf(resourcesOf(res.body), kind)[0] ?? null;
        }
        out[kind] = reading;
      }),
    );
    return { data: out };
  }

  async function activeConditions(id: string, signal: AbortSignal) {
    const q = new URLSearchParams({ patient: id, "clinical-status": "active,recurrence,relapse", _count: String(LIST_PAGE) });
    const { body } = await fhir.get<Bundle>(`Condition?${q}`, signal);
    const items = resourcesOf(body)
      .filter((r) => r.resourceType === "Condition")
      .map(toCondition)
      .filter(nonNull);
    return { data: { items, more: !!nextLinkOf(body) } };
  }

  /** Prescribed (MedicationRequest) and Reported (MedicationStatement) are fetched separately and never merged. */
  async function activeMedications(id: string, signal: AbortSignal) {
    const requestQ = new URLSearchParams({ patient: id, status: "active", _include: "MedicationRequest:medication", _count: String(LIST_PAGE) });
    const statementQ = new URLSearchParams({ patient: id, status: "active", _count: String(LIST_PAGE) });
    const [req, stmt] = await Promise.allSettled([
      fhir.get<Bundle>(`MedicationRequest?${requestQ}`, signal),
      fhir.get<Bundle>(`MedicationStatement?${statementQ}`, signal),
    ]);
    if (req.status === "rejected" && stmt.status === "rejected") throw req.reason;
    if (signal.aborted) throw signal.reason;
    const bundles = [req, stmt].flatMap((r) => (r.status === "fulfilled" ? [r.value.body] : []));
    const items = bundles
      .flatMap((b) => {
        const rs = resourcesOf(b);
        const inc = includedMedications(rs);
        return rs.filter((r) => r.resourceType === "MedicationRequest" || r.resourceType === "MedicationStatement").map((r) => toMedication(r, inc));
      })
      .filter(nonNull);
    // One source failing must not look like "none recorded": say which half is missing.
    const notice = req.status === "rejected" ? "Prescriptions couldn't be loaded." : stmt.status === "rejected" ? "Reported medications couldn't be loaded." : undefined;
    return { data: { items, more: bundles.some((b) => !!nextLinkOf(b)) }, notice };
  }

  app.get("/api/patients/:id/summary", async (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    const signal = c.req.raw.signal;
    const [patient, vitals, conditions, medications, asOf] = await Promise.all([
      fhir.get(`Patient/${id}`, signal),
      section(() => latestVitals(id, signal), signal),
      section(() => activeConditions(id, signal), signal),
      section(() => activeMedications(id, signal), signal),
      today(),
    ]);
    const summary: ChartSummary = { patient: toDetail(patient.body, asOf, patient.etag), asOf, vitals, conditions, medications };
    return c.json(summary);
  });

  app.get("/api/patients/:id/vitals/:kind", async (c) => {
    const kind = c.req.param("kind") as VitalKind;
    if (!(VITAL_KINDS as readonly string[]).includes(kind)) return c.json({ error: "not-found", message: "Unknown vital sign" }, 404);
    const cfg = await config.get();
    const cursor = c.req.query("cursor");
    const path = cursor
      ? await verifyCursor(cursor, cfg.fhir.baseUrl, cfg.cursorKey)
      : `Observation?${new URLSearchParams({ patient: c.req.param("id"), code: codeParam([kind]), _sort: "-date", _count: String(VITALS_PAGE) })}`;
    const { body } = await fhir.get<Bundle>(path, c.req.raw.signal);
    const next = nextLinkOf(body);
    const page: VitalHistory = {
      readings: readingsOf(resourcesOf(body), kind),
      nextCursor: next ? await signCursor(next, cfg.fhir.baseUrl, cfg.cursorKey) : undefined,
    };
    return c.json(page);
  });

  app.get("/api/patients/:id/history/:section", async (c) => {
    const name = c.req.param("section") as HistorySection;
    if (!(HISTORY_SECTIONS as readonly string[]).includes(name)) return c.json({ error: "not-found", message: "Unknown history section" }, 404);
    const patient = c.req.param("id");
    const signal = c.req.raw.signal;
    const cfg = await config.get();
    const cursor = c.req.query("cursor");
    const verify = (v: string) => verifyCursor(v, cfg.fhir.baseUrl, cfg.cursorKey);
    const sign = async (v?: string) => (v ? signCursor(v, cfg.fhir.baseUrl, cfg.cursorKey) : "");
    const count = String(HISTORY_PAGE);
    const search = (type: string, extra: Record<string, string> = {}) => `${type}?${new URLSearchParams({ patient, ...extra, _count: count })}`;

    if (name === "medications") {
      // Past medications come from two resource types, so the cursor holds one signed link per type.
      const parts = cursor?.split("~");
      if (cursor && parts?.length !== 2) return c.json({ error: "cursor", message: "That page link is no longer valid." }, 400);
      const get = async (link: string | undefined, first: string) => {
        if (cursor && !link) return null; // that type was already exhausted
        return fhir.get<Bundle>(cursor ? await verify(link!) : first, signal);
      };
      const [a, b] = await Promise.all([
        get(parts?.[0], search("MedicationRequest", { status: PAST_MED_STATUS, _include: "MedicationRequest:medication" })),
        get(parts?.[1], search("MedicationStatement", { status: PAST_MED_STATUS })),
      ]);
      const bundles = [a?.body, b?.body].filter((x): x is Bundle => !!x);
      const items: HistoryItem[] = bundles
        .flatMap((bundle) => {
          const rs = resourcesOf(bundle);
          const inc = includedMedications(rs);
          return rs.filter((r) => r.resourceType === "MedicationRequest" || r.resourceType === "MedicationStatement").map((r) => toHistoryItem("medications", r, inc));
        })
        .filter(nonNull);
      const nextA = a ? nextLinkOf(a.body) : undefined;
      const nextB = b ? nextLinkOf(b.body) : undefined;
      const page: HistoryPage = { items, nextCursor: nextA || nextB ? `${await sign(nextA)}~${await sign(nextB)}` : undefined };
      return c.json(page);
    }

    const first: Record<Exclude<HistorySection, "medications">, string> = {
      conditions: search("Condition", { "clinical-status": "resolved,inactive,remission" }),
      allergies: search("AllergyIntolerance"),
      encounters: search("Encounter", { _sort: "-date" }),
      procedures: search("Procedure", { _sort: "-date" }),
      immunizations: search("Immunization", { _sort: "-date" }),
    };
    const { body } = await fhir.get<Bundle>(cursor ? await verify(cursor) : first[name], signal);
    const next = nextLinkOf(body);
    const page: HistoryPage = {
      items: resourcesOf(body)
        .filter((r) => r.resourceType !== "OperationOutcome")
        .map((r) => toHistoryItem(name, r))
        .filter(nonNull),
      nextCursor: next ? await sign(next) : undefined,
    };
    return c.json(page);
  });

  return app;
}
