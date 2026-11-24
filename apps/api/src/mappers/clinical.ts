import type { ConditionItem, HistoryItem, HistorySection, MedicationItem } from "@patient-app/shared";

type Json = Record<string, any>;

const codeValues = (cc: Json | undefined): string[] => (cc?.coding ?? []).map((c: Json) => String(c.code ?? ""));
const hasCode = (cc: Json | undefined, ...codes: string[]) => codeValues(cc).some((c) => codes.includes(c));

/** Best human text for a CodeableConcept. */
export function textOf(cc: Json | undefined): string | undefined {
  if (!cc) return undefined;
  const t = cc.text ?? cc.coding?.find((c: Json) => c.display)?.display ?? cc.coding?.[0]?.code;
  return typeof t === "string" && t.trim() ? t.trim() : undefined;
}

const year = (d: unknown) => (typeof d === "string" ? d : undefined);

/** Conditions that were never real, or were retracted, are not shown anywhere. */
const isDisregarded = (c: Json) => hasCode(c.verificationStatus, "refuted", "entered-in-error");

export function toCondition(c: Json): ConditionItem | null {
  if (isDisregarded(c)) return null;
  return {
    id: String(c.id),
    name: textOf(c.code) ?? "Unnamed condition",
    since: year(c.onsetDateTime ?? c.onsetPeriod?.start ?? c.recordedDate),
  };
}

function dosageText(r: Json): string | undefined {
  const d = (r.dosageInstruction ?? r.dosage)?.[0];
  const t = d?.text ?? textOf(d?.route);
  return typeof t === "string" && t.trim() ? t.trim() : undefined;
}

/** Looks up a referenced Medication in the same bundle (`_include`) or contained in the request. */
function medicationName(r: Json, included: Map<string, Json>): string {
  if (r.medicationCodeableConcept) return textOf(r.medicationCodeableConcept) ?? "Unnamed medication";
  const ref: string | undefined = r.medicationReference?.reference;
  if (ref) {
    const key = ref.startsWith("#") ? ref.slice(1) : ref.split("/").slice(-2).join("/");
    const med = included.get(key) ?? (r.contained ?? []).find((m: Json) => m.id === ref.slice(1));
    return textOf(med?.code) ?? r.medicationReference?.display ?? "Unnamed medication";
  }
  return "Unnamed medication";
}

export function includedMedications(resources: Json[]): Map<string, Json> {
  const map = new Map<string, Json>();
  for (const r of resources) if (r.resourceType === "Medication") map.set(`Medication/${r.id}`, r);
  return map;
}

const MED_GONE = new Set(["entered-in-error", "cancelled", "draft"]);

export function toMedication(r: Json, included: Map<string, Json>): MedicationItem | null {
  if (MED_GONE.has(r.status)) return null;
  return {
    id: String(r.id),
    name: medicationName(r, included),
    dose: dosageText(r),
    source: r.resourceType === "MedicationRequest" ? "Prescribed" : "Reported",
  };
}

const GONE = new Set(["entered-in-error"]);

/** One line per record for the "Full history" tab. Null drops the record. */
export function toHistoryItem(section: HistorySection, r: Json, included: Map<string, Json> = new Map()): HistoryItem | null {
  if (GONE.has(r.status) || isDisregarded(r)) return null;
  const id = String(r.id);
  switch (section) {
    case "conditions":
      return { id, title: textOf(r.code) ?? "Unnamed condition", date: year(r.abatementDateTime ?? r.onsetDateTime ?? r.recordedDate), status: textOf(r.clinicalStatus) };
    case "medications":
      return { id, title: medicationName(r, included), detail: dosageText(r), date: year(r.authoredOn ?? r.dateAsserted ?? r.effectiveDateTime), status: r.status };
    case "allergies":
      return {
        id,
        title: textOf(r.code) ?? "Unnamed allergy",
        detail: (r.reaction ?? []).flatMap((x: Json) => (x.manifestation ?? []).map(textOf)).filter(Boolean).join(", ") || undefined,
        date: year(r.recordedDate ?? r.onsetDateTime),
        status: textOf(r.clinicalStatus) ?? r.criticality,
      };
    case "encounters":
      return { id, title: textOf(r.type?.[0]) ?? textOf(r.serviceType) ?? r.class?.display ?? r.class?.code ?? "Encounter", detail: r.reasonCode ? textOf(r.reasonCode[0]) : undefined, date: year(r.period?.start), status: r.status };
    case "procedures":
      return { id, title: textOf(r.code) ?? "Unnamed procedure", date: year(r.performedDateTime ?? r.performedPeriod?.start), status: r.status };
    case "immunizations":
      return { id, title: textOf(r.vaccineCode) ?? "Unnamed vaccine", date: year(r.occurrenceDateTime ?? r.occurrenceString), status: r.status };
  }
}
