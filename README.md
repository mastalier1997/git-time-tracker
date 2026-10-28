# time-tracker

Lightweight time tracking that turns your git history into a time log, with a
web dashboard for reviewing and adjusting it. Two ways to capture time:

1. **Automatic from git** — a `post-commit` hook records every commit and reads
   the ticket id from the message (e.g. `PM-2393`, `PROJ-123`, `#42`). Commits
   are logged with **no duration**; you set the actual time per ticket/day in the
   web UI. Your commit history becomes the skeleton of your timesheet.
2. **Manual** — add entries or run a start/stop timer in the web UI (or the CLI)
   for non-code work like meetings.

The host side is dependency-free (just Node.js). The web app runs in one Docker
container.

## Quick start

### Windows (recommended): one guided command

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

`setup.ps1` walks you through the whole thing: checks git/node/docker, installs the
global commit hook, optionally configures Jira (writes a git-ignored `.env`), builds
and starts the Docker web app, and optionally schedules the automatic Outlook
meeting import. Pass `-NoStart` to skip the Docker build.

### Cross-platform (git hook + Docker only)

```bash
node setup.js          # install the global commit hook
node setup.js --start  # also build & start the web app
```

Then open http://localhost:8787.

### What setup does

- Checks `git` and `node` are installed.
- **Verifies you have a git identity set - and never changes it** (see below).
- Installs git's global `core.hooksPath` pointing at this repo's `git-hooks/`.
  The hook chains to any repo-local `post-commit` hook (husky etc.), so existing
  hooks keep working.
- Builds/starts the web app (`setup.ps1` always asks; `setup.js` with `--start`).
- `setup.ps1` also handles Jira `.env` and the Outlook scheduled task in one go.

## Your commit author is never touched

time-tracker **only reads** commit metadata — it never sets or rewrites
`user.name` / `user.email`, and the hook cannot change who authored a commit.
`setup.js` refuses to run until *you* have configured your own identity:

```bash
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

If you use different identities per project (e.g. work vs. personal), configure
that yourself with git's conditional includes — time-tracker stays out of it:

```gitconfig
[includeIf "gitdir:~/work/"]
    path = ~/.gitconfig-work
```

## The commit workflow

1. Work as usual. Put the ticket id in your commit message:
   `git commit -m "PM-2393 fix login redirect"`.
2. The hook logs that commit under project `PM`, ticket `PM-2393`, with 0 time.
3. In the web UI, set the hours/minutes you actually spent (per ticket, per day).

Ticket detection scans the commit message for the first of:

- JIRA-style ids: `PM-2393`, `PROJ-123`, `ABC-7`
- GitHub-style refs: `#42`

The **project** is the part before the first `-` (`PM-2393` → `PM`), used for
filtering and grouping.

## Web dashboard

`docker compose up -d --build`, then http://localhost:8787.

- **Week / month / all-time views** with prev/next navigation.
- **KPI cards**: range total, % of target, daily average, and a **running
  flex-time ledger** (banked over/under target, accumulated across weeks).
- **Work-week settings**: choose which days are work days, set a weekly target
  (daily is derived), and pick entries-per-page. Open with the Settings button.
- **Hours-per-day chart**: one bar per selected work day, **stacked by project**
  with a dashed target line.
- **Time-by-project** breakdown with hours and % of the range.
- **Entries** grouped by date, with same-ticket commits collapsed into one row;
  edit time as hours + minutes in a modal; copy a description; delete any entry;
  paginated. Tick rows to **bulk-edit** (set time/ticket) or **bulk-delete**.
- **Start/stop timer** and a **manual entry** form that also books a **date range**
  (workdays-only optional), plus a one-click **Add holiday** that fills the day with
  your average hours per workday (label configurable in Settings).
- **Activity heatmap** — a GitHub-style year view.
- **CSV export** of the current range.

The container uses `restart: unless-stopped`, so it comes back automatically
whenever Docker starts (set Docker Desktop to launch on login). Stop with
`docker compose down`; logs with `docker compose logs -f`.

### How storage works

- The hook writes commits to `data/entries.json` (no dependencies, works even
  when Docker is off).
- The backend imports those into a **SQLite** database (`data/tracker.db`) — a
  real, queryable DB that's a single file, no server. Manual entries, edits, and
  deletions live there too. Deletions are remembered so re-import can't undo them.
- `data/` is a mounted volume, so your data survives rebuilds.

Why SQLite, not Postgres? A single-user tool never needs a database server.

## Outlook 2016 (meetings → time entries)

Import your calendar meetings as manual entries, straight from the Outlook
desktop app — no cloud, no tokens, no Azure app registration. Run on your
Windows machine (Outlook installed, profile configured):

```powershell
powershell -ExecutionPolicy Bypass -File outlook-import.ps1          # today
powershell -ExecutionPolicy Bypass -File outlook-import.ps1 -Days 7  # last 7 days
```

Each non-all-day meeting you're not marked "Free" for becomes a manual entry
(subject → description, length → time; a `PM-123`-style id in the subject is
picked up as the ticket). Re-running is safe — meetings are de-duplicated.

### Run it automatically (no manual action)

This can't run in Docker — Outlook COM needs your interactive Windows session.
Instead register a Windows Scheduled Task (runs at logon + hourly):

```powershell
powershell -ExecutionPolicy Bypass -File install-outlook-task.ps1
```

Remove it with `-Uninstall`. Trigger a one-off run any time with:

```powershell
Start-ScheduledTask -TaskName "TimeTracker Outlook Import"
```

It only runs while you're logged on (COM needs Outlook available).

### Logs & troubleshooting

The app keeps a shared log at `data/app.log` (server events + the Outlook
importer's outcome and errors). View it in the app under **Settings → View logs**
(with an errors-only filter). If a scheduled import fails, the reason shows up
here — the two common causes are **the Docker app not running** (API unreachable)
and **Outlook not open** at that moment. The import needs both.

## Jira (read-only ticket info)

Optional, and **read-only** — it never writes worklogs or changes anything in
Jira. When configured it turns ticket ids into links to Jira and shows each
ticket's status. Booking research/non-code time is just a manual entry with the
ticket id typed in.

Self-hosted Jira: create a Personal Access Token (Jira → *Profile → Personal
Access Tokens*), then create a `.env` file next to `docker-compose.yml`:

```bash
cp .env.example .env
# edit .env:
#   JIRA_BASE_URL=https://your-jira-host
#   JIRA_TOKEN=your-personal-access-token
docker compose up -d --build
```

Without a `.env`, everything works exactly as before — the Jira features simply
stay off. The token stays in your `.env` (git-ignored) and is never sent to the
browser.

## Uninstall

```bash
node track.js hook-uninstall-global   # stop tracking commits
docker compose down                   # stop the web app
```

## CLI (optional)

The host `track.js` also works standalone:

```bash
node track.js start "PM-2393 investigating bug"   # manual timer
node track.js stop
node track.js report today                        # or a ticket id
node track.js hook-install                         # hook for just the current repo
```

## Data files

- `data/entries.json` — git commits (the hook's inbox) and CLI timer entries
- `data/state.json` — the running CLI timer
- `data/tracker.db` — the web app's database (source of truth for the UI)
