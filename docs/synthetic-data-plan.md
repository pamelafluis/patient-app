# Synthetic data plan

Part of [plan.md](plan.md), phase 6 (build and load) and phase 7 (test against it).

## Goal

A repeatable, tagged synthetic dataset on the FHIR server that covers every mapping rule in plan.md section 2, with the expected result for each case written down so tests can assert it. Synthetic data only; no real patient data.

## Starting point

The target server (the one in `.env`) is a private, already-provisioned FHIR server. It already holds a Synthea-generated population, loaded earlier by POSTing each Synthea output file (hospital and practitioner bundles first, then the patient bundles) as a transaction to the base URL with a bearer token. That data is **untagged**, and it is the baseline. This plan does not regenerate or reload it. It audits the baseline, then adds only what is missing.

Because this server accepts transaction bundles, the loader can use them (the earlier finding that only Firely advertises `batch` applied to the public servers).

Keep the server base URL and token in `.env` only. The base URL contains a secret path segment, so it must not appear in docs, scripts or commits either.

## Pipeline

Bun scripts in `scripts/seed/`. Nothing generated is committed.

1. **Audit (read-only).** Query the existing data against the case matrix and record which cases the baseline already covers (for example, patients whose latest BP sits at each boundary, or with `MedicationStatement`s). Output: a coverage report listing covered and missing cases, with the ids of patients that already serve as examples.
2. **Augment.** For each missing case, build the resources. Where possible, add them to existing baseline patients (new Observations, Conditions and so on) rather than creating new patients. Cases that need a specific patient state (missing name, partial birth date, several names) get new patients. Every injected resource has a stable id.
3. **Tag.** Every *new* resource carries `meta.tag` `patient-app-synthetic` plus a run id. Baseline resources stay untouched, so cleanup removes only what we added.
4. **Load.** Send transaction bundles, with `If-None-Exist` or conditional updates on the stable ids so reruns don't duplicate. Respect 429 with retry. Dates are relative to the run date.
5. **Manifest.** `expected.json` records, for each case, the patient id and what the app must show: latest BP, status, listed conditions and medications, and so on. Baseline patients used as examples are included with their audited values.
6. **Cleanup.** Delete everything carrying the tag.

Only if the audit shows the baseline is too small or too uniform for paging and search cases, regenerate more patients with Synthea (needs Java 17+; pin the version, fixed seed, FHIR R4, hypertension module on) and load them tagged.

## Case matrix

"Native" means Synthea produces it; "injected" means the augment step adds it.

| Area | Cases | Source |
|---|---|---|
| Names and demographics | Missing name; multiple names (official, usual, old); given name only; each of the four genders; partial birth date (year, year-month); missing birth date; age 100+; newborn | Injected |
| Vitals | BP panel `85354-9` and `55284-4` with components; heart rate, temperature, respiration; both SpO₂ codes; temperature in °F and °C; unknown unit (shown as recorded); raw float values; newest reading `entered-in-error` or `cancelled`; vital missing from page 1 with a next page; several BPs on one day (lowest systolic and diastolic win); 2021-era readings; no BP at all | BP, heart rate, temperature, respiration native; the rest injected |
| Conditions | Active, recurrence, relapse, resolved, inactive, `refuted`, `entered-in-error`; hypertension coded SNOMED `59621000`, `38341003` and ICD-10 `I10` | Mixed |
| Medications | Active `MedicationRequest` with drug included; patient with `MedicationStatement` only; patient with both; stopped and completed excluded | Requests native; Statements injected |
| Full history | Allergies, encounters, procedures, immunizations, resolved conditions | Native |
| Edit safety | Patient with identifiers, extensions and several names; server that returns no `meta.versionId` | Injected; the no-version case stays in the mock server if the target server always sets versions |
| Paging and search | Several pages of patients; shared family names; apostrophes, hyphens and diacritics; a search with no match | Native plus injected names |
| BP worklist | Latest BP at 139/89, 140/90, 179/119, 180/120; confirmed no BP in 12 months; many readings to force truncation; hypertension patient outside ages 18-85 | Injected |

## Limits and open decisions

- Synthea can't create odd or malformed resources, so the augment step does the real work for edge cases.
- Some cases stay in mock-server tests because a real server can't be made to produce them: 429, timeouts, expired cursors, no version.
- **Baseline is untagged**, so we can't delete it selectively and shouldn't modify it beyond adding tagged resources. If the server is ever reset, rerun the original Synthea load, then the augment step.
- **Server limits are unknown** (transaction size, whether `meta.versionId` is set, rate limits, token expiry). The audit step records them.
- **Writes need product owner approval** (plan.md section 5), including the augment load, even though the server is the project's own.
- **Dates.** Generate relative to the run date so "last 12 months" stays valid, or set `DEMO_AS_OF`.

## Testing against it (phase 7)

For each case in `expected.json`, assert the API output with a `bun test` integration suite and the key UI states with Playwright, locally and then deployed. A mismatch is a bug in the mappers, not a reason to edit the data.
