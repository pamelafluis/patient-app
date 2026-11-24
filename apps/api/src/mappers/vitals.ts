import { BP_DIASTOLIC, BP_SYSTOLIC, dateValue, LOINC, VITAL_CODES, type VitalKind, type VitalReading } from "@patient-app/shared";

type Json = Record<string, any>;

const EXCLUDED = new Set(["entered-in-error", "cancelled"]);

const codesOf = (cc: Json | undefined, system = LOINC): string[] =>
  (cc?.coding ?? []).filter((c: Json) => c.system === system && typeof c.code === "string").map((c: Json) => c.code);

export function effectiveDate(o: Json): string | undefined {
  const d = o.effectiveDateTime ?? o.effectivePeriod?.start ?? o.effectiveInstant ?? o.issued;
  return typeof d === "string" ? d : undefined;
}

/** Which of our five vitals this Observation is, if any. */
export function kindOf(o: Json): VitalKind | undefined {
  const codes = codesOf(o.code);
  for (const kind of Object.keys(VITAL_CODES) as VitalKind[]) {
    if (VITAL_CODES[kind].some((c) => codes.includes(c))) return kind;
  }
  return undefined;
}

interface Num {
  value: number;
  unit: string;
}

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/** Converts only from known UCUM codes; anything else is shown as recorded. */
function normalize(kind: VitalKind, q: Json | undefined): Num | undefined {
  if (!q || typeof q.value !== "number" || !Number.isFinite(q.value)) return undefined;
  const code: string | undefined = q.code ?? undefined;
  const recorded = String(q.unit ?? code ?? "");
  if (kind === "temperature") {
    if (code === "Cel") return { value: round(q.value), unit: "°C" };
    if (code === "[degF]") return { value: round(((q.value - 32) * 5) / 9), unit: "°C" };
    if (code === "K") return { value: round(q.value - 273.15), unit: "°C" };
  }
  // Some servers store raw floats (193.5744…); blood pressure is read and flagged in whole mmHg.
  if (kind === "bp" && code === "mm[Hg]") return { value: round(q.value, 0), unit: "mmHg" };
  if ((kind === "heartRate" || kind === "respiration") && (code === "/min" || code === "{beats}/min" || code === "{breaths}/min")) {
    return { value: round(q.value), unit: "/min" };
  }
  if (kind === "spo2" && code === "%") return { value: round(q.value), unit: "%" };
  return { value: kind === "bp" ? round(q.value, 0) : round(q.value), unit: recorded };
}

/** Null when the Observation has no usable value, or was cancelled or entered in error. */
export function toReading(o: Json, kind: VitalKind): VitalReading | null {
  if (EXCLUDED.has(o.status)) return null;
  const date = effectiveDate(o);
  if (kind === "bp") {
    const comp = (c: string) => (o.component ?? []).find((x: Json) => codesOf(x.code).includes(c));
    const sys = normalize(kind, comp(BP_SYSTOLIC)?.valueQuantity);
    const dia = normalize(kind, comp(BP_DIASTOLIC)?.valueQuantity);
    if (!sys || !dia) return null;
    return { date, systolic: sys.value, diastolic: dia.value, unit: sys.unit, text: `${sys.value}/${dia.value}` };
  }
  const n = normalize(kind, o.valueQuantity);
  if (!n) return null;
  return { date, value: n.value, unit: n.unit, text: String(n.value) };
}

/** Readings from a bundle's Observations of one kind (or all kinds), newest first. */
export function readingsOf(resources: Json[], kind: VitalKind): VitalReading[] {
  return resources
    .filter((o) => o.resourceType === "Observation" && kindOf(o) === kind)
    .map((o) => toReading(o, kind))
    .filter((r): r is VitalReading => r !== null)
    .sort((a, b) => dateValue(b.date) - dateValue(a.date));
}
