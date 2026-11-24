import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { fakeApi } from "./fake-api.ts";

test.describe("patient chart", () => {
  test("one click from the list shows the whole summary on a single screen", async ({ page }) => {
    await fakeApi(page);
    await page.goto("/patients");
    await page.getByRole("link", { name: "Person001, Test" }).click();

    await expect(page).toHaveURL(/\/patients\/p1$/);
    await expect(page.getByRole("heading", { name: "Person001, Test" })).toBeVisible();
    for (const text of ["148/92", "Above goal", "76", "3 y ago · old reading", "No reading", "Hypertension", "Lisinopril", "Prescribed"]) {
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    }
    // Everything above fits in the 700px-high window: no page scrolling to see it.
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2)).toBe(true);
  });

  test("a vital opens its trend: a drawn chart plus a table, and Back returns to the list", async ({ page }) => {
    await fakeApi(page);
    await page.goto("/patients");
    await page.getByRole("link", { name: "Person001, Test" }).click();
    await page.getByRole("button", { name: "Blood pressure trend" }).click();
    await expect(page).toHaveURL(/tab=trends&vital=bp/);
    await expect(page.getByRole("table", { name: "Blood pressure readings" })).toBeVisible();
    await expect(page.locator(".recharts-line").first()).toBeVisible(); // a real line was drawn
    await expect(page.getByRole("table", { name: "Blood pressure readings" }).getByRole("row")).toHaveCount(7); // header + 6

    await page.goBack(); // undoes the tab change
    await expect(page.getByText("Active conditions (1)")).toBeVisible();
    await page.goBack(); // then the list
    await expect(page.getByRole("heading", { name: "Patients" })).toBeVisible();
  });

  test("refreshing keeps the tab and the chosen vital", async ({ page }) => {
    await fakeApi(page);
    await page.goto("/patients/p1?tab=trends&vital=bp");
    await page.reload();
    await expect(page.getByRole("table", { name: "Blood pressure readings" })).toBeVisible();
    await page.getByRole("tab", { name: "Full history" }).click();
    await expect(page.getByText("Influenza")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Influenza")).toBeVisible();
  });

  test("an unknown patient says so", async ({ page }) => {
    await fakeApi(page, 5);
    await page.goto("/patients/p99");
    await expect(page.getByText("This patient doesn't exist on the FHIR server.")).toBeVisible();
  });

  test("keyboard only: tab to a name, Enter opens the chart", async ({ page }) => {
    await fakeApi(page);
    await page.goto("/patients");
    await page.getByRole("link", { name: "Person001, Test" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Person001, Test" })).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`no accessibility violations in ${scheme} mode (summary and trends)`, async ({ page }) => {
      await fakeApi(page);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/patients/p1");
      await expect(page.getByText("148/92")).toBeVisible();
      const summary = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(summary.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);

      await page.getByRole("button", { name: "Blood pressure trend" }).click();
      await expect(page.locator(".recharts-line").first()).toBeVisible();
      const trends = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(trends.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    });
  }

  test("a phone-width window has no sideways scrolling", async ({ page }) => {
    await fakeApi(page);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/patients/p1");
    await expect(page.getByText("148/92")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
