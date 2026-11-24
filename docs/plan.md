# Patient app on FHIR: UI and technical design

## Context

Patient app is a practitioner-facing web app over a public FHIR server. Practitioners list, search, create and edit patients and view a clinical chart. It also includes one add-on with product potential. It must use Mantine, Bun and Lucide, and run on AWS for little or nothing.

**Status:** plan approved 2026-11-24. Phases 1 and 2 done. Phase 3 (patients) built and verified with mocks and live read-only checks; the live write check is waiting on product owner approval. Phase 4 (chart) built and verified with mocks, a browser run and a live read-only check on SMART Health IT; it is uncommitted pending approval.

**Decisions**

| Topic | Choice |
|---|---|
| FHIR URL and bearer token | Configurable, held server-side. `.env` locally, SSM Parameter Store on AWS |
| Access | Cognito login |
| Add-on | Blood pressure (BP) control worklist |
| Order of work | Mockup and this plan, **review by the product owner**, then build |

**Measured on 2026-11-24** (HAPI, SMART Health IT and Firely public R4 servers; GET requests and CORS preflights only)

| Finding | Design response |
|---|---|
| HAPI and SMART left `If-Match` out of the CORS headers they allowed. SMART allowed `Authorization`; HAPI answered 403 to a preflight asking for both headers | Server-side proxy; also keeps the token out of the browser |
| `$lastn` failed on HAPI and SMART; Firely accepted it but returned no results for the one patient tried. `$everything` returned 200 on all three, but pulled mostly unneeded data on HAPI and SMART (Firely's payload not reviewed) | Targeted parallel queries; choose the latest reading in our code |
| Only Firely advertises `batch` | Parallel GETs, no batch dependency |
| Searches returned no total on HAPI, and only sometimes on SMART; `next` links are opaque | Cursor paging, no page numbers |
| `_elements` cut a 20-patient SMART page from 126 KB to 24 KB | Always use it on lists |
| One HAPI patient had 3 MedicationStatements and 0 MedicationRequests | Query both types |
| A 10-patient BP query on SMART took 4.0 s, covered 9 patients and had another page | Never label a patient "overdue" from a truncated result |
| Newest BP in that SMART sample is from 2021; 2 of 9 HAPI and Firely patients had any BP | Show reading dates, optional demo "as of" date, optional seed data |

## 1. UI design

**Rule: two clicks or fewer to any common task.** Search is always in the header (`/` focuses it). No PHI in `localStorage`.

**Routes:** `/patients` (home), `/patients/:id`, `/worklist/bp`, plus the login callback. Create and edit are drawers over the current page, so context isn't lost. Patient ID, search text and tab live in the URL so Back and refresh work.

### Patients
```
┌──────────────────────────────────────────────────────────────────┐
│ ♥ Patients   BP worklist    [🔍 Search patients by name   / ]  PF▾│
├──────────────────────────────────────────────────────────────────┤
│ Patients                                        [+ New patient]  │
│ Name ▲               Gender     Date of birth     Age            │
│ Adams, Daniel X.     Male       1925-12-23        100        ✎   │
│ Unnamed patient      Unknown    Not recorded      –          ✎   │
│ ...                                                              │
│ 20 loaded                                    [Load more]         │
└──────────────────────────────────────────────────────────────────┘
```
- Click a row to open the chart; ✎ opens the edit drawer without leaving the list.
- Hovering a row for 150 ms prefetches the chart.
- States: skeleton rows, no match (offers "Create patient"), server error with Retry, expired cursor (restarts at page 1 with a notice).

### Patient chart
```
┌──────────────────────────────────────────────────────────────────┐
│ ← Patients    Adams, Daniel X.   Male · 1925-12-23 · 100 y [Edit]│
│ ┌ BP ──────┐┌ Heart ───┐┌ Temp ────┐┌ Resp ────┐┌ SpO₂ ────┐     │
│ │148/92 ▲  ││ 76 /min  ││ 37.0 °C  ││ 14 /min  ││ 97 %     │     │
│ │2 Nov 2026││2 Nov 2026││ 3y ago ⚠ ││2 Nov 2026││No reading│     │
│ └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘     │
│ Active conditions (3)          Active medications (4)            │
│ Hypertension   since 2019      Lisinopril 10 mg daily  Prescribed│
│ Type 2 diabetes               Aspirin 81 mg            Reported  │
│ [Summary] [Vitals trends] [Full history]                         │
└──────────────────────────────────────────────────────────────────┘
```
- Demographics, all five vitals, active conditions and active medications fit on one screen with no extra clicks.
- Click a vital for its trend. "Full history" loads on demand: resolved conditions, past medications, allergies, encounters, procedures, immunizations.
- Each section loads and fails independently. "None recorded" and "Couldn't load" never look alike.
- Values pair color with icon or text. Old readings always show their age.

### Create and edit drawer
Given name, family name, gender (four-option segmented control) and date of birth. Errors are inline and focus moves to the first one. A save conflict shows "This record changed since you opened it", with the current values and a Reload option.

### BP worklist
```
│ [Review now 2] [Above goal 14] [Overdue 9] [Unknown 1] [At goal 30]│
│ Ranked within the 56 patients loaded · as of 24 Nov 2026          │
│ Adams, Daniel   184/122  2 Nov   Review now   [Create follow-up]  │
│ Brown, Ana      152/94   9 Oct   Above goal   [Create follow-up]  │
│ Cruz, Leo       No BP in 12 months  Overdue   [Create follow-up]  │
```
- "Create follow-up" opens an editable draft and writes a FHIR `Task` only after the practitioner confirms.

**Look:** calm neutral surfaces, one teal accent; red and amber reserved for clinical status. Light and dark, WCAG AA, keyboard operable, tablet width and up with a stacked phone layout.

## 2. Technical design

```
Browser (React SPA) ──HTTPS──> CloudFront ─┬─ /*     → private S3 (OAC)
   │  login (PKCE)                         └─ /api/* → API Gateway HTTP API
   └──> Cognito managed login                          │ JWT authorizer
                                                       ▼
                          Lambda (Hono, nodejs24.x, arm64) ──> FHIR R4 server
                                  └─ SSM: base URL, token (SecureString)
```

**Stack:** Bun workspaces, package manager and test runner; Vite, React 19, TypeScript, Mantine 9 (core, form, hooks, notifications, charts), Lucide, TanStack Query, React Router, `react-oidc-context`, Zod, Hono, AWS CDK (TypeScript).
- The same Hono app runs under Bun locally and the managed Node runtime on Lambda. AWS has no managed Bun runtime, and a custom one would mean patching it ourselves.
- Same-origin `/api` avoids CORS preflights. HTTP API rather than a CloudFront-signed function URL, which needs the browser to hash every write body.
- A CloudFront Function rewrites app routes to `index.html`. Distribution-wide error pages aren't used, since they would turn API 403/404s into HTML.

**Layout**
```
apps/web/src/{routes,features/{patients,chart,worklist},lib}
apps/api/src/{app,local,lambda}.ts, config.ts, fhir/{client,paging}.ts,
             mappers/{patient,vitals,condition,medication}.ts, routes/, worklist/bp.ts
packages/shared/src/   Zod schemas, view-model types, LOINC and code constants
infra/                 CDK stack     docs/plan.md
```

### Configuration
| Setting | Local `.env` (gitignored) | AWS |
|---|---|---|
| FHIR base URL | `FHIR_BASE_URL` | `/patient-app/fhir/base-url` (String) |
| Bearer token, optional | `FHIR_BEARER_TOKEN` | `/patient-app/fhir/token` (SecureString) |
| Cursor signing key | `CURSOR_KEY` | `/patient-app/cursor-key` (SecureString) |
| Demo date, optional | `DEMO_AS_OF` | Lambda environment variable |

- The deployer sets parameters with the AWS CLI, outside CDK, so the token never enters Git, the template or the JS bundle. `.env.example` has placeholders only.
- Lambda caches values for 5 minutes. An upstream 401 forces one config reload and one retry; then the UI shows "FHIR credentials rejected". Changing servers or tokens needs no redeploy.
- Only HTTPS base URLs (localhost excepted in development). A blank token sends no `Authorization` header. Redirects are not followed, so the token can't leave the configured host.
- `TokenProvider` interface leaves room for SMART Backend Services later.

### API
| Endpoint | FHIR calls |
|---|---|
| `GET /api/patients?name=&cursor=` | `Patient?_elements=name,gender,birthDate&_sort=family&_count=20`, plus one `name=` per word |
| `POST /api/patients` | `POST Patient` |
| `GET` / `PUT /api/patients/:id` | Read; or read, merge and `PUT` with `If-Match` |
| `GET /api/patients/:id/summary` | Patient, vitals, conditions, medications in parallel with per-section status |
| `GET /api/patients/:id/vitals/:kind` | One vital's history, cursor-paged |
| `GET /api/patients/:id/history/:section` | One history type, cursor-paged |
| `GET /api/worklist/bp?cursor=` | See Add-on |
| `POST /api/worklist/bp/tasks` | `POST Task` with `If-None-Exist` to prevent duplicates |

**Paging:** upstream `next` links must match the configured origin and base path, then become HMAC-signed cursors. Unsigned or altered cursors get 400.

**Safe edits:** start from the full current resource and change only name, gender and date of birth, so identifiers, extensions and other names survive. Send the version the user opened; 409/412 becomes the conflict screen. If a server supplies no version, the save proceeds and the UI says conflict protection is unavailable.

**Clinical mapping**
| Data | Rule |
|---|---|
| BP | Panel `85354-9` or `55284-4`, components `8480-6` and `8462-4` |
| Heart rate, temperature, respiration | `8867-4`, `8310-5`, `9279-1` |
| SpO₂ | `59408-5` or `2708-6` |
| Vitals query | One combined query, newest first; if a vital is missing and there is a next page, query that vital alone with `_count=5` (not 1, so a cancelled newest entry can't hide the real latest). Blood pressure is shown in whole mmHg and other values to one decimal, because some servers store raw floats |
| Observations | Exclude `entered-in-error` and `cancelled`; convert units only from known UCUM codes, otherwise show as recorded |
| Conditions | `active,recurrence,relapse`; exclude `refuted` and `entered-in-error` |
| Medications | Active `MedicationRequest` (with `_include` of the drug) and active `MedicationStatement`, labelled Prescribed or Reported; never silently merged |

**Validation** (shared Zod schemas, enforced in browser and API)
- Family name required; gender one of `male`, `female`, `other`, `unknown`.
- Date of birth required, a real date, not in the future. The browser uses the user's local date; the API allows for the furthest-ahead time zone.
- Existing records with partial dates or missing names display correctly, and unchanged partial dates are preserved.

**Performance:** debounced search (300 ms, 2+ characters, stale requests cancelled), in-memory caching, hover prefetch, per-request timeouts, bounded concurrency, GET-only retries for 429/503, route-level code splitting. Target: list and summary under 1.5 s at p95 when the FHIR server answers within 1 s.

**Security:** Cognito with self-signup off, PKCE, MFA optional; tokens in memory. JWT authorizer checks issuer, app client and scope. Local auth bypass refuses to start on Lambda. `Cache-Control: no-store` on API responses, CSP, no query strings, bodies or tokens in logs, 7-day log retention, throttling. IAM limited to the three parameters.

**Synthetic data only.** Public FHIR servers are open to others. Real patient data would need an AWS BAA, a private FHIR server, audit logging and a compliance review.

## 3. Add-on: BP control worklist

**Problem:** patients with hypertension fall out of follow-up, and practices paid on quality only discover it late. **Buyer:** value-based primary care groups and remote-monitoring vendors. **Why it fits:** it uses data we already load, and follow-ups are stored as FHIR Tasks, so no database.

1. Page active conditions coded SNOMED `59621000`, `38341003` or ICD-10 `I10`, with `_include=Condition:patient`; deduplicate patients. These queries returned data on all three servers.
2. Fetch recent BPs for 10 patients per query, with `_elements`, following pages up to a cap. Query any uncovered patient individually before labelling them.
3. Classify the latest BP, using the lowest systolic and diastolic from that day:

| Status | Rule |
|---|---|
| Review now | ≥180 systolic or ≥120 diastolic |
| Above goal | ≥140 or ≥90 |
| Overdue | Confirmed no BP in 12 months |
| Unknown | Query failed or incomplete |
| At goal | Below 140 and below 90 |

- The 140/90 threshold and ages 18–85 follow the HEDIS CBP measure as described by health plans. This is **not a certified measure**: exclusions such as ESRD, dialysis and pregnancy, and inpatient/ED readings, aren't handled in v1.
- The screen says it supports, and doesn't replace, clinical judgment. Thresholds need clinician review before real use.
- v1 ranks only loaded patients and says so. **Next:** nightly whole-panel scan, certified measure logic, EHR launch (SMART), patient messaging, monitoring billing support (the 2026 rule added CPT 99445 and 99470; check 2027 rates).

## 4. AWS cost

| Service | Expected demo cost |
|---|---|
| CloudFront (1 TB, 10M requests free monthly) | $0 |
| Cognito (10,000 monthly users free) | $0 |
| Lambda, SSM standard parameters, CloudWatch | $0 within free allowances |
| API Gateway HTTP API | About $1 per million calls |
| S3 | Pennies |

**Expected total: under $1 a month.** Confirm current API Gateway pricing before deploying. Caveat: a new account on the AWS *Free plan* closes after 6 months or when credits run out, unless upgraded. The stack includes a $5 budget alert, no NAT gateway, VPC or always-on servers.

## 5. Work plan

1. **Design (first deliverable):** clickable mockup of all screens and their error and empty states using synthetic data, as a private artifact; this plan in `docs/plan.md`. **Stop for product owner review.**
2. **Foundation:** install Bun, workspaces, shared schemas, FHIR client, paging, config.
3. **Patients:** list, search, create, edit, conflicts.
4. **Chart:** summary, trends, full history.
5. **BP worklist:** scan, classification, Task follow-ups.
6. **Deploy:** CDK stack, Cognito, parameters, README with deploy and teardown steps. Any AWS deployment, write to a public FHIR server, or commit needs the product owner's approval first.

Each phase ends with a working, tested app.

## 6. Verification

- **Unit (`bun test`):** dates and time zones, gender, name selection, unit conversion, mappers, BP boundaries (139/89, 140/90, 180/120), truncated results never producing "Overdue", merge preserving unknown fields, cursor tampering, foreign `next` links, token never in responses or logs.
- **API against a mock FHIR server:** 401 reload, 412 conflict, 429, timeout, one failed section, missing totals, expired cursor, blank token.
- **Live read-only checks:** all three public servers, then the target server and token.
- **Write check, with approval:** create a tagged synthetic patient, edit, force a conflict from two tabs, confirm untouched fields survive, then delete it.
- **Browser (Playwright):** login, search to chart in two clicks, form errors, conflict, worklist to Task, keyboard-only use, accessibility scan, light and dark.
- **Deployed:** deep-link refresh works, `/api` without login returns 401, S3 isn't public, bundle contains no token, changing the SSM URL takes effect without a redeploy.

**Open inputs, needed before phase 3:** the FHIR server URL, whether writes are allowed, and how the token is issued and expires. Keep the token in `.env` only; never commit it or paste it into chat or issues.

## Sources

[CloudFront FAQ](https://aws.amazon.com/cloudfront/faqs/) · [Cognito pricing](https://aws.amazon.com/cognito/pricing/) · [HTTP API cost](https://docs.aws.amazon.com/whitepapers/latest/best-practices-api-gateway-private-apis-integration/cost-optimization.html) · [AWS Free Tier FAQ](https://aws.amazon.com/free/faqs/) · [Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html) · [Mantine 9](https://mantine.dev/changelog/9-0-0) · [CBP measure, Oregon 2026](https://www.oregon.gov/oha/HPA/ANALYTICS/CCOMetrics/2026-Controlling-High-Blood-Pressure-2025.12.31.pdf) · [CBP same-day readings](https://www.amidacareny.org/wp-content/uploads/CBP-AC-1sheets-2026-QualityMeasureBestPractices-V5.pdf) · [2026 fee schedule](https://www.cms.gov/files/document/mm14315-medicare-physician-fee-schedule-final-rule-summary-cy-2026.pdf) · [2027 monitoring changes](https://www.nixonpeabody.com/-/media/files/alerts/2026/11/cms_finalizes_2027_medicare_rpm_rtm_changes.pdf)
