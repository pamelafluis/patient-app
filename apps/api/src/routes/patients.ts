import { Hono } from "hono";
import { createPatientInputSchema, type PatientPage } from "@patient-app/shared";
import type { ConfigProvider } from "../config.ts";
import { FhirClient, FhirError } from "../fhir/client.ts";
import { nextLinkOf, signCursor, verifyCursor } from "../fhir/paging.ts";
import { applyEdit, buildNew, toDetail, toListItem } from "../mappers/patient.ts";

const PAGE_SIZE = 10;
const FIELDS = "name,gender,birthDate";

type Bundle = { entry?: { resource?: Record<string, any> }[]; link?: { relation?: string; url?: string }[] };

export interface PatientDeps {
  config: ConfigProvider;
  fhir: FhirClient;
  today: () => Promise<string>;
  /** Validation for create and edit; built once by the app, which owns the clock. */
  writeSchema: ReturnType<typeof createPatientInputSchema>;
}

export function patientRoutes({ config, fhir, today, writeSchema }: PatientDeps) {
  const app = new Hono();

  app.get("/api/patients", async (c) => {
    const cfg = await config.get();
    const cursor = c.req.query("cursor");
    let path: string;
    if (cursor) {
      path = await verifyCursor(cursor, cfg.fhir.baseUrl, cfg.cursorKey);
    } else {
      const q = new URLSearchParams({ _elements: FIELDS, _sort: "family", _count: String(PAGE_SIZE) });
      // One name= per word; the server ANDs them.
      const words = (c.req.query("name") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 5);
      for (const w of words) q.append("name", w);
      path = `Patient?${q}`;
    }
    const { body } = await fhir.get<Bundle>(path, c.req.raw.signal);
    const t = await today();
    const items = (body.entry ?? []).filter((e) => e.resource?.resourceType === "Patient").map((e) => toListItem(e.resource!, t));
    const next = nextLinkOf(body);
    const page: PatientPage = { items, nextCursor: next ? await signCursor(next, cfg.fhir.baseUrl, cfg.cursorKey) : undefined };
    return c.json(page);
  });

  app.get("/api/patients/:id", async (c) => {
    const { body, etag } = await fhir.get(`Patient/${encodeURIComponent(c.req.param("id"))}`, c.req.raw.signal);
    return c.json(toDetail(body, await today(), etag));
  });

  app.post("/api/patients", async (c) => {
    const parsed = writeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "validation", fields: fieldErrors(parsed.error) }, 422);
    const { body, etag } = await fhir.post("Patient", buildNew(parsed.data));
    return c.json(toDetail(body, await today(), etag), 201);
  });

  app.put("/api/patients/:id", async (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    const raw = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const { version, ...input } = raw as { version?: string } & Record<string, unknown>;
    const { body: current, etag } = await fhir.get(`Patient/${id}`);

    // An unchanged partial birth date ("1950") is kept as is, not rejected:
    // validate the rest against a placeholder date, then restore the original.
    const unchangedDate = typeof input.birthDate === "string" && input.birthDate === current.birthDate;
    const parsed = writeSchema.safeParse(unchangedDate ? { ...input, birthDate: "2000-01-01" } : input);
    if (!parsed.success) return c.json({ error: "validation", fields: fieldErrors(parsed.error) }, 422);
    const data = unchangedDate ? { ...parsed.data, birthDate: input.birthDate as string } : parsed.data;

    const conflict = async (res: { body: Record<string, any>; etag?: string }) =>
      c.json({ error: "conflict", message: "This record changed since you opened it", current: toDetail(res.body, await today(), res.etag) }, 409);

    // Stale version: show the user the current values instead of overwriting.
    if (version && etag && version !== etag) return conflict({ body: current, etag });
    try {
      const { body, etag: saved } = await fhir.put(`Patient/${id}`, applyEdit(current, data), version);
      return c.json({ ...toDetail(body, await today(), saved), conflictProtection: Boolean(version) });
    } catch (e) {
      if (e instanceof FhirError && e.kind === "conflict") return conflict(await fhir.get(`Patient/${id}`));
      throw e;
    }
  });

  return app;
}

function fieldErrors(err: { issues: { path: PropertyKey[]; message: string }[] }) {
  const out: Record<string, string> = {};
  for (const i of err.issues) out[String(i.path[0] ?? "form")] ??= i.message;
  return out;
}
