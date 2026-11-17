# Data migration report

Source: original data/jobs.sqlite, backed up before any schema changes at C:\Users\dell\OneDrive\Desktop\LinkedIn-Profile\backups\2026-11-17T15-23-33-147Z\data\jobs.sqlite, with an additional pre-migration SQLite snapshot under backups/. Destination: the same canonical data/jobs.sqlite, using OpenApply's schema and extension tables. No reset or replacement of historical application states occurred.

| Original entity | Preserved source rows | Canonical projection |
|---|---:|---|
| Employers | 343 in legacy_companies | Retained supplemental employer registry; no guessed ATS board registrations |
| Vacancies | 365 in legacy_jobs | 365 closed OpenApply jobs, IDs legacy:<original id> |
| Applications | 5 in legacy_applications | 5 needs_human applications with original blocked status/blocker in notes |
| Events | 382 in legacy_events | 382 copied events with original timestamps, prefixed legacy kinds |

207 employers have historical lookup timestamps, including 158 recorded readable official portals. All 365 vacancies contain historical preliminary assessments. The historical 68-vacancy checkpoint cannot be reconstructed as a separate snapshot from the current database; the verified current preserved total is 365. Do not add the checkpoint to the current count. No submitted applications or confirmation evidence existed; current employer-confirmed submissions remain zero.

ALTER TABLE renaming preserves original columns, values and internal foreign-key references. The transactionally copied projection uses migration_map and migration_runs with a legacy-v1 marker. Replaying migration does not append duplicate historical events or applications. Original source rows are preserved without promoting sponsorship, language, eligibility, country or historical live status to current truth. Incomplete excerpts are marked desc_full=0. Original source URLs and research timestamps remain in the archive, mapped to each canonical ID. Unknown first/last timestamps are explicitly unknown, not invented dates.

Automated tests compare every row in all four legacy tables against the initial backup, and check 365 mapping rows, zero active historical jobs, integrity_check=ok and no foreign-key violations. The initial candidate import checks original PDF SHA-256 b497003cababe7dbe2fd766c5e0943d80fdfbfb17cedfe237dec6552a1583827. University/year and immigration/language facts use confirmed answers. Graduation month and salary expectation remain unset. Overlapping roles retain their dates; their tenure is not summed.

The active application history is OpenApply applications/events plus submission_evidence and application_holds. legacy_applications/events are archival provenance, not a second live tracker. Current reports use canonical applications; historical research counts use the archive and are labeled historical. Original research JSON is retained as source material and was not blindly imported as additional vacancies, avoiding double counting. Future live rediscovery must reconcile historical URL/ID aliases before any second application; policy blocks exact-URL application collisions.
