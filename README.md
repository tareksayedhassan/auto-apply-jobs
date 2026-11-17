# Global AI Job Hunter

Private local project consolidated around the existing OpenApply checkout (db7796e39bf4de095043729142da8c7924ee8fbb). No parallel job hunter or eve runtime is used. Node v26.13.0; upstream version 0.1.0. Original source and history are retained.

From this directory in PowerShell:

```powershell
npm.cmd run build
npm.cmd run migrate
npm.cmd run verify
npm.cmd run report
npm.cmd run dashboard
```

OpenApply review dashboard: http://127.0.0.1:4646 (Ctrl+C to stop). Open dashboard.html for the generated international reporting view. Both use the same authoritative data/jobs.sqlite; the HTML is a report, not a second application. npm.cmd avoids the system's blocked npm.ps1 without changing execution policy.

Verified ledger: 343 employers; 207 historical lookups, of which 158 were readable official portals; 365 historical vacancies; 5 blocked applications; 0 employer-confirmed submissions. All historical vacancies are closed in the active index pending revalidation. Historical preliminary assessments are not current eligibility decisions.

Build, migration integrity, fixture discovery/matching, local browser form workflows, dashboard, and MCP stdio were tested. Live Google access failed with ERR_NETWORK_ACCESS_DENIED. Live employer discovery and live application tests remain blocked and paused. No real submissions were made.

Read SETUP.md for configuration and commands, ARCHITECTURE.md for ownership and extension contracts, TEST_RESULTS.md for actual test limits, DATA_MIGRATION_REPORT.md for provenance, and CLEANUP_REPORT.md for exact removals. Private backup: backups/2026-11-17T15-23-33-147Z. Nothing was published or committed.
