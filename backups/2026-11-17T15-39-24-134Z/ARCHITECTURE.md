# Architecture

One application: OpenApply owns discovery adapters, job index, matching, resume tailoring, form inspection/filling, approvals, application tracking, dashboard, and MCP. Keep its Git repository and MIT license intact. Pin recovery baseline db7796e39bf4de095043729142da8c7924ee8fbb; dependencies are pinned in openapply/package-lock.json. Do not replace the checkout with another application.

## Ownership

| Component | Owner / location | Contract |
|---|---|---|
| Live jobs, applications, events | OpenApply tables in data/jobs.sqlite | OpenApply IDs and statuses; never write with the removed custom tracker |
| Original history | legacy_companies, legacy_jobs, legacy_applications, legacy_events in the same DB | Immutable provenance archive; complete original rows retained |
| ID mapping | migration_map | Legacy integer ID to canonical legacy:<id> ID |
| Candidate facts | Original PDF plus candidate_answers.json | PDF is factual authority; confirmed answers supplement university, immigration, language and salary policy |
| Parsed source | data/candidate_profile.json, data/resume.txt | Verified source material; no invented dates, skills or overlapping tenure |
| Active candidate projection | data/openapply/profile.json and resume.json | OpenApply application inputs; initial import is guarded by original PDF SHA-256. Migration does not overwrite later reviewed inputs |
| International assessment | extensions/visa-eligibility/index.mts | Strict TypeScript; evidence per technical, education, experience, language, authorization, visa, relocation and nationality dimension |
| Supplemental research evidence | extensions/employer-research/index.mjs | Transactional assessment and official-link recording CLI; no second crawler |
| Application safeguards | extensions/policy.mjs | Current official verification and confirmed eligibility before fill/submit, durable attempt hold, confirmation text/URL/screenshot/hash |
| Reporting | extensions/reporting/index.mjs | Read-only SQL summary, historical/current counts, JSON and generated HTML |
| Integration | scripts/openapply.cjs, runtime.cjs | Absolute state paths, installed Google Chrome, research autosync disabled |

Single authoritative database: data/jobs.sqlite. OPENAPPLY_DB is explicitly set by the launcher. OPENAPPLY_HOME is data/openapply and stores profile, resume, packs, screenshots and a dedicated Chrome profile. No home-directory .openapply state existed during audit. Never run bare upstream commands against a different home and then merge application histories casually.

The imported OpenApply jobs use ats=other, board_slug=legacy-research and open=0. Their description is a preliminary requirements excerpt, not a verified complete posting. Full original requirements, country, source URLs, checked timestamps, assessments and blockers remain in legacy tables. migration_map connects provenance to the active index. Employers are preserved in legacy_companies even if no vacancy exists. There are no invented board slugs or sponsorship claims.

## Workflow mapping

DISCOVERED/ASSESSED/ELIGIBLE use jobs plus international_assessments and official_job_verifications. PREPARED maps to drafted. FORM_INSPECTED is an inspection result; FORM_FILLED/AWAITING_APPROVAL maps to filled; approval maps to approved. SUBMITTED requires observed confirmation evidence; CONFIRMED is the existence of immutable submission_evidence, independently counted even after interview/rejection. BLOCKED/NEEDS_INPUT maps to needs_human. CLOSED maps to jobs.open=0. INELIGIBLE is the structured assessment. FAILED is an event plus needs_human. A duplicate blocks work rather than creating a second application. Unknown submission outcomes remain in application_holds across process restarts.

Each original blocked application maps to needs_human with its original status and blocker in notes. Unknowns are never promoted to eligibility. CONFIRMED_ELIGIBLE is an evidence-screening state, not legal immigration approval. No country-specific legal rule engine is shipped; assess current USA employer sponsorship separately from Germany's employment visa/residence requirements using official immigration sources. The module validates structured evidence, not legal authenticity. The agent must verify each quotation/source; unknown evidence stays unknown.

Official-link evidence must record the employer page linking to the ATS and the live posting. A discovered board alone is insufficient. Policy requires checks within 24 hours; assessment evidence must be no older than 30 days, and the decision within 24 hours. All eight dimensions need met evidence before automated filling/submission. Uncertain or unsupported paths stay blocked for human review.

Before clicking submit, the policy persists a hold and event. Uncertain, CAPTCHA, rejected or crash outcomes keep that hold for reconciliation. A confirmed outcome requires a matching employer/ATS domain, visible receipt text, screenshot bytes and SHA-256. Evidence is saved transactionally before the upstream submitted state, preventing unconfirmed submissions even through direct status tools. A crash between evidence and status is recoverable by reconciling that evidence, never resubmitting. SQL triggers prohibit confirmation deletion, timestamp mutation, or resetting a confirmed application to an earlier state. A URL shared with another application blocks filling pending ID reconciliation. Cross-source or changed-URL duplicate reconciliation remains a manual review responsibility alongside OpenApply's duplicate checks.

## Maintained upstream changes

Exactly three source files are modified: src/paths.ts adds OPENAPPLY_DB; src/apply/fieldmap.ts disables automatic demographic/pronoun decline choices and restricts US work-authorization/sponsorship defaults to explicitly US-located jobs when OPENAPPLY_STRICT_PERSONAL=1; src/apply/engine.ts calls optional beforeFill/beforeSubmit/markAttempt/afterOutcome policy hooks. Non-US immigration answers require explicit verified per-job answers; German employment immigration is not treated as US sponsorship. Defaults remain unchanged without project environment variables. reports/upstream.patch captures the exact patch. Rebase these changes consciously and rerun policy, fixture and MCP tests before upgrading. Do not launch the raw upstream CLI/MCP without the project environment.

Workday discovery is supported upstream but form filling is not. iCIMS, Taleo and LinkedIn Easy Apply are not claimed supported. Generic filling is best effort. Never bypass approvals, CAPTCHA, MFA, logins, site restrictions or legal consents. No unattended submission daemon exists.
