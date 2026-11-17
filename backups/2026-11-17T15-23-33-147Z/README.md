# International job research agent

Local, private research workspace for Tarek Elsayed. Requires Node.js 26. SQLite and reports run without npm packages. Candidate facts come from the entire original one-page PDF; user answers override earlier statements.

```powershell
node scripts/extract-resume.cjs
node scripts/profile.cjs
node scripts/seed.cjs
node scripts/agent.cjs import data/targets.json
node scripts/agent.cjs import data/research-batch.json
node scripts/agent.cjs report
node scripts/agent.cjs queue
node --test tests/agent.test.cjs
node scripts/browser.cjs https://careers.microsoft.com/ microsoft-browser-test
```

Open dashboard.html locally. applications.xlsx contains Applications, Jobs and Companies sheets, including an empty Applications table when nothing was submitted. CSVs and all reports regenerate from SQLite. data/checkpoint.json records actual progress; data/evidence stores browser results and employer confirmations. No public hosting is needed.

## Browser and runtime

All browser scripts now use Google Chrome exclusively. scripts/browser.cjs uses the official Playwright library, resolving a local install first and then an existing npm cache installation. The selected personal profile is Profile 4 (dev), confirmed by the user from Local State metadata; it is not launched or modified by these scripts. Existing-session Playwright MCP attachment is unavailable because its Chrome extension is missing. The fallback uses a dedicated persistent Chrome profile at data/chrome-automation-profile. No personal cookies or profile data are copied. Chrome launches and local DOM control passes; Microsoft, Amazon and BMW navigation currently times out. See chrome_browser_report.md. Do not bypass restrictions.

```powershell
node scripts/chrome-smoke.cjs
node scripts/chrome-signin.cjs
```

The second command opens the dedicated Chrome profile visibly for normal sign-in and waits until you close it. Never run two persistent contexts against the same dedicated profile simultaneously. Existing-session attachment should use the supported MCP extension installed by the user in Profile 4; do not enable remote debugging on the personal profile.

For a portable installation, run `npm.cmd install playwright eve ai zod` after networking is available, then `npx.cmd eve init .` following the current eve docs. Preserve agent/instructions.md. The eve package is currently unavailable and no eve runtime is running. Do not create API keys or send resume data to an external LLM without choosing the appropriate account/provider. Documentation: https://eve.dev/docs/getting-started and https://playwright.dev/docs/library.

`node scripts/research.cjs --limit 20` resumes official portal capture for employers with known verified URLs. It saves browser evidence and discovers JSON-LD JobPosting records. It does not invent DOM selectors or infer eligibility from keyword scores. Dynamic portals need site-specific adapters and human/agent reading; search-result assessments in the imported batch are marked as preliminary.

## Application workflow

Research → evaluate → prepare → submit only when all answers and eligibility are verified and the employer permits it. User has authorized ordinary eligible applications. Login, OTP, CAPTCHA, unresolved legal questions, unknown required personal data or uncertain submission outcomes block that application. Continue other research. Do not store passwords in this repo.

Actual form filling and submission require an inspected portal and a site-specific workflow; there is no generic unattended submission adapter. Record observed employer success using `node scripts/agent.cjs submission receipt.json`. The API requires an eligible verified-open job, a prepared application, employer confirmation text, confirmation URL and a nonempty evidence file within data/evidence. It calculates SHA-256. Never fabricate a receipt to move a status. Failed or ambiguous submit attempts must be reconciled before retrying.

Candidate profile: data/candidate_profile.json. Latest verified user answers: candidate_answers.json. ATS text variants in applications/resumes are drafts; preserve all experience and do not claim employer requirements as candidate qualifications. The original PDF remains suitable for upload when accepted.

## Limits and next work

Target queue size is not completed research. 200 employers and 500 vacancy evaluations remain a research objective, not an achieved count. No background process or schedule is active. Review pending_actions.md and final_report.md for current access and application blockers. The seed list intentionally has unverified employers with no invented career URL. Add official source links as researched.
