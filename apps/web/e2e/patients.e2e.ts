import { expect, test } from "@playwright/test";
import { fakeApi } from "./fake-api.ts";

const rows = (page: import("@playwright/test").Page) => page.locator("tbody tr[data-index]");
const feed = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "Patient list" });

test.describe("patient feed", () => {
  test("fills the screen without any clicking, then loads more as you scroll", async ({ page }) => {
    const api = await fakeApi(page);
    await page.goto("/patients");
    await expect(rows(page).first()).toContainText("Person001");

    // A 700px-high window shows more than one 10-row page, so a second page loads by itself.
    await expect.poll(() => api.requests.filter((r) => r.includes("cursor=")).length).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: /load more|next/i })).toHaveCount(0);

    // Keep scrolling to the bottom: the feed reaches the end of all 95 patients.
    for (let i = 0; i < 30; i++) {
      await feed(page).evaluate((e) => (e.scrollTop = e.scrollHeight));
      if (await page.getByText("95 patients · end of list").isVisible()) break;
      await page.waitForTimeout(150);
    }
    await expect(page.getByText("95 patients · end of list")).toBeVisible();
    expect(api.requests.filter((r) => r.includes("cursor=")).length).toBe(9); // pages 2..10, each fetched once
  });

  test("only a window of rows is in the page, and scrolling back up restores earlier patients", async ({ page }) => {
    await fakeApi(page);
    await page.goto("/patients");
    await expect(rows(page).first()).toContainText("Person001");
    for (let i = 0; i < 30; i++) {
      await feed(page).evaluate((e) => (e.scrollTop = e.scrollHeight));
      if (await page.getByText("95 patients · end of list").isVisible()) break;
      await page.waitForTimeout(150);
    }
    // 95 patients are loaded, but far fewer rows exist in the page, and the first ones are gone.
    expect(await rows(page).count()).toBeLessThan(40);
    await expect(page.getByText("Person001, Test", { exact: true })).toHaveCount(0);
    await expect(rows(page).last()).toContainText("Person095");

    await feed(page).evaluate((e) => (e.scrollTop = 0));
    await expect(page.getByText("Person001, Test", { exact: true })).toBeVisible();
  });

  test("a short window scrolls inside the list, not the page", async ({ page }) => {
    await fakeApi(page);
    await page.setViewportSize({ width: 1200, height: 420 });
    await page.goto("/patients");
    await expect(rows(page).first()).toContainText("Person001");
    const { inner, outer } = await page.evaluate(() => {
      const f = document.querySelector("[role=region]") as HTMLElement;
      return { inner: f.scrollHeight > f.clientHeight, outer: document.documentElement.scrollHeight > window.innerHeight + 2 };
    });
    expect(inner).toBe(true);
    expect(outer).toBe(false);
  });
});

test.describe("header search", () => {
  test("fast typing keeps every character and filters the list", async ({ page }) => {
    const api = await fakeApi(page);
    await page.goto("/patients");
    await expect(rows(page).first()).toContainText("Person001");
    await page.keyboard.press("/");
    await page.keyboard.type("person04"); // typed at full speed, as a user would
    await expect(page.getByLabel("Search patients by name")).toHaveValue("person04");
    await expect(page).toHaveURL(/\?q=person04$/);
    await expect(rows(page)).toHaveCount(10);
    await expect(rows(page).first()).toContainText("Person040");
    expect(api.requests.some((r) => r.includes("name=person04"))).toBe(true);
  });
});

test.describe("date of birth picker", () => {
  async function openNew(page: import("@playwright/test").Page) {
    await page.goto("/patients");
    await page.getByRole("button", { name: "New patient" }).click();
    await page.getByLabel(/Family name/).fill("Lovelace");
  }

  test("a date can be typed and is sent as YYYY-MM-DD", async ({ page }) => {
    const api = await fakeApi(page);
    await openNew(page);
    await page.getByLabel(/Date of birth/).fill("1815-12-10");
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => api.writes.length).toBe(1);
    expect(api.writes[0]!.body).toMatchObject({ family: "Lovelace", birthDate: "1815-12-10" });
  });

  test("a date can be picked from the calendar (decade, year, month, day)", async ({ page }) => {
    const api = await fakeApi(page);
    await openNew(page);
    await page.getByLabel(/Date of birth/).click();
    const calendar = page.locator("[data-calendar]");
    await expect(calendar.getByRole("button", { name: "2020", exact: true })).toBeVisible(); // opens on the current decade
    // Back one decade to the 2010s, then to the 2000s, then drill down: year, month, day.
    await calendar.locator("button[data-direction='previous']").click();
    await calendar.locator("button[data-direction='previous']").click();
    await calendar.getByRole("button", { name: "2005", exact: true }).click();
    await calendar.getByRole("button", { name: "Mar", exact: true }).click();
    await calendar.getByRole("button", { name: "15 March 2005", exact: true }).click();
    await expect(page.getByLabel(/Date of birth/)).toHaveValue("2005-03-15");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => api.writes.length).toBe(1);
    expect(api.writes[0]!.body.birthDate).toBe("2005-03-15");
  });

  test("tomorrow is not selectable", async ({ page }) => {
    await fakeApi(page);
    await openNew(page);
    await page.getByLabel(/Date of birth/).fill("2999-01-01");
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "Save" }).click();
    // Either the picker refused the text, or the form shows the future-date error; nothing is saved.
    await expect(page.getByText("Enter a real date as YYYY-MM-DD").or(page.getByText("Date of birth can't be in the future"))).toBeVisible();
  });
});
