import type { PatientDetail } from "./patient.ts";

export const VITAL_KINDS = ["bp", "heartRate", "temperature", "respiration", "spo2"] as const;
export type VitalKind = (typeof VITAL_KINDS)[number];

export const VITAL_LABELS: Record<VitalKind, string> = {
  bp: "Blood pressure",
  heartRate: "Heart rate",
  temperature: "Temperature",
  respiration: "Respiration",
  spo2: "SpO₂",
};

export const LOINC = "http://loinc.org";

/** LOINC codes accepted for each vital (see docs/plan.md, Clinical mapping). */
export const VITAL_CODES: Record<VitalKind, readonly string[]> = {
  bp: ["85354-9", "55284-4"],
  heartRate: ["8867-4"],
  temperature: ["8310-5"],
  respiration: ["9279-1"],
  spo2: ["59408-5", "2708-6"],
};
export const BP_SYSTOLIC = "8480-6";
export const BP_DIASTOLIC = "8462-4";

export const HISTORY_SECTIONS = ["conditions", "medications", "allergies", "encounters", "procedures", "immunizations"] as const;
export type HistorySection = (typeof HISTORY_SECTIONS)[number];

export const HISTORY_LABELS: Record<HistorySection, string> = {
  conditions: "Resolved conditions",
  medications: "Past medications",
  allergies: "Allergies",
  encounters: "Encounters",
  procedures: "Procedures",
  immunizations: "Immunizations",
};

/**
 * A section that loaded, or one that failed on its own. "None recorded"
 * (`ok` with no items) and "Couldn't load" (`error`) are never the same thing.
 */
export type Section<T> = { status: "ok"; data: T; notice?: string } | { status: "error"; message: string };

/** One reading. Blood pressure uses systolic and diastolic; the others use `value`. */
export interface VitalReading {
  /** As recorded; may be partial ("2019") or absent. */
  date?: string;
  systolic?: number;
  diastolic?: number;
  value?: number;
  /** Display unit, e.g. "mmHg", "°C", "/min". Empty when the server gave none. */
  unit: string;
  /** Ready to show, e.g. "148/92" or "37.0". */
  text: string;
}

export interface ConditionItem {
  id: string;
  name: string;
  /** Year or date the condition began, as recorded. */
  since?: string;
}

export interface MedicationItem {
  id: string;
  name: string;
  dose?: string;
  /** Prescribed = MedicationRequest, Reported = MedicationStatement. Never merged. */
  source: "Prescribed" | "Reported";
}

export interface ChartSummary {
  patient: PatientDetail;
  /** The date readings are measured against (the demo date when one is set). */
  asOf: string;
  vitals: Section<Record<VitalKind, VitalReading | null>>;
  conditions: Section<{ items: ConditionItem[]; more: boolean }>;
  medications: Section<{ items: MedicationItem[]; more: boolean }>;
}

export interface VitalHistory {
  readings: VitalReading[];
  nextCursor?: string;
}

export interface HistoryItem {
  id: string;
  title: string;
  detail?: string;
  date?: string;
  status?: string;
}

export interface HistoryPage {
  items: HistoryItem[];
  nextCursor?: string;
}

/** Sorts dates, including partial ones ("2019", "2019-03"); unparseable dates sort oldest. */
export function dateValue(date: string | undefined): number {
  if (!date) return Number.NEGATIVE_INFINITY;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(.*)$/.exec(date);
  if (!m) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(`${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}${m[4] ?? ""}`);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** "today", "5 d ago", "3 mo ago", "3 y ago" — and whether it is over a year old. */
export function agoLabel(date: string | undefined, asOf: string): { label: string; old: boolean } | null {
  const then = dateValue(date);
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((Date.parse(asOf) - then) / 86_400_000);
  if (Number.isNaN(days)) return null;
  if (days < 1) return { label: "today", old: false };
  if (days < 30) return { label: `${days} d ago`, old: false };
  if (days < 365) return { label: `${Math.floor(days / 30)} mo ago`, old: false };
  return { label: `${Math.floor(days / 365)} y ago`, old: true };
}

export type BpStatus = "review-now" | "above-goal" | "at-goal";

/** One reading against the plan's thresholds. Not a certified measure; see docs/plan.md §3. */
export function bpStatus(systolic: number, diastolic: number): BpStatus {
  if (systolic >= 180 || diastolic >= 120) return "review-now";
  if (systolic >= 140 || diastolic >= 90) return "above-goal";
  return "at-goal";
}
