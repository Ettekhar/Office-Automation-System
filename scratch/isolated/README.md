# Isolated write-path verification (no network, no live data)

`verify-writeback.mjs` exercises the **real** assign → append → persist → audit
code path from `src/` against a **fake** Sheets layer, in a throwaway copy of the
app. It needs the copy because importing the real `src/sheets.js` would talk to
Google, and the point is to test the *writes* without touching the live sheet.

`sheets.fake.js` reproduces the real Daily Review per-user tab shape — including
both traps that broke the old header-based matcher:

```
header  = [" ", "Website", "Maintenance", ..., "Booking / Reservstion Link"]
col 0   = website domains   (header is a blank placeholder)
col 1   = account labels    (titled "Website", but holds "CW"/"RM", NOT domains)
last col= booking/reservation links (classify as a url)
```

## Run it

```powershell
$src  = "C:\Users\toufi_qicjadj\Downloads\maintenance-mailer"
$tmp  = "$env:LOCALAPPDATA\Temp\opencode\mm-wb-offline"

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Copy-Item "$src\src"       -Destination "$tmp\src"       -Recurse -Force
Copy-Item "$src\data"      -Destination "$tmp\data"      -Recurse -Force
Copy-Item "$src\package.json" -Destination "$tmp\package.json" -Force
Copy-Item "$src\node_modules" -Destination "$tmp\node_modules" -Recurse -Force
Copy-Item "$src\package-lock.json" -Destination "$tmp\package-lock.json" -Force -ErrorAction SilentlyContinue

# swap the real Sheets layer for the fake
Copy-Item "$src\scratch\isolated\sheets.fake.js"  -Destination "$tmp\src\sheets.js" -Force
Copy-Item "$src\scratch\isolated\verify-writeback.mjs" -Destination "$tmp\verify-writeback.mjs" -Force

cd $tmp
node verify-writeback.mjs
```

Expected: **29 passed, 0 failed** — repeatable on the same store (the audit
assertion measures a *delta*, since the audit log is append-only).

## What it proves

| | Assertion |
|---|---|
| A | one row appended per new assignee; URL in the resolved column; the `"Website"` label column and all checklist cells untouched |
| B | `rowIndex` + `sourceTab` + `sourceRow` + `sheetSpreadsheetId` persisted on the daily-review record |
| C | audit entry written with old → new `rowIndex`, actor and source |
| D | re-assigning the same user is idempotent — no second row, same row number |
| E | Medul resolves column 1 (`"Website URL"`), not column 0 |
| F | unassign **keeps** the row (soft remove), deletes nothing, and **flags** the missing marker column as a `policy: 'manual'` conflict |
| G | a forced Sheets failure leaves the DB assignment intact, reports the failure, and records a conflict |

The copy's `data/` is a disposable snapshot; the live `data/` is never opened for
writing by this harness.
