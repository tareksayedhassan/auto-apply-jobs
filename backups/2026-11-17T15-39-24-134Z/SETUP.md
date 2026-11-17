# Setup and operation

Verified workspace: C:\Users\dell\OneDrive\Desktop\LinkedIn-Profile. Upstream exists under openapply; Node v26.13.0. Installed dependencies passed npm.cmd --prefix openapply ls --depth=0. The root package has no external dependencies. No network installation was required. No eve runtime was installed.

```powershell
Set-Location 'C:\Users\dell\OneDrive\Desktop\LinkedIn-Profile'
npm.cmd run build
npm.cmd run migrate
npm.cmd run verify
npm.cmd run test:upstream
npm.cmd run report
npm.cmd run dashboard
```

The root build runs the installed TypeScript compiler directly and avoids upstream's Unix chmod command. Production sources and the eligibility module use strict TypeScript. For a future clean dependency install use npm.cmd --prefix openapply ci --ignore-scripts, then build; this was not needed or claimed tested online. Only Google Chrome is used, explicitly selected from browser.config.json. No Playwright Chromium download is needed.

Dashboard: http://127.0.0.1:4646. Local-only binding. Autosync is disabled by the project launcher because research is paused. Ctrl+C stops the dashboard. Generated reporting dashboard.html is refreshed with npm.cmd run report, not automatically on every database edit. Upstream review dashboard reads the same DB directly.

MCP stdio: npm.cmd run mcp, or node scripts/openapply.cjs mcp. Use the latter for MCP configuration so npm banners do not enter the protocol. The exact entry is config/codex-mcp.toml. Copy that entry into an allowed Codex configuration after reviewing existing entries. Do not replace unrelated Figma or Playwright configuration. Writing .codex/config.toml was rejected by automatic approval review; global configuration was not modified. Current session has no attached OpenApply tools; SDK initialization, tools/list and five read-only tool calls passed through the actual built server. A direct stdio test is not proof that the Codex host has loaded the configuration. See [official Codex MCP documentation](https://developers.openai.com/codex/mcp/).

Candidate setup is already initialized. npm.cmd run migrate is idempotent and preserves later OpenApply profile edits. The PDF plus verified answers remain factual authority; reviewed changes to candidate facts must be reconciled into the parsed source and active profile together. Never use an automatic parser result without checking dates, metrics and degree against the PDF. Original drafts under applications/resumes remain historical inputs, not the active default; the original PDF is the active default.

Inspect existing matches with npm.cmd run matches; zero is currently expected because no historical posting is presumed active. After connectivity is restored and research is explicitly resumed, use OpenApply discovery tools; verify each employer-to-ATS link before application work. Live job revalidation and matching are not currently verified online.

Upstream dashboard Draft and Why-us buttons launch the optional Claude CLI. That subprocess integration was not validated and is not a Codex integration. Use Codex through get_tailoring_brief, save_application_pack and draft_why_us MCP tools for reviewed writing once host attachment is enabled. No optional Claude installation or paid inference was triggered. Resume PDF rendering/tailoring on a real vacancy remains unverified; the original PDF is already configured for upload.

Record researched evidence with node scripts/evidence.mjs assess input.json. Shape: {jobId,country,evidence:[{dimension,finding,quote,url,checkedAt}]}; dimension is one of the eight in ARCHITECTURE.md and finding is met, unknown or not_met. Evidence must come from the actual job/candidate/official immigration source, not assumptions. USA employer sponsorship and Germany visa pathways must be assessed separately. This CLI appends an event transactionally.

Record official source verification with node scripts/evidence.mjs verify-official input.json. Shape: {jobId,employerSourceUrl,applicationUrl,checkedAt,linkObserved:true,liveObserved:true}. Only use this after actually observing the official page link and live vacancy. It records evidence, appends an event and marks that job open. Never mark historical jobs live in bulk.

Then inspect_application, resolve missing answers, fill_application, show the exact preview, obtain explicit approval required by OpenApply, and submit_application with its code. Mandatory salary numbers require role/city research and candidate confirmation. Demographic choices and legal consents require explicit candidate answers. Unknown outcomes must be reconciled before any retry; no reset/unblock CLI is supplied because automatic clearing would risk duplicates. Resolve the held application against employer evidence and append a reconciliation event before a carefully reviewed retry.

Targeted Chrome diagnostic, only after an external condition changes:

```powershell
node scripts/browser.cjs https://www.google.com connectivity-google
node scripts/browser.cjs https://careers.microsoft.com connectivity-microsoft
```

Last Google attempt failed with ERR_NETWORK_ACCESS_DENIED after Chrome launched. This establishes denial in the controlled execution context, not the responsible firewall or administrator policy. Normal personal Chrome success is user-reported. No system security settings were changed. A live employer form test was not attempted after that failure.

Recovery snapshot command: node scripts/recovery.cjs. It uses SQLite online backup, excludes dependency caches and browser sessions, preserves the original recovery manifest, and writes subsequent snapshot metadata separately. Stop active writers before a full multi-file recovery. Restore the original snapshot into a separate staging directory and verify manifest hashes before replacing live state; never overlay it while a dashboard/MCP process is writing. Keep upstream .git in place. Do not publish data, backups, evidence, candidate files or sessions.
