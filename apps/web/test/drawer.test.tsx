import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PatientsPage } from "../src/features/patients/PatientsPage.tsx";
import { detail, mockApi, patient, renderApp } from "./helpers.tsx";

const base = { "GET /api/patients": () => ({ body: { items: [patient(1)] } }) };

async function openEdit() {
  renderApp(<PatientsPage />);
  await userEvent.click(await screen.findByRole("button", { name: "Edit Family1, Given1" }));
  await waitFor(() => expect((screen.getByLabelText(/Family name/) as HTMLInputElement).value).toBe("Family1"));
}
const save = () => userEvent.click(screen.getByRole("button", { name: "Save" }));

describe("create", () => {
  test("submitting empty shows the errors and focuses the first bad field", async () => {
    mockApi(base);
    renderApp(<PatientsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New patient" }));
    await save();
    expect(await screen.findByText("Family name is required")).toBeTruthy();
    expect(screen.getByText("Enter a real date as YYYY-MM-DD")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Family name/)));
  });

  test("a valid form posts the typed values", async () => {
    const calls = mockApi({ ...base, "POST /api/patients": () => ({ status: 201, body: detail() }) });
    renderApp(<PatientsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New patient" }));
    await userEvent.type(screen.getByLabelText("Given name"), "Ada");
    await userEvent.type(screen.getByLabelText(/Family name/), "Lovelace");
    await userEvent.click(screen.getByRole("radio", { name: "Female" }));
    await userEvent.type(screen.getByLabelText(/Date of birth/), "1815-12-10");
    await userEvent.tab();
    await save();
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ given: "Ada", family: "Lovelace", gender: "female", birthDate: "1815-12-10" });
  });
});

describe("edit", () => {
  test("saving sends the version the user opened", async () => {
    const calls = mockApi({
      ...base,
      "GET /api/patients/p1": () => ({ body: detail() }),
      "PUT /api/patients/p1": () => ({ body: { ...detail(), conflictProtection: true } }),
    });
    await openEdit();
    await userEvent.type(screen.getByLabelText("Given name"), "x");
    await save();
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body.version).toBe('W/"3"');
  });

  test("a 409 shows the current values, blocks Save, and Reload refills the form", async () => {
    const current = detail({ family: "Changed", given: "Elsewhere", version: 'W/"5"' });
    mockApi({
      ...base,
      "GET /api/patients/p1": () => ({ body: detail() }),
      "PUT /api/patients/p1": () => ({ status: 409, body: { error: "conflict", message: "x", current } }),
    });
    await openEdit();
    await save();
    expect(await screen.findByText("This record changed since you opened it")).toBeTruthy();
    expect(screen.getByText(/Current values: Changed, Elsewhere/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Reload current values" }));
    await waitFor(() => expect((screen.getByLabelText(/Family name/) as HTMLInputElement).value).toBe("Changed"));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("server field errors (422) appear on the right fields", async () => {
    mockApi({
      ...base,
      "GET /api/patients/p1": () => ({ body: detail() }),
      "PUT /api/patients/p1": () => ({ status: 422, body: { error: "validation", fields: { family: "Family name is too long" } } }),
    });
    await openEdit();
    await save();
    expect(await screen.findByText("Family name is too long")).toBeTruthy();
  });

  test("a partial existing date is a text field and saves unchanged", async () => {
    const calls = mockApi({
      ...base,
      "GET /api/patients/p1": () => ({ body: detail({ birthDate: "1950" }) }),
      "PUT /api/patients/p1": () => ({ body: { ...detail(), conflictProtection: true } }),
    });
    await openEdit();
    expect((screen.getByLabelText(/Date of birth/) as HTMLInputElement).value).toBe("1950");
    await save();
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body.birthDate).toBe("1950");
  });

  test("a server with no version shows that conflict protection is unavailable", async () => {
    mockApi({ ...base, "GET /api/patients/p1": () => ({ body: detail({ version: undefined }) }) });
    await openEdit();
    expect(screen.getByText("Conflict protection is unavailable on this server.")).toBeTruthy();
  });
});
