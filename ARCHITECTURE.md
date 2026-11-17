# OpenApply architecture

A free, local, open-source take on "let your agent apply for you". One Node package exposes:

- an **MCP server** (`openapply-mcp`, stdio) for Claude Code, Codex, Cursor, Claude Desktop, etc.
- a **CLI** (`openapply sync | search | ui | doctor | init`)
- a **local dashboard** (`openapply ui` -> http://127.0.0.1:4646) to review matches, packs and the pipeline.

Design principles

1. **Free.** No paid API, no account, no server. Job data comes from public ATS JSON APIs and free feeds.
   No LLM calls inside the server: the *client's* model (Claude, GPT) does the writing. The server hands it
   briefs and stores, checks and renders what it writes.
2. **Never invent.** The tailored resume is checked against the master resume (truth guard): new numbers,
   employers, titles, schools or dates that are not in the master are flagged as warnings.
3. **Human approval before submit.** `fill` returns a one-time confirmation code and a screenshot. `submit`
   only works with that code (which the agent must get by showing the user the preview) or after the user
   approved that exact fill in the dashboard. An approval is bound to one fill (same process, code and page URL):
   re-filling, re-inspecting or navigating voids it, fill and submit are serialized per job, and the agent cannot
   set 'approved' itself. CAPTCHAs are never solved or bypassed: the run stops at `needs_human` and the
   visible browser stays open for the user to finish.
4. **Local state** in `~/.openapply` (override `OPENAPPLY_HOME`): SQLite DB (node:sqlite, FTS5), profile.json,
   resume.json, packs/, screenshots/, browser-profile/.
5. **Zero native deps.** node:sqlite, Playwright Chromium, unpdf. Node >= 22.5. One optional binary: a TeX engine (tectonic, or pdflatex/xelatex/lualatex) for LaTeX cover letters; without it letters render as HTML.

## Modules and owners

Shared contracts (do not change signatures without the orchestrator): `src/types.ts`, `src/paths.ts`, `src/db.ts`.

| Module | Files | Exports |
|---|---|---|
| Sources | `src/sources/{http,greenhouse,lever,ashby,workable,smartrecruiters,recruitee,workday,remoteok,remotive,arbeitnow,hn,himalayas,jobicy,index}.ts`, `src/sync.ts`, `src/details.ts`, `src/discover.ts`, `src/text.ts` | see below |
| Board registry | `data/boards.json`, `scripts/seed-boards.ts` | bundled verified slugs |
| Profile + tailoring | `src/profile.ts`, `src/resume-import.ts`, `src/match.ts`, `src/tailor.ts`, `src/truth.ts`, `src/render/{resume,cover}.ts`, `src/pdf.ts` | see below |
| Apply engine | `src/apply/{browser,engine,detect,captcha,fieldmap}.ts`, `src/apply/adapters/{greenhouse,lever,ashby,generic}.ts`, `test/fixtures/ats/*.html` | see below |
| Tracking + HTTP | `src/track.ts`, `src/server/http.ts` | see below |
| Dashboard | `ui/index.html` (+ `ui/*.js|css`) | static, talks to HTTP API |
| MCP + CLI | `src/mcp.ts`, `src/cli.ts`, `src/tools.ts` | orchestrator |

### Sources

```ts
// src/text.ts
export function htmlToText(html: string): string;          // strip tags, decode entities, keep paragraph breaks
export function detectRemote(location: string, text?: string): boolean;
export function parseSalary(text: string): { min?: number; max?: number; currency?: string } | undefined;

// src/sources/http.ts
export async function getJson<T>(url: string, opts?: { timeoutMs?: number; retries?: number; headers?: Record<string,string> }): Promise<T>;
export class NotFoundError extends Error {}

// each board source: src/sources/<ats>.ts
export async function fetchBoard(slug: string): Promise<NormalizedJob[]>;   // throws NotFoundError on 404
// each feed source (remoteok, remotive, arbeitnow, hn, himalayas, jobicy)
export async function fetchFeed(): Promise<NormalizedJob[]>;

// src/sources/index.ts
export const BOARD_SOURCES: Partial<Record<Ats, (slug: string) => Promise<NormalizedJob[]>>>;
export const FEED_SOURCES: Partial<Record<Ats, () => Promise<NormalizedJob[]>>>;
export function loadBoards(): Board[];   // bundled data/boards.json merged with ~/.openapply/boards.json

// src/sync.ts
export interface SyncReport { boards: number; ok: number; failed: number; notFound: string[]; jobsSeen: number; newJobs: number; closed: number; feeds: Record<string, number | string>; ms: number; }
export async function sync(opts?: { boards?: Board[]; feeds?: boolean; concurrency?: number; onProgress?: (done: number, total: number) => void }): Promise<SyncReport>;

// src/details.ts  (lean index: full postings on demand, see below)
export async function fetchFullDescription(job: Job): Promise<string | undefined>;   // per-ATS single-posting endpoint; throws NotFoundError when the posting is gone
export async function getJobFull(id: string): Promise<Job | undefined>;              // hydrates + stores; never throws on network errors

// src/intel.ts
export async function companyBrief(jobId: string): Promise<CompanyBrief>;           // uses getJobFull

// src/text.ts additions
export function htmlSnippet(html: string, maxChars: number, escaped?: boolean): string;   // converts only a growing prefix
export function truncateWords(text: string, max: number): string;

// src/discover.ts  (probe every board ATS for a company name, add hits to ~/.openapply/boards.json)
export async function discoverCompany(name: string): Promise<Array<Board & { jobCount: number }>>;   // a myworkdayjobs.com URL probes that one Workday board
export function workdayBoardsFromIndex(): Board[];   // Workday boards linked from indexed postings (url, apply_url, text) that no board list names yet
export function addUserBoards(boards: Board[]): void;
```

### Profile + tailoring

```ts
// src/profile.ts
export function loadProfile(): Profile | undefined;
export function saveProfile(patch: Partial<Profile>): Profile;      // deep-merges targets/eeo/savedAnswers
export function loadResume(): Resume | undefined;
export function saveResume(r: Resume): void;
export function profileStatus(): { hasProfile: boolean; hasResume: boolean; missing: string[] };

// src/resume-import.ts
export async function extractText(path: string): Promise<string>;   // .pdf (unpdf), .txt/.md, .tex (strip macros), .docx (unzip word/document.xml), .json (JSON Resume)
export function parseResumeText(text: string): Resume;              // heuristic sections; agent can refine via save_resume

// src/match.ts
export function scoreJob(job: Job, profile: Profile | undefined, resume: Resume | undefined): MatchResult;
export function listMatches(opts?: { limit?: number; postedWithinDays?: number; minScore?: number; query?: string }): MatchResult[];

// src/truth.ts
export function truthCheck(master: Resume, sourceText: string, tailored: Resume, coverLetter?: string): string[];

// src/tailor.ts
export async function tailoringBrief(jobId: string): Promise<{ job: Job; master: Resume; profile?: Profile; rules: string[]; questionsHint: string[]; needsUserInput: string[]; voiceSamples: string[] }>;   // job comes from getJobFull: full posting text
export async function savePack(jobId: string, input: { resume: Resume; coverLetter?: string; answers?: Record<string,string> }): Promise<ApplicationPack>;   // runs truth guard, renders PDFs, sets application status 'drafted'
export function loadPack(jobId: string): ApplicationPack | undefined;

// src/render/resume.ts, src/render/cover.ts
export function resumeHtml(r: Resume): string;     // one-page, ATS-friendly, real text (no images), serif-free clean template
export function coverLetterHtml(text: string, profile: Profile | undefined, job: Job): string;   // fallback when no TeX engine
// src/render/cover-tex.ts: templates/cover-letter.tex is the sb2nov resume preamble with NAME/CONTACT/DATE/BODY slots
export function coverLetterTex(text: string, profile: Profile | undefined): string;   // texEsc escapes \ { } $ & % # _ ^ ~ < > |
// src/tailor.ts renderCoverLetter: texToPdf(coverLetterTex) first, htmlToPdf(coverLetterHtml) + a "rendered without LaTeX" warning on failure; savePack and updatePack both use it
// src/pdf.ts
export async function htmlToPdf(html: string, outPath: string): Promise<{ pages: number }>;   // Playwright chromium, Letter
export async function texToPdf(tex: string, outPath: string): Promise<{ pages: number }>;    // texEngine(): OPENAPPLY_TEX (path or "off"), else tectonic/pdflatex/xelatex/lualatex; temp dir, 60 s timeout
```

### Apply engine

```ts
// src/apply/detect.ts
export function adapterFor(url: string): "greenhouse" | "lever" | "ashby" | "generic";
// src/apply/engine.ts
export async function inspectForm(jobId: string): Promise<FormInspection>;
export async function fillForm(jobId: string, answers?: Record<string, string>): Promise<FillResult>;   // keeps the page open, sets status 'filled', stores confirmation code
export async function submitForm(jobId: string, confirmationCode?: string): Promise<SubmitResult>;      // requires matching code OR status 'approved'
export async function closeBrowser(): Promise<void>;
```

Adapter interface (`src/apply/adapters/*.ts`):

```ts
export interface Adapter {
  name: string;
  matches(url: string): boolean;
  applyUrl(job: Job): string;                       // e.g. lever: `${url}/apply`
  discover(page: Page): Promise<FormField[]>;
  fill(page: Page, field: FormField, value: string, files: { resume?: string; cover?: string }): Promise<void>;
  submit(page: Page): Promise<void>;
  confirmSubmitted(page: Page): Promise<boolean>;  // thank-you page / success message
}
```

Browser: Playwright `chromium.launchPersistentContext(paths.browserProfile, { headless: OPENAPPLY_HEADLESS === "1" })`.
Headed by default so the user can watch and take over.

### Tracking + HTTP

```ts
// src/track.ts
export function saveJob(jobId: string, notes?: string): Application;
export function updateStatus(jobId: string, status: ApplicationStatus, note?: string): Application;
export function approve(jobId: string, code: string): Application;     // only from 'filled', code must match the fill the user saw
export function pipeline(): { counts: Record<ApplicationStatus, number>; recent: ApplicationEvent[]; items: Array<Application & { job?: Job }> };
// src/server/http.ts
export async function startServer(port?: number): Promise<{ url: string; close(): Promise<void> }>;
```

HTTP API (JSON, 127.0.0.1 only, default port 4646). The dashboard is a static page in `ui/` served at `/`.

| Method + path | Body / query | Returns |
|---|---|---|
| GET `/api/stats` | | `{ jobs: jobStats(), profile: profileStatus(), pipeline: counts }` |
| GET `/api/jobs` | `?q=&location=&remote=1&company=&days=&limit=&offset=` | `{ total, jobs: Job[] }` (description truncated to 400 chars) |
| GET `/api/jobs/:id` | | `{ job, application?, pack?, events, website?, priorApplications, warning? }` (`job` has the full description, fetched on demand; `website` from `website.ts`) |
| GET `/api/matches` | `?limit=&days=&q=` | `MatchResult[]` (descriptions truncated) |
| GET `/api/pipeline` | | `pipeline()` |
| POST `/api/jobs/:id/save` | `{ notes? }` | `Application` |
| POST `/api/jobs/:id/status` | `{ status, note? }` | `Application` |
| POST `/api/jobs/:id/approve` | `{ code }` (the confirmation code displayed for that fill) | `Application` |
| PUT `/api/jobs/:id/pack` | `{ answers?: Record<question, answer>, coverLetter? }` (the user's edits) | `{ pack, todos, status }` |
| GET `/api/profile` | | `{ profile, resume, status }` |
| PUT `/api/profile` | `Partial<Profile>` | `Profile` |
| GET `/files/packs/:jobId/:file` | | serves resume.pdf / cover-letter.pdf |
| GET `/files/screenshots/:file` | | serves a screenshot PNG |
| POST `/api/sync` | | starts a sync in background; `{ started: true }` |
| GET `/api/sync` | | `{ running, lastReport? }` |
| GET `/api/scoreboard` | | `strategyScoreboard()` (src/scoreboard.ts): weekly sends and conversations vs strategy.json targets, 48-hour flags, follow-ups, the lead companies, gate, milestones. Read-only: never writes strategy.json (no file = generic built-in defaults plus a warning); only `openapply scoreboard --init-config [file]` creates it. Also MCP `strategy_scoreboard` and CLI `openapply scoreboard [--json]` |

Job ids contain `:` and must be `encodeURIComponent`-ed in paths.

### History import + duplicate guard

```ts
// src/history.ts  (MCP import_history, CLI `openapply import-history <file>`)
export function importHistory(records: Array<{ company; title; appliedAt; status; url? }>): { created; attached; unchanged };
// src/prior.ts
export function priorApplications(company: string, title?: string, excludeJobId?: string): PriorApplication[];
export function assertNotDuplicate(jobId: string, force?: boolean): void;   // throws DuplicateApplicationError
// PriorApplication = { jobId, company, title, status, appliedAt, similarTitle, imported }
```

- A record attaches to the job its URL names; with no URL, to the job with the same company and the same title (case-insensitive). Anything else, a URL
  that matches no posting or only a similar title, makes a closed placeholder job `history:<company-key>:<title-slug>` (ats `other`, board `history`, `open = 0`), so search, matches and sync never see it.
  The application gets the record's status and `submitted_at = appliedAt` (kept if ISO, else written as YYYY-MM-DD), `source = "history"` (only when it
  creates the application), and an `imported` event. History is the lowest authority: it sets the status only of an application that has not gone in yet
  (none, saved, drafted, filled, approved, needs_human, or withdrawn without a submit date), never of one that has, so a second run changes nothing and
  never undoes progress made in OpenApply. Import events stay out of the pipeline's `recent` feed.
- Companies compare after lowercasing, dropping punctuation and trailing Inc/LLC/Ltd/Corp/Co/AI/Labs/HQ/Technologies, plus "(formerly X)" and a small
  alias table in `prior.ts`. Whole names must match, so Acme never matches Acmeville. Titles are similar at >= 60% word overlap (Jaccard) after dropping
  level words (Senior, Staff...) and filler (words in parentheses count, so Frontend and Backend differ); "Forward Deployed Engineer" vs "Delivery Strategist" shares nothing, so it is a warning, not a block.
- A prior is an application at the same company that has `submitted_at` or is submitted, interview, offer, rejected or ghosted (not needs_human, and not
  withdrawn alone, which also drops a role never sent). A job's own application is never its prior.
- `priorApplications` + `warning` ("Already applied to Acme · Delivery Strategist on 2026-08-28") ride on get_job, save_job, search_jobs, list_matches,
  GET `/api/jobs`, `/api/jobs/:id`, `/api/matches`, `/api/pipeline` items (pipeline items also carry `source`).
- Draft (POST `/api/jobs/:id/draft`), fill (POST `/api/jobs/:id/fill`) and `fill_application` refuse a same-company, similar-title prior under a
  different job id (409 / tool error) unless `force: true`. Different title: warning only.
- Dashboard: an "Applied before" chip (amber outline; red "Already applied" for the same role) on pipeline rows, matches and the drawer header,
  tooltip listing each prior; the Review sheet shows the chip and the warning beside the Approve button. A 409 shows the priors inline with an explicit "Apply anyway" that resends `{ force: true }`. Rows with
  `source: "history"` leave the active pipeline and its counts for a collapsed History section grouped by status.

### Company website

`website.ts` `companyWebsite(job)`: Ashby boards ask Ashby's public `organizationFromHostedJobsPageName { publicWebsite }` once per board (kept
in kv `website:ashby:<slug>`, a failed call is not kept); otherwise a domain in the posting's URL, apply URL or text whose label is the
company's normalized name or its board slug. No match: no website (never a domain guessed from the name). Only GET `/api/jobs/:id` carries it.

### Workday

`src/sources/workday.ts` reads Workday career sites through the public CXS JSON endpoints the site itself calls. A board slug is
`<tenant>.<wdN>/<site>` (`nvidia.wd5/NVIDIAExternalCareerSite` for https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite);
`parseWorkdayUrl` turns any career-site, posting or CXS URL into one and `workdaySlugsIn` finds them in free text.

- List: POST `https://<host>/wday/cxs/<tenant>/<site>/jobs` with `{ appliedFacets: {}, limit: 20, offset, searchText: "" }`. Workday
  sends `total` only on the first page (later pages say 0) and many tenants report exactly 2000 however many they hold. At most 50
  pages (1,000 roles, newest first); a list cut short by the cap, by the 2000 figure or by rows shifting between pages is marked
  truncated, so sync does not close by absence there: it closes only rows no sync has seen for 7 days (`closeUnseenSince`, for any
  truncated list). Rows carry title, path, location text and "Posted N Days Ago" only: the stored description is a stub
  (`descriptionComplete: false`) that names no company. "3 Locations" becomes the path's main location plus "and 2 more".
  "Posted 30+ Days Ago" maps to 30 days back, and a Workday row's stored `posted_at` only ever moves earlier on upsert, so the
  label cannot drag a known date forward day by day.
- Job id: `workday:<slug>:<anchor>`, the anchor being the posting path's last segment (`Senior-Engineer_JR2014725`); url
  `https://<host>/<site>/job/<location>/<anchor>`. The company is the board entry's name (tenant name until then).
- Full posting: GET `https://<host>/wday/cxs/<tenant>/<site>/job/<location>/<anchor>`, the stored url's path, which is what the
  career site requests (details.ts; `job/<anchor>` only when the url has another shape). Description HTML to text plus
  locations, time type and req id. A 404 closes the job.
- Errors: a wrong site answers 404, a wrong host or tenant 422; both are NotFoundError. 429s go through getJson's backoff.
- Politeness: every Workday request in the process waits on one gate, 400 ms apart (`OPENAPPLY_WORKDAY_GAP_MS`), so a sync's
  Workday boards run one request at a time however wide the pool is.
- Boards: `data/boards.json` key `workday` (written by `scripts/workday-probe.ts --write` from verified candidates; `seed-boards.ts`
  keeps that key and skips Workday lines), `~/.openapply/boards.json`, or `discover_company` with the career-site URL (one list
  request for the count; the company is the board list's name for that slug, else none, never the tenant label; only a
  not-found answers "no board", other errors surface).
- Forms: not filled. `inspectForm` and `fillForm` refuse a Workday job before any browser or pack is touched (per-employer accounts
  and a multi-page wizard); the user applies in their own browser and records it.

### Lean index

The DB stores a **snippet** per posting, not the whole text (`db.SNIPPET_CHARS = 700`). A full sync of ~250k roles
with complete descriptions was about 2.5 GB and CPU-bound on HTML decoding and FTS indexing; the lean index is
roughly 2 KB per job (150k jobs ~ 300 MB) and syncs as fast as the network allows.

- `upsertJobs` stores a description whole (`desc_full = 1`) when it fits, else a word-boundary snippet ending in
  `...` (`desc_full = 0`). A source can force `descriptionComplete: false` on a stub (SmartRecruiters, Workable
  widget rows). A hydrated description is never overwritten by a later snippet.
- Board sources convert only the head of each posting (`htmlSnippet`, `LIST_CHARS = 1000`); salary and remote
  detection read that head plus the structured fields, so a pay range buried deep in a long JD can be missed.
- Search, lists and matches use snippets (`Job.descriptionComplete === false`). Anything that needs the whole
  text calls `getJobFull(id)`: tailoring brief, company brief, `get_job`, `GET /api/jobs/:id`, `GET /api/intel/:id`.
  It fetches the single posting from the ATS, stores it with `setFullDescription` (so it becomes searchable and the
  next read is local) and returns it. A 404 closes the job; other failures return the snippet with
  `descriptionComplete: false`.
- Migration: opening an older DB adds `desc_full`, truncates long descriptions, rebuilds FTS and VACUUMs once
  (kv key `lean_index_v1`; a 1.4 GB index shrinks to about 300 MB in ~15 s). Rows are kept, only the text shrinks.

## Testing

`npm test` runs `node --test` over `test/**/*.test.ts` with tsx. Each test file sets `OPENAPPLY_HOME` to a
temp dir before importing modules. Network tests are opt-in (`OPENAPPLY_LIVE=1`). The apply engine is tested
against local fixture pages that mirror real Greenhouse / Lever / Ashby DOM, served from a local HTTP server,
plus a live **fill-only** smoke test (never submits) gated by `OPENAPPLY_LIVE=1`.
