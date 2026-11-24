# Manual test plan: Patients feature

A checklist anyone can follow to confirm the app works as expected. It covers Phase 3 (patient list, search, create, edit, conflicts). Each step names the automated test that covers the same behavior, so you can see what is and isn't checked automatically. A dash means no automated test covers it. Add to this file as later phases add screens.

Test names are given as `file: "test title"`. Component tests are in `apps/web/test/`, browser tests in `apps/web/e2e/`, and API tests in `apps/api/test/`.

## Setup

**Automated tests** (run these first; all should pass)

```sh
bun run test        # API, shared and component tests
bun run test:e2e    # browser tests (needs Microsoft Edge installed)
bun run typecheck   # prints nothing when clean
```

**The app**, from the project root in two terminals:

```sh
bun apps/api/src/local.ts          # API on http://127.0.0.1:8787
cd apps/web && bunx vite           # web app on http://localhost:5173
```

If the API fails with `Failed to start server. Is port 8787 in use?`, an earlier copy is still running. Stop it with Ctrl+C in its terminal, or in PowerShell: `Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`. The same applies to port 5173 for the web app.

Your `.env` needs `FHIR_BASE_URL` and `CURSOR_KEY`, plus `FHIR_BEARER_TOKEN` if the server requires one. Never paste the token into chat, issues or screenshots.

Open <http://localhost:5173/patients>.

**Safe vs. writing:** sections 1 to 3 only read data and are safe on any server. Sections 4 and 5 **create and change patients on the FHIR server**. Run them only with the product owner's approval, and only with obviously fake patients (family name `ZZ-TEST` plus your initials) so they are easy to find and remove.

## 1. Patient list

| Check | Automated test |
| --- | --- |
| Opening `/patients` shows placeholder rows briefly, then a table with Name, Gender, Date of birth, Age and a pencil button on each row | list.test: "shows a loading state, then the rows" |
| There are no "Load more", "Next" or page buttons | patients.e2e: "fills the screen without any clicking, then loads more as you scroll" |
| Scrolling to the bottom loads more patients by itself (a small spinner shows while loading) | patients.e2e: same |
| At the very end the list says "N patients · end of list" and stops loading | patients.e2e: same |
| After scrolling a long way down, the earliest patients are no longer in the list. Scrolling back to the top brings them back immediately | patients.e2e: "only a window of rows is in the page, and scrolling back up restores earlier patients" |
| With a short browser window (about 400px high), the list scrolls inside its own frame, the column headers stay in place, and the page itself does not scroll | patients.e2e: "a short window scrolls inside the list, not the page" (header staying in place: –) |
| A patient with no date of birth shows "Not recorded", and a missing age shows "–" | list.test: "missing date of birth and age render as placeholders" |
| Stop the API and reload: a red "Couldn't load patients" box appears with a Retry button | list.test: "shows an error with Retry, and Retry reloads" (the "Can't reach the server" wording: api.test: "a network failure becomes a friendly error") |
| Restart the API and press Retry: the list loads | list.test: "shows an error with Retry, and Retry reloads" |
| Each response from the API is marked not to be cached | patients.test (API): "requests lean fields, one name= per word, and signs the next link" |
| Tampering with a page link in the address bar's API call is refused | patients.test (API): "rejects a tampered cursor with 400 and never calls upstream" |

## 2. Search

| Check | Automated test |
| --- | --- |
| Click the page background and press `/`: the cursor jumps to the header search box | search.test: "pressing / focuses the search, but not while typing in another field" |
| Click into another text field and press `/`: a slash is typed there and search does not take focus | search.test: same |
| Type a known surname quickly in one go: every letter stays in the box, and the address bar ends in `?q=` plus the full text | patients.e2e: "fast typing keeps every character and filters the list" (also search.test: "typing in the box shows the text and updates the URL…") |
| After about half a second the list narrows to matching patients | list.test: "a 2+ character search is sent to the API after the debounce" |
| A single letter does not change the list | list.test: "a single-character search is not sent as a name filter" |
| Several words (for example `ada lo`) must all match | patients.test (API): "requests lean fields, one name= per word, and signs the next link" |
| A name nobody has (for example `zzzzqq`) shows "No patients match “zzzzqq”" with a **Create patient** button | list.test: "shows a clear message and a Create patient button when nothing matches" |
| Browser Back returns to the previous search, with the box and list matching | search.test: "a URL change made elsewhere updates the box when it isn't focused" |
| Reloading with `?q=` in the address bar shows the same text in the box and a filtered list | search.test: same (the filtered list: list.test: "a 2+ character search…") |

## 3. Create and edit forms (without saving)

| Check | Automated test |
| --- | --- |
| **New patient**, then **Save** with nothing filled in: "Family name is required" and "Enter a real date as YYYY-MM-DD" appear under their fields, and the cursor lands in Family name | drawer.test: "submitting empty shows the errors and focuses the first bad field" |
| Clicking the Date of birth field opens a calendar showing years of the current decade | patients.e2e: "a date can be picked from the calendar (decade, year, month, day)" |
| Using the left arrow, then picking a year, month and day, fills the field as `YYYY-MM-DD` for the day you picked | patients.e2e: same |
| Future dates cannot be picked. Typing `2999-01-01` and pressing Save shows an error and the drawer stays open | patients.e2e: "tomorrow is not selectable" (the rule itself: shared tests in `packages/shared/test/patient.test.ts`; the API refusing it: patients.test (API): "create validates before touching upstream") |
| A patient's pencil (or name) opens the drawer with their given name, family name, gender and date already filled in | list.test: "clicking a name opens the edit drawer with that patient's values" |
| A patient whose date of birth is only a year (for example `1950`), if any exist, shows it in a plain text box rather than a calendar | drawer.test: "a partial existing date is a text field and saves unchanged" |
| On a server that gives no record versions, the drawer says "Conflict protection is unavailable on this server." | drawer.test: "a server with no version shows that conflict protection is unavailable" (needs such a server to check by hand) |

## 4. Saving (writes data; needs approval)

Use a fake patient such as `ZZ-TEST-AB`.

| Check | Automated test |
| --- | --- |
| New patient with given `Ada`, family `ZZ-TEST-AB`, gender Female, date `1815-12-10`: the drawer closes and "Patient created" appears. Searching `ZZ-TEST` finds the patient with the right age | drawer.test: "a valid form posts the typed values"; patients.e2e: "a date can be typed and is sent as YYYY-MM-DD". Against the real server: – |
| Editing that patient's given name and saving shows "Patient saved" and the list shows the new name | drawer.test: "saving sends the version the user opened". Against the real server: – |
| The patient's other details (identifiers, other names, extra data) are unchanged after an edit. Check on a patient that has them | patients.test (API): "edit preserves identifiers, extensions, other names and other tags". Against the real server: – |
| Saving, without changing anything, a patient whose date is only a year leaves the date as just the year | drawer.test: "a partial existing date is a text field and saves unchanged"; patients.test (API): "edit sends the opened version as If-Match and keeps an unchanged partial date" |
| A value the server rejects shows its message under the right field | drawer.test: "server field errors (422) appear on the right fields" |

## 5. Two people editing at once (writes data; needs approval)

| Check | Automated test |
| --- | --- |
| Open the fake patient's edit drawer in **two browser tabs**. Both show the same values | – |
| In tab A, change the given name and Save: "Patient saved" | – |
| In tab B, change the given name to something different and Save: a yellow box says "This record changed since you opened it" and shows the current values. The Save button is disabled | drawer.test: "a 409 shows the current values, blocks Save, and Reload refills the form"; patients.test (API): "stale version returns 409 with current values and does not write" |
| In tab B, click **Reload current values**: the form shows tab A's values and Save works again | drawer.test: same |
| Reload the list: the name is the one from tab A, not overwritten by tab B | patients.test (API): "stale version returns 409…" (no write is sent). Against the real server: – |
| If the server itself rejects the save as out of date, the same conflict box appears | patients.test (API): "server-side 412 also becomes the conflict response" |

## 6. Clean up

Delete every `ZZ-TEST` patient you created, using the FHIR server's own delete access. The app does not delete patients.

## Not covered by any automated test

Check these by eye when you change related code:

- Keyboard-only use and screen-reader labels.
- Light and dark appearance.
- The phone-width layout.
- Anything against the real FHIR server. All automated tests use a stand-in server, so a real run of sections 1 to 5 is the only check of the live connection, login token and real data.
