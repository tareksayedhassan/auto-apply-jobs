# Test results

Recorded 2026-11-17T15:38:47.027Z. Full machine-readable results: reports/verification.json. Logs are private under reports/.

| Check | Result / limit |
|---|---|
| Dependencies | npm.cmd --prefix openapply ls --depth=0 passed; all eight direct packages installed |
| Runtime | Node v26.13.0; npm.cmd works; npm.ps1 blocked by existing PowerShell policy |
| Strict production TypeScript | Passed upstream and eligibility build |
| Migration preservation | Passed; every original company/job/application/event row compared to pre-migration backup |
| SQLite integrity / foreign keys | Passed; integrity_check=ok; no foreign_key_check errors |
| Migration replay | Repeated successfully without duplicate jobs, applications or historical events |
| Candidate/PDF | SHA-256 unchanged; upstream PDF extraction passed with font-table recovery warnings; dates and financing/brand metrics checked |
| Consolidation integration tests | 7 passed, 0 failed; includes durable unknown-outcome hold and evidence refusal |
| MCP stdio | Passed initialization, listTools and get_profile/search_jobs/list_matches/list_applications/pipeline_summary |
| Required MCP tools | All eight exposed, including inspection/fill/submit; these live mutation tools were not invoked on employers |
| Source discovery / matching | Passed using recorded upstream fixtures and synthetic profiles; not live jobs |
| Upstream selected suites | 122 passed, 0 failed; DB, migration, profiles, resume tracks, matching, sources, truth guard, field mapping, tracking, application browser and HTTP |
| Browser inspection / filling | Passed local Greenhouse, Lever and Ashby fixtures using installed Google Chrome and isolated profiles |
| Approval / submission behavior | Local synthetic form tests pass approval refusal and receipt behavior; no real application submitted |
| Dashboard | Loopback HTTP UI test passed; upstream HTTP API suite passed; local report generated from canonical DB |
| Google Chrome external page | Failed: ERR_NETWORK_ACCESS_DENIED at https://www.google.com; data/evidence/recovery-google.json |
| Live source / employer form | Blocked after Google failure; no live discovery/form success claimed |
| Codex host attachment | Not completed; protected project-config write rejected; snippet supplied and direct server verified |
| Optional dashboard AI drafting | Upstream invokes Claude CLI; not tested. Codex pack authoring is available through MCP after host attachment |

The original tsx runner failed during initialization with uv_os_get_passwd ENOMEM in this sandbox. The fallback compiles all production sources strictly, transpiles upstream tests with --noCheck (some upstream tests deliberately contain invalid input types), copies fixture assets, then runs Node tests serially. One upstream HTTP test creates a double-quoted filename that Windows cannot create and is excluded with --test-skip-pattern. Node reports 122 selected tests and no runtime skips; the excluded test is not included in that count. An initial fallback run had two failures: that filename and a missing dynamically loaded compiled scoreboard module. Compiling all source fixed the module issue; the filename incompatibility remains explicitly excluded. This is not a claim that the complete upstream suite passed.

Upstream fixture suites run without project policy hooks, in isolated temporary databases. Consolidation integration tests independently exercise project strict personal answers, migration, schema evidence guard and durable retry hold. A full successful employer submission under the combined policy has not been verified; current results do not imply real ATS permission, sponsorship, live status, or universal support. Workday/iCIMS/Taleo/LinkedIn filling is not claimed.
