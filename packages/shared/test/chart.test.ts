import { describe, expect, test } from "bun:test";
import { agoLabel, bpStatus, dateValue } from "../src/chart.ts";

describe("bpStatus boundaries", () => {
  test("139/89 is at goal, 140/90 is above goal", () => {
    expect(bpStatus(139, 89)).toBe("at-goal");
    expect(bpStatus(140, 89)).toBe("above-goal");
    expect(bpStatus(139, 90)).toBe("above-goal");
  });
  test("179/119 is above goal, 180 or 120 is review now", () => {
    expect(bpStatus(179, 119)).toBe("above-goal");
    expect(bpStatus(180, 80)).toBe("review-now");
    expect(bpStatus(100, 120)).toBe("review-now");
    expect(bpStatus(100, 119)).toBe("above-goal");
  });
});

describe("dateValue", () => {
  test("partial dates sort by their earliest day; junk and missing sort oldest", () => {
    expect(dateValue("2019")).toBe(Date.parse("2019-01-01"));
    expect(dateValue("2019-03")).toBe(Date.parse("2019-03-01"));
    expect(dateValue("2019-03-05T10:00:00Z")).toBe(Date.parse("2019-03-05T10:00:00Z"));
    expect(dateValue(undefined)).toBe(Number.NEGATIVE_INFINITY);
    expect(dateValue("soon")).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("agoLabel", () => {
  const asOf = "2026-11-24";
  test("buckets by age and flags anything over a year", () => {
    expect(agoLabel("2026-11-24", asOf)).toEqual({ label: "today", old: false });
    expect(agoLabel("2026-11-19", asOf)).toEqual({ label: "5 d ago", old: false });
    expect(agoLabel("2026-08-01", asOf)).toEqual({ label: "3 mo ago", old: false });
    expect(agoLabel("2023-11-01", asOf)).toEqual({ label: "3 y ago", old: true });
  });
  test("a future or missing date gives no claim about age", () => {
    expect(agoLabel(undefined, asOf)).toBeNull();
    expect(agoLabel("nonsense", asOf)).toBeNull();
    expect(agoLabel("2027-01-01", asOf)?.label).toBe("today");
  });
});
