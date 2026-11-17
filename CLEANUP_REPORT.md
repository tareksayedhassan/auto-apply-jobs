# Cleanup report

Recovery backup: C:\Users\dell\OneDrive\Desktop\LinkedIn-Profile\backups\2026-11-17T15-23-33-147Z. Original inventory: 240 non-session, non-dependency files. Consistent SQLite online backup includes committed WAL contents. manifest.json records original and backup SHA-256. Dependency caches and browser sessions were excluded; no credentials or personal Chrome profile were copied. Git history remains in its original directory.

No file was removed without checking that its bytes matched the recovery copy. Cleanup used an explicit file list and per-file unlink; no parent/Desktop recursive removal was used. Source research JSON, candidate sources, original PDF, evidence, and old draft resumes are retained because they contain useful or potentially unique information. Old dedicated browser-state directories are retained in place and unused, rather than inspecting/deleting uncertain session information. Empty agent directory may remain and contains no application implementation.

## Exact removed files

- scripts/seed.cjs: Target queue already preserved; OpenApply owns discovery.
- scripts/research.cjs: Abandoned parallel researcher depends on retired legacy writer.
- scripts/report-state.cjs: Superseded report rewriter hardcodes obsolete browser outcomes.
- scripts/connectivity-report.cjs: Superseded diagnostic report generator hardcodes old network results.
- scripts/connectivity-diagnostics.cjs: Old multi-browser diagnostics replaced by one Chrome capture entry point.
- scripts/finalize-chrome.cjs: One-time historical report rewriting.
- scripts/chrome-configure.cjs: One-time browser config mutation.
- scripts/chrome-smoke.cjs: Repeated historical portal smoke loop replaced by targeted capture.
- scripts/update-confirmed.cjs: One-time answer patch; confirmed answers preserved.
- scripts/profile.cjs: Old candidate/variant generator superseded by checked OpenApply projection.
- scripts/resume-pdf.cjs: Parallel PDF generator superseded by OpenApply.
- scripts/verify.cjs: Checks obsolete exports and legacy database schema.
- scripts/xlsx.cjs: Old generated export utility; workbook retained as historical.
- tests/agent.test.cjs: Tests removed writer; replaced by migration and upstream integration tests.
- agent/instructions.md: Obsolete instructions to resume research; consolidated AGENTS.md owns workflow.

## Preserved historical files moved out of the active root

- applications.xlsx -> reports\historical\applications.xlsx.
- companies.csv -> reports\historical\companies.csv.
- jobs.csv -> reports\historical\jobs.csv.
- final_report.md -> reports\historical\final_report.md.
- browser_diagnostic_report.md -> reports\historical\browser_diagnostic_report.md.
- chrome_browser_report.md -> reports\historical\chrome_browser_report.md.

## Classification

KEEP: OpenApply source, Git history, installed dependencies, original PDF, verified candidate answers, parsed CV, unique research inputs/evidence, relevant extraction/browser helpers, original resume drafts. MIGRATE: original tracker history into OpenApply tables and historical reports into reports/historical. MERGE: application tracking and event history in one database. REGENERATE: upstream/extension builds, local report, compiled test harness. DELETE: the 15 exact obsolete files above, with recovery copies retained.

scripts/agent.cjs is a compatibility facade for reports only; it cannot write through the old schema. Old report scripts can no longer overwrite current instructions or produce stale Edge claims. No Git history, original resume, unrelated files or personal browser state was deleted. Full cleanup manifest: reports/cleanup-manifest.json. The generated upstream .recovery-tests tree can be removed after the runner exits; it is rebuilt by test:upstream. scripts/cleanup.cjs is a one-time checked action, not an idempotent housekeeping command; do not rerun it blindly.
