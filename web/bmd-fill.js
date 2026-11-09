#!/usr/bin/env node
"use strict";

/**
 * Fill BMD Web (ZEIT -> Bearbeiten) from the tracker. Per day: one booking from
 * BMD_DAY_START; days over 6h are split by a 30 min unpaid lunch break after 6h.
 *
 * Used by the web app (POST /api/bmd) and as a CLI on the host:
 *   node --env-file=.env web/bmd-fill.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--save]
 * Without --save it only prints the plan. Defaults to today.
 */

const BREAK_AFTER_MIN = 6 * 60;
const BREAK_MIN = 30;

const env = (k, d) => {
  const v = process.env[k] || d;
  if (v === undefined) throw new Error(`Missing env var ${k} (see .env.example)`);
  return v;
};

const pad = (n) => String(n).padStart(2, "0");
const toBmdDate = (ymd) => ymd.split("-").reverse().join("."); // 2026-11-06 -> 06.11.2026
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// entries: [{ day, duration_ms }] -> [{ day, minutes, blocks: [{ begin, end }] }]
function plan(entries, dayStart = env("BMD_DAY_START", "08:00")) {
  const [h, m] = dayStart.split(":").map(Number);
  const start = h * 60 + m;
  const totals = {};
  for (const e of entries) totals[e.day] = (totals[e.day] || 0) + (e.duration_ms || 0);
  return Object.keys(totals).sort()
    .map((day) => ({ day, minutes: Math.round(totals[day] / 60000) }))
    .filter((d) => d.minutes > 0)
    .map((d) => {
      // [begin, end, pause?] — the break is its own BMD booking, like BMD's "Sollzeit aufbuchen" does.
      const lunch = start + BREAK_AFTER_MIN;
      const spans = d.minutes > BREAK_AFTER_MIN
        ? [[start, lunch], [lunch, lunch + BREAK_MIN, true], [lunch + BREAK_MIN, start + d.minutes + BREAK_MIN]]
        : [[start, start + d.minutes]];
      if (spans.at(-1)[1] >= 24 * 60) throw new Error(`${d.day}: ${hhmm(d.minutes)} doesn't fit after ${dayStart}`);
      return { ...d, blocks: spans.map(([b, e, pause]) => ({ begin: hhmm(b), end: hhmm(e), ...(pause && { pause: true }) })) };
    });
}

// ponytail: guessed from the header (user name -> "Abmelden"); unverified, check the warning on first run.
async function logout(page) {
  if (await page.locator("#txtuser-inputEl").isVisible().catch(() => false)) return; // never logged in
  await page.getByText(/\(.*\)$/).locator("visible=true").first().click({ timeout: 5000 }); // "Name (user)" in the header
  await page.getByText("Abmelden", { exact: true }).locator("visible=true").first().click({ timeout: 5000 });
  await page.waitForTimeout(1500);
}

// Books rows in BMD. onSaved(row, status) runs after each day so partial runs are
// recorded; status is "booked", or "existing" when BMD already had bookings that day
// (then nothing is written).
async function fill(rows, onSaved = () => {}) {
  const { chromium } = require("playwright-core");
  // Host CLI drives the installed Edge (visible); the Docker image ships its own headless Chromium.
  const win = process.platform === "win32";
  const browser = await chromium.launch({ channel: win ? "msedge" : undefined, headless: !win });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    page.setDefaultTimeout(30000);

    await page.goto(env("BMD_URL"));
    // ExtJS login form; the bare #txtuser/#txtpass inputs are hidden decoys.
    await page.fill("#txtuser-inputEl", env("BMD_USER"));
    await page.fill("#txtpass-inputEl", env("BMD_PASSWORD"));
    // "Anmelden" stays disabled until the fields validate, so a quick click can be ignored.
    await page.press("#txtpass-inputEl", "Enter");
    await page.getByText("ZEIT", { exact: true }).locator("visible=true").first().waitFor().catch(async () => {
      await page.click("a#loginbutton");
      await page.getByText("ZEIT", { exact: true }).locator("visible=true").first().waitFor();
    });

    const click = (text) => page.getByText(text, { exact: true }).locator("visible=true").first().click();
    await click("ZEIT");
    await click("Bearbeiten");
    await page.waitForFunction(() => window.Ext.ComponentQuery.query("datepicker").some((p) => p.isVisible()));

    // The entry form is an ExtJS row editor that other panels overlap, so drive it
    // through Ext instead of clicks. Verified: BMD recomputes the duration from these.
    const set = (name, value) => page.evaluate(([n, v]) => {
      const c = window.Ext.ComponentQuery.query(`roweditor [name=${n}]`)[0];
      c.focus(); c.setValue(v); c.fireEvent("blur", c); c.fireEvent("change", c, c.getValue());
    }, [name, value]);
    const press = (text) => page.evaluate((t) => window.Ext.ComponentQuery.query(`roweditor button[text=${t}]`)[0].fireHandler(), text);
    // Saved bookings of the day selected in the calendar, as "dd.mm.yyyy hh:mm:00-dd.mm.yyyy hh:mm:00".
    const saved = () => page.evaluate(() => window.Ext.ComponentQuery.query("grid").find((g) => g.findPlugin && g.findPlugin("rowediting"))
      .getStore().getRange().filter((x) => x.data.MCA_ZBU_BUCHUNG_BEGINNZEITorig)
      .map((x) => `${x.data.MCA_ZBU_BUCHUNG_BEGINNZEITorig}-${x.data.MCA_ZBU_BUCHUNG_ENDEZEITorig || ""}`));
    const selectDay = async (ymd) => {
      await page.evaluate((d) => {
        const dp = window.Ext.ComponentQuery.query("datepicker").find((p) => p.isVisible());
        const date = new Date(`${d}T00:00`);
        dp.setValue(date); dp.fireEvent("select", dp, date);
      }, ymd);
      await page.waitForTimeout(3000); // grid reloads from the server
    };

    for (const r of rows) {
      await selectDay(r.day);
      if ((await saved()).length) { onSaved(r, "existing"); continue; }
      for (const b of r.blocks) {
        const want = {
          MCA_ZBU_BUCHUNG_DATUM: toBmdDate(r.day),
          MCA_ZBU_ZUGEHOERIGKEIT_DATUM: toBmdDate(r.day),
          MCA_ZBU_ZBUCHARTNR: b.pause ? env("BMD_PAUSE_BUCHART", "12") : env("BMD_BUCHART", "1"),
          MCA_ZBU_BUCHUNG_BEGINNZEIT: b.begin,
          MCA_ZBU_BUCHUNG_ENDEZEIT: b.end,
        };
        await click("Neu");
        await page.locator('input[name="MCA_ZBU_BUCHUNG_DATUM"]').waitFor({ state: "attached" });
        await page.waitForTimeout(2000); // BMD pre-fills the new row (begin = previous end) asynchronously
        // BMD can overwrite fields after we set them, so set, read back, and retry.
        for (let attempt = 1; ; attempt++) {
          for (const [n, v] of Object.entries(want)) await set(n, v);
          await page.waitForTimeout(1500);
          const got = await page.evaluate((names) => names.map((n) => window.Ext.ComponentQuery.query(`roweditor [name=${n}]`)[0].getRawValue().trim()), Object.keys(want));
          if (got.every((v, i) => v === Object.values(want)[i])) break;
          if (attempt === 3) throw new Error(`${r.day} ${b.begin}-${b.end}: BMD keeps changing the fields to ${got.join(" | ")}`);
        }
        await press("Speichern");
        const key = `${toBmdDate(r.day)} ${b.begin}:00`;
        // Wait for the saved record to show up before starting the next one.
        await page.waitForFunction((k) => window.Ext.ComponentQuery.query("grid").find((g) => g.findPlugin && g.findPlugin("rowediting"))
          .getStore().getRange().some((x) => x.data.MCA_ZBU_BUCHUNG_BEGINNZEITorig === k), key, { timeout: 15000 }).catch(() => {});
        const err = page.locator(".x-message-box:visible");
        if (await err.count()) throw new Error(`${r.day} ${b.begin}-${b.end}: BMD said: ${(await err.innerText()).trim()}`);
        await page.waitForTimeout(1000);
      }
      await selectDay(r.day); // reload and confirm every booking really landed
      const have = await saved();
      const d = toBmdDate(r.day);
      const missing = r.blocks.filter((b) => !have.includes(`${d} ${b.begin}:00-${d} ${b.end}:00`));
      if (missing.length) throw new Error(`${r.day}: BMD did not save ${missing.map((b) => `${b.begin}-${b.end}`).join(", ")}`);
      onSaved(r, "booked");
    }
  } catch (e) {
    const shot = require("path").join(process.env.DATA_DIR || `${__dirname}/../data`, "bmd-error.png");
    await page.screenshot({ path: shot }).catch(() => {});
    throw new Error(`${e.message.split("\n")[0]} (screenshot: ${shot})`);
  } finally {
    // BMD allows only 5 sessions per user and closing the browser does not end one.
    await logout(page).catch((e) => console.warn(`BMD logout failed, session stays open until it times out: ${e.message.split("\n")[0]}`));
    await browser.close();
  }
}

const describe = (r) => `${r.day}  ${r.blocks.map((b) => `${b.begin}-${b.end}${b.pause ? " Pause" : ""}`).join(", ")}  (${hhmm(r.minutes)})`;

async function main() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const d = new Date();
  const from = arg("--from") || `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const to = arg("--to") || from;
  const res = await fetch(`${env("TRACKER_URL", "http://localhost:8787")}/api/entries?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`tracker ${res.status}`);
  const rows = plan(await res.json());

  if (!rows.length) return console.log(`No tracked time ${from}..${to}.`);
  rows.forEach((r) => console.log(describe(r)));
  if (!process.argv.includes("--save")) return console.log("\nDry run. Add --save to write these to BMD.");
  await fill(rows, (r, status) => console.log(status === "existing" ? `skipped ${r.day} (already has BMD bookings)` : `saved ${r.day}`));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { plan, fill };
