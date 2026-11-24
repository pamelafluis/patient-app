import { describe, expect, test } from "bun:test";
import { createPatientInputSchema, isRealDate, todayIn } from "../src/index.ts";

const NOW = new Date("2026-11-24T23:30:00Z");
const schema = (tz: number) => createPatientInputSchema({ now: () => NOW, tzOffsetHours: tz });
const ok = { given: "Ana", family: "Brown", gender: "female", birthDate: "1978-04-09" };

describe("isRealDate", () => {
  test("accepts real dates, including leap day", () => {
    expect(isRealDate("2024-02-29")).toBe(true);
    expect(isRealDate("1978-04-09")).toBe(true);
  });
  test("rejects impossible or malformed dates", () => {
    for (const v of ["2025-02-29", "2026-13-01", "2026-00-10", "2026-4-9", "", "not a date"]) {
      expect(isRealDate(v)).toBe(false);
    }
  });
});

describe("patient input schema", () => {
  test("accepts a valid patient", () => {
    expect(schema(0).safeParse(ok).success).toBe(true);
  });
  test("requires a family name", () => {
    const r = schema(0).safeParse({ ...ok, family: "   " });
    expect(r.success).toBe(false);
  });
  test("allows an empty given name", () => {
    expect(schema(0).safeParse({ ...ok, given: "" }).success).toBe(true);
  });
  test("accepts only FHIR gender values", () => {
    for (const g of ["male", "female", "other", "unknown"]) {
      expect(schema(0).safeParse({ ...ok, gender: g }).success).toBe(true);
    }
    for (const g of ["M", "Male", "nonbinary", ""]) {
      expect(schema(0).safeParse({ ...ok, gender: g }).success).toBe(false);
    }
  });
  test("rejects a future date of birth with a clear message", () => {
    const r = schema(0).safeParse({ ...ok, birthDate: "2027-03-04" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("Date of birth can't be in the future");
  });
  test("today is allowed; tomorrow is not (UTC)", () => {
    expect(schema(0).safeParse({ ...ok, birthDate: "2026-11-24" }).success).toBe(true);
    expect(schema(0).safeParse({ ...ok, birthDate: "2026-11-25" }).success).toBe(false);
  });
  test("time zone ahead of UTC can already be on the next day", () => {
    expect(todayIn(NOW, 14)).toBe("2026-11-25");
    expect(schema(14).safeParse({ ...ok, birthDate: "2026-11-25" }).success).toBe(true);
    expect(schema(14).safeParse({ ...ok, birthDate: "2026-11-26" }).success).toBe(false);
  });
  test("a time zone behind UTC is still on the previous day", () => {
    expect(schema(-8).safeParse({ ...ok, birthDate: "2026-11-24" }).success).toBe(true);
  });
});
