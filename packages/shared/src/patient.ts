import { z } from "zod";

export const GENDERS = ["male", "female", "other", "unknown"] as const;
export type Gender = (typeof GENDERS)[number];

/** Furthest-ahead time zone on Earth (UTC+14). The API allows for it. */
export const MAX_TZ_OFFSET_HOURS = 14;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for a real calendar date written YYYY-MM-DD. */
export function isRealDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Today's date (YYYY-MM-DD) in a time zone `tzOffsetHours` ahead of UTC. */
export function todayIn(now: Date, tzOffsetHours: number): string {
  return new Date(now.getTime() + tzOffsetHours * 3_600_000).toISOString().slice(0, 10);
}

/** ISO dates compare correctly as strings. */
export function isFutureDate(value: string, now: Date, tzOffsetHours: number): boolean {
  return value > todayIn(now, tzOffsetHours);
}

export interface PatientInput {
  given: string;
  family: string;
  gender: Gender;
  birthDate: string;
}

/**
 * Shared by browser and API. The browser passes the user's own offset
 * (-new Date().getTimezoneOffset() / 60); the API passes MAX_TZ_OFFSET_HOURS.
 */
export function createPatientInputSchema(opts: { now?: () => Date; tzOffsetHours: number }) {
  const now = opts.now ?? (() => new Date());
  return z.object({
    given: z.string().trim().max(100, "Given name is too long"),
    family: z.string().trim().min(1, "Family name is required").max(100, "Family name is too long"),
    gender: z.enum(GENDERS, { error: "Choose male, female, other or unknown" }),
    birthDate: z
      .string()
      .refine((v) => isRealDate(v), "Enter a real date as YYYY-MM-DD")
      .refine((v) => !isRealDate(v) || !isFutureDate(v, now(), opts.tzOffsetHours), "Date of birth can't be in the future"),
  });
}

/** What the list shows for one patient. Always safe to render: no field is ever missing. */
export interface PatientListItem {
  id: string;
  /** "Family, Given" or "Unnamed patient" */
  displayName: string;
  gender: Gender | "unknown";
  /** As stored; may be partial ("1950", "1950-03") or empty. */
  birthDate: string;
  age: number | null;
}

export interface PatientPage {
  items: PatientListItem[];
  /** Signed cursor for the next page; absent on the last page. */
  nextCursor?: string;
}

/** The editable fields plus the version the user opened, for conflict detection. */
export interface PatientDetail extends PatientListItem {
  given: string;
  family: string;
  /** ETag the server returned, e.g. W/"3". Absent when the server supplies none. */
  version?: string;
}

/** Whole years between a (possibly partial) birth date and `today` (YYYY-MM-DD). */
export function ageOn(birthDate: string, today: string): number | null {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(birthDate);
  if (!m) return null;
  const [by, bm, bd] = [Number(m[1]), Number(m[2] ?? 1), Number(m[3] ?? 1)];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age < 0 ? null : age;
}
