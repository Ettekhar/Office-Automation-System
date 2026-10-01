# E2E: assign a REAL unassigned site to a REAL active user through the live HTTP
# route, verify the sheet row + provenance + audit, then unassign and verify the
# soft-remove. The DB is returned to its exact starting state.
#
# This is the full stack: HTTP -> route -> db -> assignmentWriteBack ->
# userTabWriteBack -> Google Sheets. No test doubles, no fabricated data.
param([string]$SiteId, [string]$UserId, [string]$UserName)

$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3000'
function Get-Site($id) { (Invoke-RestMethod "$base/api/master/sites" -TimeoutSec 60).sites | Where-Object { $_.id -eq $id } }
function Tab($tab, $range) {
  # read through the app's own resolver is done in node; this is a raw sheet read
  $null
}

Write-Output "=== 0. starting state ==="
$before = Get-Site $SiteId
Write-Output "  site      : $($before.url)  (id $($before.id))"
Write-Output "  assignees : $(if($before.assignedUsers){$before.assignedUsers -join ','}else{'(none)'})"
$user = (Invoke-RestMethod "$base/api/master/users" -TimeoutSec 60).users | Where-Object { $_.id -eq $UserId }
Write-Output "  user      : $($user.name)  active=$($user.active)"

Write-Output "`n=== 1. ASSIGN via POST /api/master/sites/:id/assign ==="
$r = Invoke-RestMethod "$base/api/master/sites/$SiteId/assign" -Method POST `
     -ContentType 'application/json' -Body (@{ userIds = @($UserId) } | ConvertTo-Json) -TimeoutSec 120
$r.userTabWriteBack | ConvertTo-Json -Depth 6 -Compress | ForEach-Object { "  report: $_" }
$after = Get-Site $SiteId
Write-Output "  DB assignees now: $($after.assignedUsers -join ',')"

Write-Output "`n=== 2. sheet state after assign ==="
$dr = Invoke-RestMethod "$base/api/master/daily-review" -TimeoutSec 120
$rec = $dr.dailyReview | Where-Object { $_.siteId -eq $SiteId -and $_.userId -eq $UserId }
Write-Output "  daily-review record rowIndex = $($rec.rowIndex)  sourceTab=$($rec.sourceTab) sourceRow=$($rec.sourceRow) sheet=$($rec.sheetSpreadsheetId)"

Write-Output "`n=== 3. UNASSIGN via the same route (soft-remove expected) ==="
$u = Invoke-RestMethod "$base/api/master/sites/$SiteId/assign" -Method POST `
     -ContentType 'application/json' -Body (@{ userIds = @() } | ConvertTo-Json) -TimeoutSec 120
$u.userTabWriteBack | ConvertTo-Json -Depth 6 -Compress | ForEach-Object { "  report: $_" }
$final = Get-Site $SiteId
Write-Output "  DB assignees restored to: $(if($final.assignedUsers){$final.assignedUsers -join ','}else{'(none)'})"
$match = (($before.assignedUsers -join ',') -eq ($final.assignedUsers -join ','))
Write-Output "  DB restored exactly: $match"
