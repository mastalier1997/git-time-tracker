<#
  install-outlook-task.ps1 — run the Outlook import automatically.

  Registers a Windows Scheduled Task that runs outlook-import.ps1 at logon and
  every hour while you're logged on, so meetings show up in the tracker with no
  manual action. (Outlook COM needs your interactive Windows session, so this
  can't run in Docker.)

    powershell -ExecutionPolicy Bypass -File install-outlook-task.ps1
    powershell -ExecutionPolicy Bypass -File install-outlook-task.ps1 -Uninstall
#>

param([switch]$Uninstall)

$TaskName = "TimeTracker Outlook Import"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'."
  return
}

$script = Join-Path $PSScriptRoot "outlook-import.ps1"
if (-not (Test-Path $script)) { Write-Error "outlook-import.ps1 not found next to this script."; exit 1 }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

# At logon, plus repeat every hour all day.
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$hourly  = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $atLogon, $hourly `
  -Settings $settings -Description "Import Outlook meetings into time-tracker" -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (runs at logon + hourly)."
Write-Host "It runs only while you're logged on. Remove with: -Uninstall"
