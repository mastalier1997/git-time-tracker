<#
  outlook-import.ps1 — import Outlook 2016 calendar meetings into time-tracker.

  Reads your local Outlook calendar via the desktop COM API (no cloud, no
  tokens, no Azure) and sends each meeting to the running web app, which stores
  it as a manual entry. Re-running is safe: meetings are keyed by a stable id
  and de-duplicated server-side. Deleted meetings are not re-added.

  Range: this week (Monday) up to the END OF TODAY — never future days.

  Usage:
    powershell -ExecutionPolicy Bypass -File outlook-import.ps1            # this week up to today
    powershell -ExecutionPolicy Bypass -File outlook-import.ps1 -Days 14   # last 14 days up to today

  Requires Outlook 2016 with a profile configured, and the web app running
  (docker compose up -d) so the API at http://localhost:8787 is reachable.
#>

param(
  [int]$Days = 0,
  [string]$ApiUrl = "http://localhost:8787"
)

$today = (Get-Date).Date
if ($Days -gt 0) {
  $from = $today.AddDays(-$Days)
} else {
  $offset = (([int]$today.DayOfWeek) + 6) % 7   # days since Monday (Mon=0)
  $from = $today.AddDays(-$offset)              # Monday 00:00 of this week
}
$to = $today.AddDays(1)                          # end of today — never future

# Log to the same file the web app reads (data/app.log), so failures are visible
# in the app's Logs view even though this runs on the host.
$logFile = Join-Path $PSScriptRoot "data\app.log"
function Log($level, $msg) {
  $line = ("{0} [outlook] {1} {2}`n" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), $level, $msg)
  try { [System.IO.File]::AppendAllText($logFile, $line, (New-Object System.Text.UTF8Encoding($false))) } catch {}
}
Log "INFO" ("run start, range {0}..{1}" -f $from.ToString('yyyy-MM-dd'), $today.ToString('yyyy-MM-dd'))

try {
  $ol = New-Object -ComObject Outlook.Application
} catch {
  Log "ERROR" "Could not start Outlook (is it installed / a profile configured / open?): $_"
  Write-Error "Could not start Outlook. Is Outlook 2016 installed and a profile configured?"
  exit 1
}
$ns  = $ol.GetNamespace("MAPI")
$cal = $ns.GetDefaultFolder(9)   # 9 = olFolderCalendar

$items = $cal.Items
$items.IncludeRecurrences = $true
$items.Sort("[Start]")
# Current-culture date format so Outlook's Restrict parses it on any locale.
# The hard guard in the loop is what actually bounds the range.
$filter = "[Start] >= '{0}' AND [Start] < '{1}'" -f $from.ToString('g'), $to.ToString('g')
$appts = $items.Restrict($filter)

$meetings = @()
foreach ($a in $appts) {
  if ($a.Start -lt $from -or $a.Start -ge $to) { continue }  # hard range guard (no future)
  if ($a.AllDayEvent) { continue }         # skip all-day blocks
  if ($a.BusyStatus -eq 0) { continue }    # skip events marked "Free"

  # Categorise meetings: "10BC" -> BB10, everything else -> ALLG.
  if ($a.Subject -match '10BC') { $ticket = 'BB10' } else { $ticket = 'ALLG' }

  $meetings += [PSCustomObject]@{
    id          = "ol_" + $a.EntryID + "_" + $a.Start.ToString("yyyyMMddHHmm")
    ticket      = $ticket
    description = $a.Subject
    start       = $a.Start.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.000Z")
    end         = $a.End.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.000Z")
    day         = $a.Start.ToString("yyyy-MM-dd")
    durationMs  = [int]$a.Duration * 60000
  }
  Write-Host ("  {0}  ({1} min)  {2}" -f $a.Start.ToString("yyyy-MM-dd HH:mm"), $a.Duration, $a.Subject)
}

if ($meetings.Count -eq 0) { Log "INFO" "no meetings in range"; Write-Host "No meetings in range."; return }

# POST to the app as UTF-8 (keeps umlauts intact). No JSON files are touched.
$json  = ConvertTo-Json @($meetings) -Depth 5
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
try {
  $resp = Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/import" -Body $bytes -ContentType "application/json; charset=utf-8"
  Log "INFO" ("imported {0} of {1} meeting(s)" -f $resp.added, $meetings.Count)
  Write-Host ("`nImported {0} of {1} meeting(s) into the tracker." -f $resp.added, $meetings.Count)
} catch {
  Log "ERROR" "API POST to $ApiUrl/api/import failed (is the Docker app running?): $_"
  Write-Error "Could not reach the tracker API at $ApiUrl. Is 'docker compose up -d' running?  $_"
  exit 1
}
