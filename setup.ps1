<#
  setup.ps1 - one-command setup for time-tracker (Windows).

  Does everything a new user needs:
    1. checks git / node / docker
    2. verifies you have a git identity (never sets or changes it)
    3. installs the global commit hook (tracks every repo)
    4. optionally configures Jira (writes a git-ignored .env)
    5. builds & starts the Docker web app
    6. optionally schedules the automatic Outlook meeting import

  Usage:
    powershell -ExecutionPolicy Bypass -File setup.ps1
    powershell -ExecutionPolicy Bypass -File setup.ps1 -NoStart   # skip docker build/start
#>

param([switch]$NoStart)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function ok($m)   { Write-Host "  ok  $m" -ForegroundColor Green }
function step($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function warn($m) { Write-Host $m -ForegroundColor Yellow }

Write-Host "`n=== time-tracker setup ===" -ForegroundColor Cyan

# 1. prerequisites -----------------------------------------------------------
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { warn "x  git not found. Install Git first."; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { warn "x  Node.js not found. Install Node first."; exit 1 }
$dockerOk = [bool](Get-Command docker -ErrorAction SilentlyContinue)
ok "git and node found"

# 2. git identity - verified, never modified ---------------------------------
$name  = git config --global user.name
$email = git config --global user.email
if (-not $name -or -not $email) {
  warn "`nx  Your global git identity is not set. time-tracker never changes it."
  Write-Host '   Set it yourself, then re-run setup:'
  Write-Host '     git config --global user.name  "Your Name"'
  Write-Host '     git config --global user.email "you@example.com"'
  exit 1
}
ok "git identity: $name <$email>  (left unchanged)"

# 3. global commit hook ------------------------------------------------------
step "Installing the global commit hook (every repo, now and future)..."
node "$root\track.js" hook-install-global
ok "commit hook active"

# 4. Jira (optional) ---------------------------------------------------------
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  step "Jira: .env already exists - leaving it untouched."
} else {
  step "Jira integration (optional, read-only). Press Enter to skip."
  $jiraUrl = (Read-Host "  Jira base URL (e.g. https://jira.example.com)").Trim()
  if ($jiraUrl) {
    $sec = Read-Host "  Jira Personal Access Token" -AsSecureString
    $tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    $content = "JIRA_BASE_URL=$jiraUrl`nJIRA_TOKEN=$tok`n"
    [System.IO.File]::WriteAllText($envFile, $content, (New-Object System.Text.UTF8Encoding($false)))
    ok "wrote .env (git-ignored - your token stays local)"
  } else {
    Write-Host "  skipped Jira."
  }
}

# 5. build & start the web app ----------------------------------------------
if ($NoStart) {
  step "Skipping Docker start (-NoStart). Later:  docker compose up -d --build"
} elseif ($dockerOk) {
  step "Building & starting the web app (first run takes a few minutes)..."
  Push-Location $root
  try { docker compose up -d --build } finally { Pop-Location }
  ok "web app running at http://localhost:8787"
} else {
  warn "`n!  Docker not found. Install Docker Desktop, then:  docker compose up -d --build"
}

# 6. Outlook meeting import (optional) --------------------------------------
step "Outlook meeting import: a scheduled task runs it at logon + hourly."
$ans = Read-Host "  Set it up now? (y/N)"
if ($ans -match '^(y|yes)$') {
  & "$root\install-outlook-task.ps1"
} else {
  Write-Host "  skipped. Later:  powershell -ExecutionPolicy Bypass -File install-outlook-task.ps1"
}

Write-Host "`n=== done ===" -ForegroundColor Cyan
Write-Host "Open http://localhost:8787 . Commit with a ticket id (e.g. `"PM-123 fix login`"); set the time in the UI."
Write-Host "Uninstall tracking later:  node `"$root\track.js`" hook-uninstall-global"
