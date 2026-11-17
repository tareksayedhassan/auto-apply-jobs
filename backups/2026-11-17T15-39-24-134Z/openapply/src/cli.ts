#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import * as db from "./db.js";
import { join } from "node:path";
import { home, pkgRoot } from "./paths.js";

const HELP = `openapply: free, local job-search agent toolkit

  openapply init [resume-file]   set up your profile (imports a resume if given)
  openapply sync [--no-feeds]    refresh the local job index
  openapply search <words...>    search open roles
  openapply matches [n]          roles ranked against your profile
  openapply import-history <file>  record past applications from JSON ([...] or {"records": [...]})
  openapply outcomes --json <file>  record employer replies read from mail ([...] or {"items": [...]}), prints the report as JSON
  openapply scoreboard [--json]  this week's sends and conversations against the strategy (strategy.json), 48-hour flags, follow-ups, the gate
  openapply scoreboard --init-config [file]  write strategy.json from a strategy file (or the generic defaults); never overwrites
  openapply ui [port]            open the review dashboard (default 4646)
  openapply mcp                  run the MCP server on stdio
  openapply doctor               check the install
  openapply connect              show how to add OpenApply to Claude Code, Codex, Cursor

State lives in ${home()} (override with OPENAPPLY_HOME).`;

const [cmd, ...rest] = process.argv.slice(2);

function row(j: { id: string; title: string; company: string; location: string; remote: boolean }, score?: number) {
  const s = score === undefined ? "" : `${String(score).padStart(3)}  `;
  console.log(`${s}${j.title}  ·  ${j.company}  ·  ${j.location || (j.remote ? "Remote" : "")}\n${" ".repeat(s.length)}${j.id}`);
}

async function main() {
  switch (cmd) {
    case "sync": {
      const { sync } = await import("./sync.js");
      let last = 0;
      const r = await sync({
        feeds: !rest.includes("--no-feeds"),
        onProgress: (done, total) => {
          if (process.stderr.isTTY && Date.now() - last > 250) { last = Date.now(); process.stderr.write(`\r  ${done}/${total} boards`); }
        },
      });
      if (process.stderr.isTTY) process.stderr.write("\n");
      console.log(`${r.ok}/${r.boards} boards ok, ${r.jobsSeen} roles seen, ${r.newJobs} new, ${r.closed} closed, ${(r.ms / 1000).toFixed(1)}s`);
      console.log("feeds:", r.feeds);
      const s = db.jobStats();
      console.log(`index: ${s.open} open roles at ${s.companies} companies`);
      db.kvSet("lastSyncReport", JSON.stringify(r)); // the dashboard's sync panel shows auto-sync runs too
      if (r.ok === 0) process.exitCode = 1; // every board failed (offline?): autosync:last records a failure
      return;
    }
    case "search": {
      const r = db.searchJobs({ query: rest.join(" "), limit: 25 });
      console.log(`${r.total} matches\n`);
      r.jobs.forEach(j => row(j));
      return;
    }
    case "matches": {
      const { listMatches } = await import("./match.js");
      for (const m of listMatches({ limit: Number(rest[0]) || 20 })) {
        row(m.job, m.score);
        console.log(`       ${m.reasons.join("; ")}`);
      }
      return;
    }
    case "import-history": {
      if (!rest[0]) throw new Error("Usage: openapply import-history <file.json>");
      const { importHistory } = await import("./history.js");
      const data = JSON.parse(readFileSync(rest[0], "utf8"));
      const r = importHistory(Array.isArray(data) ? data : data.records);
      console.log(`created ${r.created}, attached ${r.attached}, unchanged ${r.unchanged}`);
      return;
    }
    case "outcomes": {
      // Fed by the inbox sweep: forward-only and idempotent by source_id, so a replayed file is a no-op.
      const at = rest.indexOf("--json");
      const file = at >= 0 ? rest[at + 1] : undefined;
      if (!file) throw new Error("Usage: openapply outcomes --json <file>  (file: [...] or {\"items\": [...]})");
      const data = JSON.parse(readFileSync(file, "utf8"));
      const items = Array.isArray(data) ? data : data?.items;
      if (!Array.isArray(items)) throw new Error(`${file}: expected an array of outcome items, or {"items": [...]}`);
      const { applyOutcomes } = await import("./outcomes.js");
      console.log(JSON.stringify(applyOutcomes(items), null, 2));
      return;
    }
    case "scoreboard": {
      const init = rest.indexOf("--init-config");
      if (init >= 0) {
        const { initStrategy } = await import("./strategy.js");
        const from = rest[init + 1] && !rest[init + 1].startsWith("--") ? rest[init + 1] : undefined;
        console.log(`wrote ${initStrategy(from).path}${from ? ` from ${from}` : " with the built-in defaults"}`);
        return;
      }
      const { strategyScoreboard, scoreboardText } = await import("./scoreboard.js");
      const sb = strategyScoreboard();
      console.log(rest.includes("--json") ? JSON.stringify(sb, null, 2) : scoreboardText(sb));
      return;
    }
    case "ui": {
      const { startServer } = await import("./server/http.js");
      const port = Number(rest[0]) || Number(process.env.OPENAPPLY_PORT) || 4646;
      const s = await startServer(port);
      console.log(`OpenApply dashboard: ${s.url}  (Ctrl+C to stop)`);
      // Keeps the index under a day old while the main dashboard runs; previews on other ports leave it alone.
      const { autoSyncWanted, startAutoSync } = await import("./autosync.js");
      if (autoSyncWanted(port)) startAutoSync();
      // A restart or Ctrl+C takes the fill browser with it; otherwise Dia lives on, orphaned, with every old tab.
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => {
        setTimeout(() => process.exit(0), 15_000).unref(); // Dia takes ~11 s to close; launchd kills at 20 s
        import("./apply/browser.js").then(b => b.closeBrowser()).finally(() => process.exit(0));
      });
      return; // server keeps the process alive
    }
    case "mcp":
      await import("./mcp.js");
      return;
    case "init":
      return init(rest[0]);
    case "doctor":
      return doctor();
    case "connect": {
      const mcp = join(pkgRoot, "dist", "mcp.js");
      console.log(`Claude Code:\n  claude mcp add -s user openapply -- node ${mcp}\n
Codex:\n  codex mcp add openapply -- node ${mcp}\n
Cursor / Claude Desktop / other clients (mcpServers JSON):\n  { "openapply": { "command": "node", "args": ["${mcp}"] } }`);
      return;
    }
    default:
      console.log(HELP);
  }
}

async function init(resumePath?: string) {
  const { loadProfile, saveProfile, profileStatus } = await import("./profile.js");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const p = loadProfile();
  const ask = async (q: string, cur?: string) => (await rl.question(`${q}${cur ? ` [${cur}]` : ""}: `)).trim() || cur || "";
  if (resumePath) {
    const { importResume } = await import("./resume-import.js");
    const r = await importResume(resumePath);
    console.log(`Imported resume: ${r.experience.length} roles, ${r.education.length} schools.`);
  }
  const firstName = await ask("First name", p?.firstName);
  const lastName = await ask("Last name", p?.lastName);
  const email = await ask("Email", p?.email);
  const phone = await ask("Phone", p?.phone);
  const location = await ask("Location (city, state)", p?.location);
  const linkedin = await ask("LinkedIn URL", p?.linkedin);
  const auth = await ask("Authorized to work in the US? (y/n)", p?.workAuthorizedUS === undefined ? undefined : p.workAuthorizedUS ? "y" : "n");
  const spons = await ask("Need visa sponsorship? (y/n)", p?.needsSponsorship === undefined ? undefined : p.needsSponsorship ? "y" : "n");
  const titles = await ask("Target titles, comma separated", p?.targets?.titles?.join(", "));
  const locs = await ask("Target locations, comma separated", p?.targets?.locations?.join(", "));
  const remoteOk = await ask("Open to remote? (y/n)", p?.targets?.remoteOk === undefined ? "y" : p.targets.remoteOk ? "y" : "n");
  rl.close();
  const list = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
  saveProfile({
    firstName, lastName, email, phone, location, linkedin,
    workAuthorizedUS: auth.startsWith("y"), needsSponsorship: spons.startsWith("y"),
    targets: { titles: list(titles), locations: list(locs), remoteOk: remoteOk.startsWith("y") },
  });
  const st = profileStatus();
  console.log(st.missing.length ? `Saved. Still missing: ${st.missing.join(", ")}` : "Saved. Next: openapply sync");
}

async function doctor() {
  const ok = (b: boolean, msg: string) => console.log(`${b ? "ok  " : "FAIL"}  ${msg}`);
  const [maj, min] = process.versions.node.split(".").map(Number);
  ok(maj > 22 || (maj === 22 && min >= 5), `node ${process.versions.node} (need >= 22.5 for node:sqlite)`);
  ok(existsSync(chromium.executablePath()), `chromium for playwright (${existsSync(chromium.executablePath()) ? "installed" : "run: npx playwright install chromium"})`);
  const s = db.jobStats();
  ok(true, `state dir ${home()}`);
  ok(s.open > 0, `job index: ${s.open} open roles, ${s.boards} boards, last sync ${s.lastSync ?? "never"}`);
  const { profileStatus } = await import("./profile.js");
  const st = profileStatus();
  ok(st.hasResume, `resume ${st.hasResume ? "imported" : "missing (openapply init <file>)"}`);
  ok(st.missing.length === 0, `profile ${st.missing.length ? `missing ${st.missing.join(", ")}` : "complete"}`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
