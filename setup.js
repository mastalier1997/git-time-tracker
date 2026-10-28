#!/usr/bin/env node
"use strict";

/**
 * One-command setup for time-tracker.
 *
 *   node setup.js            install the global commit hook (+ checks)
 *   node setup.js --start    also build & start the Docker web app
 *
 * Deliberately NEVER touches your git user.name / user.email — the tool only
 * reads commit metadata, it must not rewrite authorship. It just verifies you
 * have an identity set so your commits aren't authored by someone unexpected.
 */

const { execSync } = require("child_process");
const path = require("path");

const ROOT = __dirname;
const TRACK = path.join(ROOT, "track.js");

const run = (cmd, opts) => execSync(cmd, { stdio: "inherit", ...opts });
const out = (cmd) => {
  try { return execSync(cmd, { encoding: "utf8" }).trim(); } catch { return ""; }
};
const has = (cmd) => {
  try { execSync(cmd, { stdio: "ignore" }); return true; } catch { return false; }
};

console.log("time-tracker setup\n");

// 1. prerequisites
if (!has("git --version")) { console.error("✗ git not found — install git first."); process.exit(1); }
if (!has("node --version")) { console.error("✗ node not found — install Node.js first."); process.exit(1); }
console.log("✓ git and node present");

// 2. git identity must already exist — we never set it
const name = out("git config --global user.name");
const email = out("git config --global user.email");
if (!name || !email) {
  console.error("\n✗ Your global git identity isn't set.");
  console.error("  time-tracker never changes your author identity — set your own first:\n");
  console.error('    git config --global user.name  "Your Name"');
  console.error('    git config --global user.email "you@example.com"\n');
  console.error("  Then re-run: node setup.js");
  process.exit(1);
}
console.log(`✓ git identity: ${name} <${email}>  (left untouched)`);

// 3. warn about an existing global hooks path
const ours = path.join(ROOT, "git-hooks").replace(/\\/g, "/");
const prev = out("git config --global core.hooksPath");
if (prev && prev !== ours) {
  console.log(`\n⚠ core.hooksPath is currently: ${prev}`);
  console.log("  It will be replaced. The new hook chains to repo-local hooks, but hooks");
  console.log("  living only in the old directory won't run. Ctrl-C now to abort.");
}

// 4. install the global commit hook
console.log("");
run(`node "${TRACK}" hook-install-global`);

// 5. optionally build & start the web app
const start = process.argv.includes("--start");
const dockerReady = has("docker --version") && has("docker compose version");
if (start && dockerReady) {
  console.log("\nBuilding & starting the web app (first run takes a few minutes)…\n");
  try {
    run("docker compose up -d --build", { cwd: ROOT });
    console.log("\n✓ Web app running at http://localhost:8787");
  } catch {
    console.log("\n⚠ docker build failed — run it manually: docker compose up -d --build");
  }
} else {
  console.log("\nTo run the web app (needs Docker):");
  console.log("    docker compose up -d --build      →  http://localhost:8787");
  if (start && !dockerReady) console.log("  (Docker not found on PATH — install Docker Desktop first.)");
}

console.log("\nDone. Put a ticket id in your commit messages (e.g. \"PM-123 fix login\");");
console.log("each commit is logged automatically and you set the time in the UI.");
console.log(`\nRemove tracking later with:  node "${TRACK}" hook-uninstall-global`);
