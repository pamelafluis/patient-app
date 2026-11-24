import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PatientsPage } from "../src/features/patients/PatientsPage.tsx";
import { detail, mockApi, patient, renderApp } from "./helpers.tsx";

const list = (items: unknown[]) => () => ({ body: { items } });

describe("PatientsPage", () => {
  test("shows a loading state, then the rows", async () => {
    mockApi({ "GET /api/patients": list([patient(1), patient(2)]) });
    renderApp(<PatientsPage />);
    expect(screen.getByLabelText("Loading patients")).toBeTruthy();
    expect(await screen.findByText("Family1, Given1")).toBeTruthy();
    expect(screen.getByText("Family2, Given2")).toBeTruthy();
  });

  test("shows a clear message and a Create patient button when nothing matches", async () => {
    mockApi({ "GET /api/patients": list([]) });
    renderApp(<PatientsPage />, "/patients?q=zzzz");
    expect(await screen.findByText("No patients match “zzzz”")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create patient" })).toBeTruthy();
  });

  test("shows an error with Retry, and Retry reloads", async () => {
    let fail = true;
    mockApi({
      "GET /api/patients": () => (fail ? { status: 502, body: { message: "The FHIR server returned an error" } } : { body: { items: [patient(1)] } }),
    });
    renderApp(<PatientsPage />);
    expect(await screen.findByText("The FHIR server returned an error")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Family1, Given1")).toBeTruthy();
  });

  test("missing date of birth and age render as placeholders", async () => {
    mockApi({ "GET /api/patients": list([patient(1, { birthDate: "", age: null })]) });
    renderApp(<PatientsPage />);
    expect(await screen.findByText("Not recorded")).toBeTruthy();
    expect(screen.getByText("–")).toBeTruthy();
  });

  test("a single-character search is not sent as a name filter", async () => {
    const calls = mockApi({ "GET /api/patients": list([patient(1)]) });
    renderApp(<PatientsPage />, "/patients?q=a");
    await screen.findByText("Family1, Given1");
    await new Promise((r) => setTimeout(r, 450));
    expect(calls.every((c) => !c.url.searchParams.get("name"))).toBe(true);
  });

  test("a 2+ character search is sent to the API after the debounce", async () => {
    const calls = mockApi({ "GET /api/patients": list([patient(1)]) });
    renderApp(<PatientsPage />, "/patients?q=ada");
    await waitFor(() => expect(calls.some((c) => c.url.searchParams.get("name") === "ada")).toBe(true), { timeout: 2000 });
  });

  test("a name links to the chart, and hovering it warms the chart data", async () => {
    const calls = mockApi({ "GET /api/patients": list([patient(1)]), "GET /api/patients/p1/summary": () => ({ body: {} }) });
    renderApp(<PatientsPage />);
    const link = await screen.findByRole("link", { name: "Family1, Given1" });
    expect(link.getAttribute("href")).toBe("/patients/p1");
    await userEvent.hover(link);
    await waitFor(() => expect(calls.some((c) => c.url.pathname === "/api/patients/p1/summary")).toBe(true), { timeout: 1000 });
  });

  test("moving off a name before 150 ms does not fetch the chart", async () => {
    const calls = mockApi({ "GET /api/patients": list([patient(1)]) });
    renderApp(<PatientsPage />);
    const link = await screen.findByRole("link", { name: "Family1, Given1" });
    await userEvent.hover(link);
    await userEvent.unhover(link);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.some((c) => c.url.pathname.endsWith("/summary"))).toBe(false);
  });

  test("the pencil opens the edit drawer with that patient's values", async () => {
    mockApi({ "GET /api/patients": list([patient(1)]), "GET /api/patients/p1": () => ({ body: detail() }) });
    renderApp(<PatientsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit Family1, Given1" }));
    await waitFor(() => expect((screen.getByLabelText(/Family name/) as HTMLInputElement).value).toBe("Family1"));
    expect((screen.getByLabelText("Given name") as HTMLInputElement).value).toBe("Given1");
  });
});
