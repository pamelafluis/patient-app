import { ageOn, GENDERS, type Gender, type PatientDetail, type PatientInput, type PatientListItem } from "@patient-app/shared";

type Json = Record<string, any>;

interface HumanName {
  use?: string;
  family?: string;
  given?: string[];
  period?: { end?: string };
}

/** Prefer official, then usual, then the first name that isn't old or a nickname. */
export function pickName(names: HumanName[] | undefined): HumanName | undefined {
  if (!names?.length) return undefined;
  const live = names.filter((n) => n.use !== "old" && !n.period?.end);
  const pool = live.length ? live : names;
  return pool.find((n) => n.use === "official") ?? pool.find((n) => n.use === "usual") ?? pool.find((n) => n.use !== "nickname") ?? pool[0];
}

function genderOf(v: unknown): Gender {
  return (GENDERS as readonly string[]).includes(v as string) ? (v as Gender) : "unknown";
}

export function toListItem(p: Json, today: string): PatientListItem {
  const name = pickName(p.name);
  const family = name?.family?.trim() ?? "";
  const given = (name?.given ?? []).join(" ").trim();
  const displayName = family && given ? `${family}, ${given}` : family || given || "Unnamed patient";
  const birthDate = typeof p.birthDate === "string" ? p.birthDate : "";
  return { id: String(p.id), displayName, gender: genderOf(p.gender), birthDate, age: ageOn(birthDate, today) };
}

export function toDetail(p: Json, today: string, version?: string): PatientDetail {
  const name = pickName(p.name);
  return {
    ...toListItem(p, today),
    given: (name?.given ?? []).join(" "),
    family: name?.family ?? "",
    version,
  };
}

/**
 * Applies an edit to the full current resource. Only the chosen name, gender
 * and birthDate change; identifiers, extensions, other names and everything
 * else are carried through untouched. An unchanged partial birth date is kept.
 */
export function applyEdit(current: Json, input: PatientInput): Json {
  const next: Json = structuredClone(current);
  const names: HumanName[] = Array.isArray(next.name) ? next.name : [];
  const target = pickName(names);
  const given = input.given.trim() ? input.given.trim().split(/\s+/) : [];
  if (target) {
    target.family = input.family;
    if (given.length) target.given = given;
    else delete target.given;
  } else {
    names.push({ use: "official", family: input.family, ...(given.length ? { given } : {}) });
  }
  next.name = names;
  next.gender = input.gender;
  next.birthDate = input.birthDate;
  // Never write back the server-added "summary mode" tag; keep any other tags.
  if (Array.isArray(next.meta?.tag)) {
    next.meta.tag = next.meta.tag.filter((t: Json) => t.code !== "SUBSETTED");
    if (next.meta.tag.length === 0) delete next.meta.tag;
  }
  return next;
}

export function buildNew(input: PatientInput): Json {
  const given = input.given.trim() ? input.given.trim().split(/\s+/) : [];
  return {
    resourceType: "Patient",
    name: [{ use: "official", family: input.family, ...(given.length ? { given } : {}) }],
    gender: input.gender,
    birthDate: input.birthDate,
  };
}
