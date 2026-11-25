import { expect, test, type Page } from "@playwright/test";
import { fakeApi } from "./fake-api.ts";

const IDP = "https://idp.test";
const AUTHORITY = `${IDP}/pool`;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** The browser doesn't check the signature (the API Gateway authorizer does), so an unsigned id token is enough here. */
const idToken = () => {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none" })}.${b64({ iss: AUTHORITY, sub: "u1", aud: "web-client", iat: now, exp: now + 3600, email: "dr@example.com" })}.sig`;
};

/** A stand-in Cognito: discovery, the authorize redirect, and the token endpoint. */
async function fakeIdp(page: Page) {
  const seen = { authorizeCount: 0, authorize: undefined as URL | undefined, tokenBody: "", bearer: [] as (string | undefined)[] };
  await page.route("**/config.json", (r) => r.fulfill({ json: { authority: AUTHORITY, clientId: "web-client", hostedUiDomain: IDP } }));
  await page.route(`${AUTHORITY}/.well-known/openid-configuration`, (r) =>
    r.fulfill({
      json: {
        issuer: AUTHORITY,
        authorization_endpoint: `${IDP}/oauth2/authorize`,
        token_endpoint: `${IDP}/oauth2/token`,
        userinfo_endpoint: `${IDP}/oauth2/userInfo`,
      },
    }),
  );
  await page.route(`${IDP}/oauth2/authorize*`, (r) => {
    const url = new URL(r.request().url());
    seen.authorize = url;
    seen.authorizeCount++;
    // The user "logs in": go back to the app with a code and the same state.
    return r.fulfill({ status: 302, headers: { location: `http://localhost:5199/?code=abc&state=${url.searchParams.get("state")}` } });
  });
  await page.route(`${IDP}/oauth2/token`, (r) => {
    seen.tokenBody = r.request().postData() ?? "";
    return r.fulfill({ json: { id_token: idToken(), access_token: "access-123", token_type: "Bearer", expires_in: 3600, scope: "openid email profile" } });
  });
  return seen;
}

test.describe("login", () => {
  test("signs in with authorization code + PKCE, then sends the access token to the API", async ({ page }) => {
    const seen = await fakeIdp(page);
    const api = await fakeApi(page, 12);
    page.on("request", (req) => {
      if (req.url().includes("/api/patients")) seen.bearer.push(req.headers().authorization);
    });

    await page.goto("/patients");
    await expect(page.locator("tbody tr[data-index]").first()).toContainText("Person001");

    const q = seen.authorize!.searchParams;
    expect(q.get("client_id")).toBe("web-client");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBeTruthy();
    expect(q.get("redirect_uri")).toBe("http://localhost:5199/");
    expect(seen.tokenBody).toContain("grant_type=authorization_code");
    expect(seen.tokenBody).toContain("code_verifier=");

    expect(api.requests.length).toBeGreaterThan(0);
    expect(seen.bearer.every((b) => b === "Bearer access-123")).toBe(true);
    expect(page.url()).toBe("http://localhost:5199/patients"); // code and state removed, original page restored
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("tokens are never written to browser storage", async ({ page }) => {
    await fakeIdp(page);
    await fakeApi(page, 12);
    await page.goto("/patients");
    await expect(page.locator("tbody tr[data-index]").first()).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain("access-123");
  });

  test("an expired session (401) sends the user back to sign in", async ({ page }) => {
    const seen = await fakeIdp(page);
    await page.route("**/api/**", (r) => r.fulfill({ status: 401, json: { message: "Unauthorized" } }));
    await page.goto("/patients");
    // Sign in once, get a 401 from the API, and go round again: a second trip to the authorize endpoint.
    await expect.poll(() => seen.authorizeCount, { timeout: 10_000 }).toBeGreaterThan(1);
  });

  test("local development (no config.json) needs no login", async ({ page }) => {
    await fakeApi(page, 12);
    await page.goto("/patients");
    await expect(page.locator("tbody tr[data-index]").first()).toContainText("Person001");
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });
});
