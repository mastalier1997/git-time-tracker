#!/usr/bin/env node
"use strict";

/**
 * time-tracker — a small, dependency-free time tracking CLI.
 *
 * Two ways to capture time:
 *   1. Manual timers:  track start "desc"   /  track stop
 *   2. Automatic git:  a post-commit hook logs each commit, extracting the
 *      ticket id (e.g. PROJ-123 or #42) from the commit message and crediting
 *      the time since the previous commit to it.
 *
 * Data lives in ./data/entries.json next to this file, so it works across
 * every repo you install the hook into.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "entries.json");
const STATE_FILE = path.join(DATA_DIR, "state.json"); // holds the running timer

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]");
  if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, "{}");
}

function loadEntries() {
  ensureData();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  ensureData();
  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2));
}

function loadState() {
  ensureData();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  ensureData();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Matches JIRA-style ids (PROJ-123) and GitHub-style refs (#42).
const TICKET_RE = /\b([A-Z][A-Z0-9]+-\d+)\b|(#\d+)/g;

function extractTickets(text) {
  const found = new Set();
  let m;
  while ((m = TICKET_RE.exec(text)) !== null) {
    found.add(m[1] || m[2]);
  }
  return [...found];
}

function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (h === 0) return `${min}m`;
  return `${h}h ${min}m`;
}

function dayKey(iso) {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function git(cmd, cwd, quiet) {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf8",
    stdio: quiet ? ["pipe", "pipe", "ignore"] : undefined,
  }).trim();
}

function inGitRepo(cwd) {
  try {
    git("rev-parse --is-inside-work-tree", cwd);
    return true;
  } catch {
    return false;
  }
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdStart(args) {
  const state = loadState();
  if (state.running) {
    console.log(
      `A timer is already running: "${state.running.description}" (since ${state.running.start}).`
    );
    console.log("Run `track stop` first.");
    return;
  }
  const description = args.join(" ") || "(no description)";
  const tickets = extractTickets(description);
  state.running = {
    description,
    ticket: tickets[0] || null,
    start: new Date().toISOString(),
  };
  saveState(state);
  console.log(`▶ Started: ${description}`);
  if (state.running.ticket) console.log(`   ticket: ${state.running.ticket}`);
}

function cmdStop() {
  const state = loadState();
  if (!state.running) {
    console.log("No timer is running.");
    return;
  }
  const end = new Date().toISOString();
  const start = state.running.start;
  const durationMs = new Date(end) - new Date(start);
  const entries = loadEntries();
  entries.push({
    id: makeId(),
    type: "manual",
    ticket: state.running.ticket,
    description: state.running.description,
    start,
    end,
    durationMs,
    repo: null,
    commit: null,
  });
  saveEntries(entries);
  delete state.running;
  saveState(state);
  console.log(`■ Stopped. Logged ${fmtDuration(durationMs)}.`);
}

function cmdStatus() {
  const state = loadState();
  if (!state.running) {
    console.log("No timer is running.");
    return;
  }
  const elapsed = Date.now() - new Date(state.running.start).getTime();
  console.log(`▶ Running: ${state.running.description}`);
  if (state.running.ticket) console.log(`   ticket: ${state.running.ticket}`);
  console.log(`   elapsed: ${fmtDuration(elapsed)}`);
}

// Called by the git post-commit hook (or manually). Logs the HEAD commit,
// crediting the time since the previous commit (capped) to its ticket.
function cmdGitCommit() {
  const cwd = process.cwd();
  if (!inGitRepo(cwd)) {
    console.error("Not inside a git repository.");
    process.exit(1);
  }

  const hash = git("rev-parse HEAD", cwd);
  const entries = loadEntries();
  if (entries.some((e) => e.commit === hash)) {
    return; // already logged this commit
  }

  const subject = git("log -1 --pretty=%s", cwd);
  const commitIso = new Date(
    parseInt(git("log -1 --pretty=%ct", cwd), 10) * 1000
  ).toISOString();

  // ponytail: git commits log with 0 duration; you set the time in the UI.
  // (Commit-gap guessing always hit the 2h cap and was wrong more than right.)
  const durationMs = 0;
  const start = commitIso;

  const tickets = extractTickets(subject);
  let repoName = cwd;
  try {
    repoName = path.basename(git("rev-parse --show-toplevel", cwd));
  } catch {}

  entries.push({
    id: makeId(),
    type: "git",
    ticket: tickets[0] || null,
    description: subject,
    start,
    end: commitIso,
    durationMs,
    repo: repoName,
    commit: hash,
  });
  saveEntries(entries);

  const t = tickets[0] ? ` [${tickets[0]}]` : "";
  console.log(`⏱ time-tracker: logged ${fmtDuration(durationMs)}${t} — ${subject}`);
}

function cmdHookInstall() {
  const cwd = process.cwd();
  if (!inGitRepo(cwd)) {
    console.error("Not inside a git repository. `cd` into your repo first.");
    process.exit(1);
  }
  const gitDir = git("rev-parse --git-dir", cwd);
  const hooksDir = path.isAbsolute(gitDir)
    ? path.join(gitDir, "hooks")
    : path.join(cwd, gitDir, "hooks");
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, "post-commit");
  const trackPath = path.join(__dirname, "track.js").replace(/\\/g, "/");
  const hook = `#!/bin/sh
# Installed by time-tracker
node "${trackPath}" gitcommit
`;
  fs.writeFileSync(hookPath, hook, { mode: 0o755 });
  console.log(`✔ Installed post-commit hook at ${hookPath}`);
  console.log("Every commit in this repo will now be time-tracked automatically.");
}

// Install ONE hook globally (via git's core.hooksPath) so every repo on this
// machine is tracked without a per-project install.
function cmdHookInstallGlobal() {
  const hooksDir = path.join(__dirname, "git-hooks");
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

  const trackPath = path.join(__dirname, "track.js").replace(/\\/g, "/");
  const hookPath = path.join(hooksDir, "post-commit");
  // The hook also chains to any repo-local post-commit hook, so setting a
  // global hooks path doesn't silently disable existing hooks (husky, etc.).
  const hook = `#!/bin/sh
# Installed globally by time-tracker
node "${trackPath}" gitcommit
# Chain to a repo-local post-commit hook if one exists.
LOCAL="$(git rev-parse --git-dir)/hooks/post-commit"
if [ -x "$LOCAL" ]; then "$LOCAL" "$@"; fi
`;
  fs.writeFileSync(hookPath, hook, { mode: 0o755 });

  const prev = (() => {
    try {
      return execSync("git config --global core.hooksPath", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  })();

  execSync(`git config --global core.hooksPath "${hooksDir.replace(/\\/g, "/")}"`);
  console.log(`✔ Global hooks path set to ${hooksDir}`);
  console.log("Every repo on this machine is now time-tracked on commit — no per-project setup.");
  if (prev && prev !== hooksDir.replace(/\\/g, "/")) {
    console.log(`\n⚠ Previous global core.hooksPath was: ${prev}`);
    console.log("  Its hooks will no longer run. Re-add them under the new dir if needed.");
  }
}

function cmdHookUninstallGlobal() {
  try {
    execSync("git config --global --unset core.hooksPath");
    console.log("✔ Removed global core.hooksPath. Repos use their default hooks again.");
  } catch {
    console.log("No global core.hooksPath was set.");
  }
}

function cmdReport(args) {
  const entries = loadEntries();
  if (entries.length === 0) {
    console.log("No entries yet.");
    return;
  }

  // Optional filter: track report PROJ-123  or  track report today
  const filter = args[0];
  let filtered = entries;
  const today = new Date().toISOString().slice(0, 10);
  if (filter === "today") {
    filtered = entries.filter((e) => dayKey(e.end) === today);
  } else if (filter) {
    filtered = entries.filter((e) => e.ticket === filter);
  }

  if (filtered.length === 0) {
    console.log("No entries match that filter.");
    return;
  }

  // Group by day, then by ticket.
  const byDay = {};
  for (const e of filtered) {
    const d = dayKey(e.end);
    (byDay[d] ||= []).push(e);
  }

  let grand = 0;
  for (const day of Object.keys(byDay).sort()) {
    const dayEntries = byDay[day];
    const byTicket = {};
    let dayTotal = 0;
    for (const e of dayEntries) {
      const key = e.ticket || "(no ticket)";
      byTicket[key] ||= { ms: 0, items: [] };
      byTicket[key].ms += e.durationMs;
      byTicket[key].items.push(e);
      dayTotal += e.durationMs;
    }
    grand += dayTotal;
    console.log(`\n${day}  —  ${fmtDuration(dayTotal)}`);
    for (const ticket of Object.keys(byTicket).sort()) {
      const g = byTicket[ticket];
      console.log(`  ${ticket.padEnd(14)} ${fmtDuration(g.ms)}`);
      for (const e of g.items) {
        const tag = e.type === "git" ? "git" : "man";
        console.log(`      [${tag}] ${e.description}`);
      }
    }
  }
  console.log(`\nTotal: ${fmtDuration(grand)}`);
}

function cmdHelp() {
  console.log(`time-tracker — manual timers + automatic git-based time logging

Usage:
  track start [description]   Start a manual timer (ticket auto-detected in text)
  track stop                  Stop the running timer and log it
  track status                Show the currently running timer
  track report [filter]       Show a report. filter = "today" or a ticket id
  track hook-install-global   Track EVERY repo on this machine (one-time, recommended)
  track hook-uninstall-global Undo the global tracking
  track hook-install          Install the hook in just the current repo
  track gitcommit             (used by the hook) log the current HEAD commit
  track help                  Show this help

Examples:
  track start "PROJ-123 investigating login bug"
  track stop
  track report today
  track report PROJ-123

Data is stored in ${DATA_FILE}
`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const [, , cmd, ...args] = process.argv;

switch ((cmd || "").toLowerCase()) {
  case "start":
    cmdStart(args);
    break;
  case "stop":
    cmdStop();
    break;
  case "status":
    cmdStatus();
    break;
  case "report":
  case "log":
    cmdReport(args);
    break;
  case "gitcommit":
    cmdGitCommit();
    break;
  case "hook-install":
  case "install-hook":
    cmdHookInstall();
    break;
  case "hook-install-global":
  case "install-global":
    cmdHookInstallGlobal();
    break;
  case "hook-uninstall-global":
  case "uninstall-global":
    cmdHookUninstallGlobal();
    break;
  case "help":
  case "":
  case undefined:
    cmdHelp();
    break;
  default:
    console.log(`Unknown command: ${cmd}\n`);
    cmdHelp();
    process.exit(1);
}
