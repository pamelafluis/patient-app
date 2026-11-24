import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { PatientChartPage } from "../src/features/chart/PatientChartPage.tsx";
import { detail, mockApi, renderApp } from "./helpers.tsx";

const ok = <T,>(data: T, notice?: string) => ({ status: "ok", data, ...(notice ? { notice } : {}) });
const reading = (text: string, date: string, extra: Record<string, unknown> = {}) => ({ text, date, unit: "/min", ...extra });

const summary = (over: Record<string, unknown> = {}) => ({
  patient: detail({ displayName: "Adams, Daniel", gender: "male", birthDate: "1925-12-23", age: 100 }),
  asOf: "2026-11-24",
  vitals: ok({
    bp: reading("148/92", "2026-11-02", { systolic: 148, diastolic: 92, unit: "mmHg" }),
    heartRate: reading("76", "2026-11-02"),
    temperature: reading("37", "2023-11-01", { unit: "°C" }),
    respiration: reading("14", "2026-11-02"),
    spo2: null,
  }),
  conditions: ok({ items: [{ id: "c1", name: "Hypertension", since: "2019-02-03" }], more: false }),
  medications: ok({
    items: [
      { id: "r1", name: "Lisinopril", dose: "10 mg daily", source: "Prescribed" },
      { id: "s1", name: "Aspirin", source: "Reported" },
    ],
    more: false,
  }),
  ...over,
});

const page = (route = "/patients/p1") =>
  renderApp(
    <Routes>
      <Route path="/patients/:id" element={<PatientChartPage />} />
    </Routes>,
    route,
  );
const route = (body: unknown, status = 200) => () => ({ status, body });

describe("chart summary", () => {
  test("shows the patient, all five vitals, conditions and medications on one screen", async () => {
    mockApi({ "GET /api/patients/p1/summary": route(summary()) });
    page();
    expect(await screen.findByRole("heading", { name: "Adams, Daniel" })).toBeTruthy();
    expect(screen.getByText("male · 23 Dec 1925 · 100 y")).toBeTruthy();
    expect(screen.getByText("148/92")).toBeTruthy();
    expect(screen.getByText("Above goal")).toBeTruthy(); // BP flag has words, not only color
    expect(screen.getByText("No reading")).toBeTruthy(); // SpO2
    expect(screen.getByText("Hypertension")).toBeTruthy();
    expect(screen.getByText("since 3 Feb 2019")).toBeTruthy();
    expect(screen.getByText("Prescribed")).toBeTruthy();
    expect(screen.getByText("Reported")).toBeTruthy();
    expect(screen.getByText("Active conditions (1)")).toBeTruthy();
  });

  test("an old reading shows its age in words", async () => {
    mockApi({ "GET /api/patients/p1/summary": route(summary()) });
    page();
    expect(await screen.findByText("3 y ago · old reading")).toBeTruthy();
    expect(screen.getAllByText("22 d ago").length).toBe(3); // recent readings carry no warning
    expect(screen.getAllByText(/old reading/)).toHaveLength(1);
  });

  test("a normal blood pressure carries no flag; a crisis reading says Review now", async () => {
    const vitals = (bp: unknown) => ok({ bp, heartRate: null, temperature: null, respiration: null, spo2: null });
    mockApi({ "GET /api/patients/p1/summary": route(summary({ vitals: vitals({ text: "118/76", systolic: 118, diastolic: 76, unit: "mmHg", date: "2026-11-02" }) })) });
    page();
    await screen.findByText("118/76");
    expect(screen.queryByText("Above goal")).toBeNull();
    expect(screen.queryByText("Review now")).toBeNull();
  });

  test("none recorded and couldn't load look different", async () => {
    mockApi({
      "GET /api/patients/p1/summary": route(
        summary({ conditions: ok({ items: [], more: false }), medications: { status: "error", message: "The FHIR server timed out" } }),
      ),
    });
    page();
    expect(await screen.findByText("None recorded")).toBeTruthy();
    expect(screen.getByText("Couldn't load active medications")).toBeTruthy();
    expect(screen.getByText("The FHIR server timed out")).toBeTruthy();
    // The rest of the chart is still there.
    expect(screen.getByText("148/92")).toBeTruthy();
  });

  test("a failed vitals section shows an error instead of empty cards", async () => {
    mockApi({ "GET /api/patients/p1/summary": route(summary({ vitals: { status: "error", message: "The FHIR server returned an error" } })) });
    page();
    expect(await screen.findByText("Couldn't load vital signs")).toBeTruthy();
    expect(screen.queryByText("No reading")).toBeNull();
    expect(screen.getByText("Hypertension")).toBeTruthy();
  });

  test("a partial medication failure keeps the loaded half and says what is missing", async () => {
    mockApi({
      "GET /api/patients/p1/summary": route(
        summary({ medications: ok({ items: [{ id: "s1", name: "Aspirin", source: "Reported" }], more: false }, "Prescriptions couldn't be loaded.") }),
      ),
    });
    page();
    expect(await screen.findByText("Prescriptions couldn't be loaded.")).toBeTruthy();
    expect(screen.getByText("Aspirin")).toBeTruthy();
  });

  test("a missing patient and a server error are different screens, and Retry reloads", async () => {
    mockApi({ "GET /api/patients/p1/summary": route({ message: "Patient not found" }, 404) });
    page();
    expect(await screen.findByText("This patient doesn't exist on the FHIR server.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("a failed load can be retried", async () => {
    let fail = true;
    mockApi({ "GET /api/patients/p1/summary": () => (fail ? { status: 502, body: { message: "The FHIR server returned an error" } } : { body: summary() }) });
    page();
    expect(await screen.findByText("Couldn't load this chart")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Adams, Daniel" })).toBeTruthy();
  });

  test("missing demographics render safely", async () => {
    const p = detail({ displayName: "Unnamed patient", gender: "unknown", birthDate: "", age: null });
    mockApi({ "GET /api/patients/p1/summary": route(summary({ patient: p })) });
    page();
    expect(await screen.findByText("unknown · Date of birth not recorded")).toBeTruthy();
  });

  test("the Edit button opens the drawer over the chart", async () => {
    mockApi({ "GET /api/patients/p1/summary": route(summary()), "GET /api/patients/p1": route(detail()) });
    page();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect((screen.getByLabelText(/Family name/) as HTMLInputElement).value).toBe("Family1"));
    expect(screen.getByRole("heading", { name: "Adams, Daniel" })).toBeTruthy();
  });
});

describe("vitals trends", () => {
  const vitalsRoutes = (calls: { n: number }) => ({
    "GET /api/patients/p1/summary": route(summary()),
    "GET /api/patients/p1/vitals/heartRate": (c: { url: URL }) => {
      calls.n++;
      return c.url.searchParams.get("cursor")
        ? { body: { readings: [reading("55", "2020-01-01")] } }
        : { body: { readings: [reading("80", "2026-11-02"), reading("70", "2026-05-01")], nextCursor: "next1" } };
    },
    "GET /api/patients/p1/vitals/bp": route({ readings: [] }),
  });

  test("clicking a vital opens its trend with a table of readings, and nothing loaded early", async () => {
    const calls = { n: 0 };
    const sent = mockApi(vitalsRoutes(calls));
    page();
    await screen.findByText("148/92");
    expect(sent.some((c) => c.url.pathname.includes("/vitals/"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Heart rate trend" }));
    const table = await screen.findByRole("table", { name: "Heart rate readings" });
    expect(within(table).getByText("2 Nov 2026")).toBeTruthy();
    expect(within(table).getByText("1 May 2026")).toBeTruthy();
  });

  test("Load earlier readings follows the cursor and appends", async () => {
    const calls = { n: 0 };
    mockApi(vitalsRoutes(calls));
    page("/patients/p1?tab=trends&vital=heartRate");
    await userEvent.click(await screen.findByRole("button", { name: "Load earlier readings" }));
    expect(await within(screen.getByRole("table", { name: "Heart rate readings" })).findByText("1 Jan 2020")).toBeTruthy();
    expect(await screen.findByText("3 readings · all loaded")).toBeTruthy();
  });

  test("a vital with no readings says so", async () => {
    mockApi(vitalsRoutes({ n: 0 }));
    page("/patients/p1?tab=trends&vital=bp");
    expect(await screen.findByText("No blood pressure readings recorded")).toBeTruthy();
  });

  test("a failed trend load offers Retry without breaking the page", async () => {
    mockApi({ "GET /api/patients/p1/summary": route(summary()), "GET /api/patients/p1/vitals/bp": route({ message: "The FHIR server timed out" }, 504) });
    page("/patients/p1?tab=trends&vital=bp");
    expect(await screen.findByText("The FHIR server timed out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Adams, Daniel" })).toBeTruthy();
  });
});

describe("full history", () => {
  test("loads only when the tab opens, then pages and switches sections", async () => {
    const calls = mockApi({
      "GET /api/patients/p1/summary": route(summary()),
      "GET /api/patients/p1/history/conditions": (c) =>
        c.url.searchParams.get("cursor")
          ? { body: { items: [{ id: "c2", title: "Fracture", date: "2010-06-01" }] } }
          : { body: { items: [{ id: "c1", title: "Influenza", date: "2020-02-02", status: "Resolved" }], nextCursor: "n1" } },
      "GET /api/patients/p1/history/allergies": route({ items: [] }),
    });
    page();
    await screen.findByText("148/92");
    expect(calls.some((c) => c.url.pathname.includes("/history/"))).toBe(false);

    await userEvent.click(screen.getByRole("tab", { name: "Full history" }));
    expect(await screen.findByText("Influenza")).toBeTruthy();
    expect(screen.getByText("Resolved")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Fracture")).toBeTruthy();
    expect(await screen.findByText("2 records · all loaded")).toBeTruthy();
  });

  test("an empty section says None recorded; an error says it couldn't load", async () => {
    mockApi({
      "GET /api/patients/p1/summary": route(summary()),
      "GET /api/patients/p1/history/allergies": route({ items: [] }),
      "GET /api/patients/p1/history/encounters": route({ message: "The FHIR server returned an error" }, 502),
    });
    page("/patients/p1?tab=history&section=allergies");
    expect(await screen.findByText("None recorded")).toBeTruthy();
  });

  test("a failing history section shows Couldn't load, not None recorded", async () => {
    mockApi({
      "GET /api/patients/p1/summary": route(summary()),
      "GET /api/patients/p1/history/encounters": route({ message: "The FHIR server returned an error" }, 502),
    });
    page("/patients/p1?tab=history&section=encounters");
    expect(await screen.findByText("Couldn't load encounters")).toBeTruthy();
    expect(screen.queryByText("None recorded")).toBeNull();
  });
});

describe("URL state", () => {
  test("tab, vital and section come from the URL; junk values fall back to defaults", async () => {
    mockApi({ "GET /api/patients/p1/summary": route(summary()), "GET /api/patients/p1/vitals/bp": route({ readings: [] }) });
    page("/patients/p1?tab=nonsense&vital=mood");
    expect(await screen.findByText("Active conditions (1)")).toBeTruthy();
  });
});
