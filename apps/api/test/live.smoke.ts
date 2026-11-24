// Manual read-only smoke test: bun apps/api/test/live.smoke.ts  (not part of `bun test`)
import { envConfigProvider } from "../src/config.ts";
import { FhirClient } from "../src/fhir/client.ts";
import { nextLinkOf, signCursor, verifyCursor } from "../src/fhir/paging.ts";

const env = { FHIR_BASE_URL: "https://r4.smarthealthit.org", CURSOR_KEY: "x".repeat(40), ...process.env };
const config = envConfigProvider(env);
const { fhir, cursorKey } = await config.get();
const client = new FhirClient({ config });
const page1 = await client.get<any>("Patient?_count=3&_sort=family&_elements=name,gender,birthDate");
const next = nextLinkOf(page1.body);
console.log("page1 patients:", page1.body.entry?.length, "next link present:", !!next);
const cursor = await signCursor(next!, fhir.baseUrl, cursorKey);
const page2 = await client.get<any>(await verifyCursor(cursor, fhir.baseUrl, cursorKey));
console.log("page2 patients:", page2.body.entry?.length, "differs from page1:", page2.body.entry?.[0]?.resource?.id !== page1.body.entry?.[0]?.resource?.id);
