import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as db from "./db.js";
import { loadProfile, saveProfile, loadResume, saveResume, profileStatus } from "./profile.js";
import { importResume } from "./resume-import.js";
import { listMatches } from "./match.js";
import { tailoringBrief, savePack, loadPack } from "./tailor.js";
import { inspectForm, fillForm, submitForm, closeBrowser } from "./apply/engine.js";
import { saveJob, updateStatus, pipeline } from "./track.js";
import { HISTORY_STATUSES, importHistory, logAppliedOffsite } from "./history.js";
import { appliedRows, priorFields } from "./prior.js";
import { OUTCOME_KINDS, ageOutProposals, applyOutcomes } from "./outcomes.js";
import { sync } from "./sync.js";
import { autoSyncRunning } from "./autosync.js";
import { discoverCompany, addUserBoards } from "./discover.js";
import { logOutreach, draftOutreach, updateOutreach, listOutreach, dueFollowUps, outreachBrief } from "./outreach.js";
import { getJobFull } from "./details.js";
import { strategyScoreboard } from "./scoreboard.js";
import { hiringSignals, companyBrief } from "./intel.js";
import type { Job } from "./types.js";

export const INSTRUCTIONS = `OpenApply is a free, local job-search toolkit. It searches live roles from public company job boards, helps tailor a resume and cover letter per role, fills the employer's real application form in a visible browser, and tracks applications and outreach.

What works (from startup recruiters): a focused list beats volume; a person reads every answer; AI-polished text that sounds like everyone else hurts; knowing why the company is hiring now, showing proof of work, and reaching a recruiter or hiring manager directly (with a weekly follow-up) beat a cold application. Steer the user that way.

Typical flow:
1. get_started. If there is no resume, ask the user for a file path and call import_resume, review the parsed result, fix it with save_resume. Fill gaps with update_profile: targets (pick 2 of role, stage, geography, industry to be strict on), work authorization, salary, a few voiceSamples the user wrote themselves, and their story.
2. sync_jobs once a day, then list_matches or search_jobs. Help the user pick a short list.
3. For each pick: company_brief (signals, why now, proof-of-work ideas), then get_tailoring_brief. Write the tailored resume JSON, cover letter and answers in the user's voice, then save_application_pack. Fix truth-guard warnings (never invent employers, titles, dates, numbers or skills) and rewrite anything flagged "Voice:". For "why us" questions, call draft_why_us: it ties one fact about the company to one thing the user has really done, saves it as a draft the user must review, and says when there is no honest link.
4. inspect_application, answer missing required questions (ask the user for anything personal), then fill_application.
5. SHOW THE USER the preview (filled values, warnings, screenshot path) and ask for an explicit yes. Only then call submit_application with the confirmation code. Never submit without the user's yes. On a CAPTCHA or login wall, stop: the user finishes in the open browser window, then call update_application.
6. Outreach: get_outreach_brief, then save the short message with draft_outreach so it waits in the dashboard (Outreach, "Ready to send") for the user to copy, send themselves and mark sent. Use log_outreach only for touches the user already made, and check due_follow_ups each session.
7. Track replies and interviews with update_application and log_event. open_dashboard gives the user a local review page.
   After reading mail, pass the rejections, interviews and acknowledgements it shows to apply_outcomes (never invent one), and record applications sent outside OpenApply (LinkedIn Easy Apply) with log_applied_offsite.`;

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

/** Compact job view for lists, so search results don't flood the context. */
function brief(j: Job, chars = 280) {
  return {
    id: j.id, title: j.title, company: j.company, location: j.location, remote: j.remote,
    salary: j.salaryMin || j.salaryMax ? `${j.salaryCurrency ?? ""} ${j.salaryMin ?? "?"}-${j.salaryMax ?? "?"}`.trim() : undefined,
    posted: j.postedAt?.slice(0, 10), url: j.url,
    snippet: j.description.slice(0, chars) + (j.description.length > chars ? "..." : ""),
  };
}

type Handler<T> = (args: T) => Promise<unknown> | unknown;
function wrap<T>(fn: Handler<T>) {
  return async (args: T) => {
    try { return json(await fn(args)); } catch (e) { return fail(e); }
  };
}

const jobId = z.string().describe("Job id from search_jobs / list_matches, e.g. greenhouse:stripe:12345");
const RO = { readOnlyHint: true, openWorldHint: false };

export function registerTools(server: McpServer): void {
  // ---- setup ----
  server.registerTool("get_started", {
    title: "Get started",
    description: "Check setup (profile, resume, job index) and get the recommended next steps. Call this first.",
    annotations: RO,
  }, wrap(() => {
    const status = profileStatus();
    const stats = db.jobStats();
    const next: string[] = [];
    if (!status.hasResume) next.push("Ask the user for their resume file path, then call import_resume.");
    if (status.missing.length) next.push(`Ask the user for: ${status.missing.join(", ")}; save with update_profile.`);
    if (!loadProfile()?.targets?.titles?.length) next.push("Ask what roles, locations and salary they want; save to profile.targets.");
    if (!stats.open) next.push("Run sync_jobs to build the local job index.");
    else next.push("Use list_matches to find roles that fit, or search_jobs for anything specific.");
    return { profile: status, index: stats, next };
  }));

  server.registerTool("import_resume", {
    title: "Import resume",
    description: "Import the user's master resume from a local file (.pdf, .docx, .tex, .md, .txt, or JSON Resume). Returns the parsed structure; review it and correct it with save_resume.",
    inputSchema: { path: z.string().describe("Absolute path to the resume file") },
  }, wrap(async ({ path }) => ({ resume: await importResume(path), note: "Check names, dates and bullets; fix with save_resume." })));

  server.registerTool("get_resume", {
    title: "Get master resume", description: "Return the user's structured master resume.", annotations: RO,
  }, wrap(() => loadResume() ?? { error: "No resume yet. Call import_resume." }));

  server.registerTool("save_resume", {
    title: "Save master resume",
    description: "Replace the master resume with a corrected structured version (the truth guard checks tailored resumes against this, so only include real facts the user confirmed).",
    inputSchema: { resume: z.any().describe("Resume object: {name, headline?, contact, summary?, experience[], projects?, education[], skills?, extras?}") },
  }, wrap(({ resume }) => { saveResume(resume); return { saved: true }; }));

  server.registerTool("get_profile", {
    title: "Get profile", description: "Return the profile: contact info, links, work authorization, targets, saved answers.", annotations: RO,
  }, wrap(() => ({ profile: loadProfile() ?? null, status: profileStatus() })));

  server.registerTool("update_profile", {
    title: "Update profile",
    description: "Merge fields into the profile. Nested objects (targets, eeo, savedAnswers) are merged, not replaced. targets drives matching: {titles, keywords, locations, remoteOk, excludeCompanies, excludeKeywords, minSalary, seniority}. education is a list of {school, degree, discipline, startYear, endYear} that fills forms with an Education block (the first entry; replaced, not merged). EEO answers default to declining; only set them if the user explicitly asks.",
    inputSchema: { patch: z.record(z.string(), z.any()).describe("Partial profile") },
  }, wrap(({ patch }) => saveProfile(patch)));

  // ---- jobs ----
  server.registerTool("sync_jobs", {
    title: "Sync job index",
    description: "Refresh the local index from every known company board (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Workday) plus free remote-job feeds and HN Who's Hiring. Takes one to a few minutes.",
    inputSchema: { feeds: z.boolean().optional().describe("Include aggregated feeds (default true)") },
    annotations: { openWorldHint: true },
  }, wrap(async ({ feeds }) => {
    if (autoSyncRunning()) return { started: false, running: true, note: "The dashboard's daily auto-sync is running now; roles land in the index as each board finishes." };
    const r = await sync({ feeds: feeds ?? true });
    return { ...r, notFound: r.notFound.length, stats: db.jobStats() };
  }));

  server.registerTool("search_jobs", {
    title: "Search jobs",
    description: "Full-text search over the local index of open roles, with filters.",
    inputSchema: {
      query: z.string().optional().describe("Words to match in title, company, location, description"),
      company: z.string().optional(), location: z.string().optional(),
      remote: z.boolean().optional(), postedWithinDays: z.number().optional(),
      minSalary: z.number().optional(), limit: z.number().optional().describe("Default 20, max 200"),
      offset: z.number().optional(),
    },
    annotations: RO,
  }, wrap((f) => {
    const r = db.searchJobs(f);
    const rows = appliedRows();
    return { total: r.total, jobs: r.jobs.map(j => ({ ...brief(j), ...priorFields(j, rows) })) };
  }));

  server.registerTool("get_job", {
    title: "Get job", description: "Full posting text plus this job's application status, pack and history.",
    inputSchema: { job_id: jobId }, annotations: RO,
  }, wrap(async ({ job_id }) => {
    const job = await getJobFull(job_id);
    if (!job) throw new Error(`No job ${job_id}`);
    const app = db.getApplication(job_id);
    // The confirmation code is only handed out by fill_application, next to the preview the user must see.
    const application = app ? { ...app, confirmationCode: undefined } : undefined;
    return { job, application, pack: loadPack(job_id), events: db.listEvents(job_id, 20), ...priorFields(job) };
  }));

  server.registerTool("list_matches", {
    title: "List matches",
    description: "Open roles ranked against the user's profile targets and resume, with the reasons for each score.",
    inputSchema: {
      limit: z.number().optional().describe("Default 15"), postedWithinDays: z.number().optional(),
      minScore: z.number().optional(), query: z.string().optional().describe("Optional extra filter words"),
    },
    annotations: RO,
  }, wrap((o) => {
    const rows = appliedRows();
    return listMatches({ limit: o.limit ?? 15, postedWithinDays: o.postedWithinDays, minScore: o.minScore, query: o.query })
      .map(m => ({ score: m.score, reasons: m.reasons, ...brief(m.job, 160), ...priorFields(m.job, rows) }));
  }));

  server.registerTool("index_stats", {
    title: "Index stats", description: "Size and freshness of the local job index.", annotations: RO,
  }, wrap(() => db.jobStats()));

  server.registerTool("discover_company", {
    title: "Discover company board",
    description: "Find a company's job board on any supported ATS by name, add it to the index, and sync it now. For a Workday employer pass its career-site URL (https://<tenant>.wd<N>.myworkdayjobs.com/<site>) instead of the name.",
    inputSchema: { name: z.string() }, annotations: { openWorldHint: true },
  }, wrap(async ({ name }) => {
    const hits = await discoverCompany(name);
    const live = hits.filter(h => h.jobCount > 0);
    if (live.length) {
      addUserBoards(live);
      const r = await sync({ boards: live, feeds: false });
      return { found: hits, synced: { newJobs: r.newJobs, jobsSeen: r.jobsSeen } };
    }
    return { found: hits, note: hits.length ? "Board exists but has no open roles." : "No board found on supported ATSes." };
  }));

  // ---- tailoring ----
  server.registerTool("get_tailoring_brief", {
    title: "Get tailoring brief",
    description: "Everything needed to write a tailored application for one job: the posting, the master resume, the profile, and the rules. Write the tailored resume (same JSON shape as the master), a cover letter, and answers, then call save_application_pack. formQuestions are the form's real questions (read from the employer's ATS): answer the ones with needsAnswer, keyed by the exact question text; questionsHint is only a generic fallback when the form could not be read.",
    inputSchema: { job_id: jobId }, annotations: RO,
  }, wrap(({ job_id }) => tailoringBrief(job_id)));

  server.registerTool("save_application_pack", {
    title: "Save application pack",
    description: "Store the tailored resume, cover letter and answers for a job. Runs the truth guard against the master resume and renders resume.pdf and cover-letter.pdf (or uses resume_pdf, the user's own finished resume, as is). Required form questions left unanswered are added as \"TODO (you)\" answers, and answers that match no form question are flagged \"Not on the form\". Fix any warnings and save again before applying.",
    inputSchema: {
      job_id: jobId,
      resume: z.any().describe("Tailored Resume object, same shape as the master"),
      cover_letter: z.string().optional().describe("Plain text, paragraphs separated by blank lines"),
      answers: z.record(z.string(), z.string()).optional().describe("Application question -> answer"),
      resume_pdf: z.string().optional().describe("Absolute path to the user's own finished resume PDF. Uploaded as is (keeps its filename) instead of rendering resume.pdf"),
    },
  }, wrap(async ({ job_id, resume, cover_letter, answers, resume_pdf }) => savePack(job_id, { resume, coverLetter: cover_letter, answers, resumePdf: resume_pdf })));

  server.registerTool("draft_why_us", {
    title: "Draft a why-us answer",
    description: "Draft answers to \"Why do you want to work at X?\" / \"What interests you in X?\" for a job's pack. " +
      "With job_id only: returns the pack's why-us questions (state todo, drafted or written), companyFacts (the posting, why-now signals), " +
      "evidence (the user's real resume bullets, projects and proof points, with ids), the avoid list (claims the user's records do not back), examples of answers they already sent, and the rules. " +
      "With question and answer: checks and saves that answer as a DRAFT for the user's review (the dashboard shows it as \"Drafted, review\"; fill stays locked until they edit or keep it) and returns the warnings for it. " +
      "Set no_link when nothing honestly ties the company to the user's work: a short stub is saved that the user must rewrite. Never invent a reason; never submit anything.",
    inputSchema: {
      job_id: jobId,
      question: z.string().optional().describe("Exact question text as it appears in the pack"),
      answer: z.string().optional().describe("The drafted paragraph (60 to 110 words). Optional with no_link"),
      no_link: z.boolean().optional().describe("No honest link between the company and the user's work: save a stub for the user to rewrite"),
      link: z.string().optional().describe("One line: the company fact and the evidence id the draft ties together"),
      replace: z.boolean().optional().describe("Overwrite an answer the user wrote themselves. Only when the user says so"),
    },
  }, wrap(async ({ job_id, question, answer, no_link, link, replace }) => {
    const w = await import("./whyus.js");
    if (question === undefined) return w.whyUsBrief(job_id);
    return w.saveWhyUs(job_id, { question, answer, noLink: no_link, link, replace });
  }));

  server.registerTool("get_application_pack", {
    title: "Get application pack", description: "The saved tailored pack for a job, with PDF paths and warnings.",
    inputSchema: { job_id: jobId }, annotations: RO,
  }, wrap(({ job_id }) => loadPack(job_id) ?? { error: "No pack yet. Use get_tailoring_brief then save_application_pack." }));

  // ---- applying ----
  server.registerTool("inspect_application", {
    title: "Inspect application form",
    description: "Open the employer's application form in the browser and list every field, what OpenApply would fill from the profile and pack, and which required questions still need answers.",
    inputSchema: { job_id: jobId }, annotations: { readOnlyHint: true, openWorldHint: true },
  }, wrap(({ job_id }) => inspectForm(job_id)));

  server.registerTool("fill_application", {
    title: "Fill application form",
    description: "Fill the employer's form in a visible browser window (does NOT submit). Uploads the tailored resume and cover letter. Refuses when the same company and a similar title were already applied to under another job id (pass force only if the user says to apply again), and refuses while any answer, or a required form question with no answer, is still TODO or blank. Returns what was filled, what was skipped, a screenshot path, and a one-time confirmation code. Show the user the result and get an explicit yes before submit_application.",
    inputSchema: {
      job_id: jobId,
      answers: z.record(z.string(), z.string()).optional().describe("Answers for questions, keyed by the field label from inspect_application"),
      remember: z.boolean().optional().describe("Save these answers to the profile for future forms"),
      force: z.boolean().optional().describe("Apply even though this role (same company, similar title) was already applied to. Only when the user says so"),
    },
    annotations: { openWorldHint: true },
  }, wrap(({ job_id, answers, remember, force }) => fillForm(job_id, answers, remember, force)));

  server.registerTool("submit_application", {
    title: "Submit application",
    description: "Submit the filled form. Requires the confirmation code from fill_application, which you may only pass after the user explicitly approved this exact application (or the user approved it in the dashboard). Stops with needs_human on a CAPTCHA or login wall; the user then finishes in the open browser. Returns verification_failed when the employer's form refused the submission (Lever: 'There was an error verifying your application', resume dropped): nothing went in, and the user finishes in their own normal browser at applyUrl, attaching resume. On Lever only the /thanks page or 'Application submitted!' counts as submitted.",
    inputSchema: {
      job_id: jobId,
      confirmation_code: z.string().optional().describe("Code from fill_application, only after the user said yes"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, wrap(({ job_id, confirmation_code }) => submitForm(job_id, confirmation_code)));

  server.registerTool("close_browser", {
    title: "Close browser", description: "Close the application browser window.",
  }, wrap(async () => { await closeBrowser(); return { closed: true }; }));

  // ---- tracking ----
  server.registerTool("save_job", {
    title: "Save job", description: "Bookmark a job in the pipeline.",
    inputSchema: { job_id: jobId, notes: z.string().optional() },
  }, wrap(({ job_id, notes }) => {
    const application = saveJob(job_id, notes);
    return { ...application, ...priorFields(db.getJob(job_id)!) };
  }));

  server.registerTool("update_application", {
    title: "Update application",
    description: "Move an application to a new status (saved, drafted, filled, submitted, needs_human, interview, offer, rejected, withdrawn, ghosted) with an optional note. Use 'submitted' when the user finished an application themselves. On a Lever job, say in the note that the user saw the /thanks page or 'Application submitted!'; without that a note records that no confirmation was seen. Approval to submit is not a status you can set: it comes from the confirmation code the user agreed to, or from the user approving in the dashboard.",
    inputSchema: {
      job_id: jobId,
      status: z.enum(["saved", "drafted", "filled", "submitted", "needs_human", "interview", "offer", "rejected", "withdrawn", "ghosted"]),
      note: z.string().optional(),
    },
  }, wrap(({ job_id, status, note }) => updateStatus(job_id, status, note)));

  server.registerTool("list_applications", {
    title: "List applications", description: "Applications in the pipeline, optionally filtered by status.",
    inputSchema: { status: z.string().optional() }, annotations: RO,
  }, wrap(({ status }) => db.listApplications(status as any).map(a => ({
    jobId: a.jobId, status: a.status, updatedAt: a.updatedAt, submittedAt: a.submittedAt, notes: a.notes, source: a.source,
    title: a.job?.title, company: a.job?.company, url: a.job?.url,
  }))));

  server.registerTool("import_history", {
    title: "Import application history",
    description: "Record applications made before OpenApply (from the old tracker, email, another tool). Each record attaches to the matching job (same url, or same company and title) or gets a closed placeholder job that never shows in search or matches; the application takes the status and date given and an 'Imported from history' event. Safe to run again: returns {created, attached, unchanged}. Imported rows show source: \"history\" and feed the duplicate warnings (priorApplications).",
    inputSchema: {
      records: z.array(z.object({
        company: z.string(), title: z.string(),
        appliedAt: z.string().describe("Date applied, e.g. 2026-08-28"),
        status: z.enum(HISTORY_STATUSES as [string, ...string[]]),
        url: z.string().optional().describe("The posting URL, when known: matches an indexed job exactly"),
      })),
    },
  }, wrap(({ records }) => importHistory(records as any)));

  server.registerTool("log_applied_offsite", {
    title: "Log application sent elsewhere",
    description: "Record an application the user already sent outside OpenApply (LinkedIn Easy Apply, a company site). Goes through import_history, so it attaches to the matching job (the posting at that url, else the same company and title, since a LinkedIn url is not the board posting) or a closed placeholder, and never changes an application that already went in. Only for applications the user actually sent.",
    inputSchema: {
      company: z.string(), title: z.string(),
      url: z.string().optional().describe("The posting URL, when known"),
      date: z.string().describe("Date applied, YYYY-MM-DD with the year, e.g. 2026-11-02"),
    },
  }, wrap(({ company, title, url, date }) => logAppliedOffsite({ company, title, url, date })));

  server.registerTool("apply_outcomes", {
    title: "Apply outcomes from mail",
    description: "Call after reading mail; never invent outcomes. Records what employers said: kind rejected, interview or ack (application received). Silence is not an outcome: pipeline_summary's ageOut proposes those. Each item matches one application by company (and title when given); several matches come back as ambiguous and nothing changes. Status only moves forward, never touches saved, drafted, filled or approved applications, and never changes an offer, rejected or withdrawn one. A rejection or ack dated before the application went in is skipped. An interview adds a dated event. A rejection returns proposals to close open outreach at that company (close them with update_outreach only if the user agrees). Each source_id applies once per application (one mail that names two roles can be sent as two items with the same source_id), so re-running the same mail is safe. Returns {applied, skipped, ambiguous, proposals}.",
    inputSchema: {
      items: z.array(z.object({
        company: z.string(),
        title: z.string().optional().describe("The role the mail names, when it names one"),
        kind: z.enum(OUTCOME_KINDS as [string, ...string[]]),
        date: z.string().describe("When the mail arrived, or the interview time, starting YYYY-MM-DD, e.g. 2026-11-06T10:00"),
        source_id: z.string().describe("The mail's message id: the same id never applies twice to one application"),
        snippet: z.string().optional().describe("The line from the mail that shows the outcome"),
        date_source: z.string().optional().describe("Interview only: invite or invite-wall-time when date is the invitation's start, mail when it is the day the mail came"),
        mail_date: z.string().optional().describe("Interview only: the day the mail came, when date is the invitation's start"),
      })),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(({ items }) => applyOutcomes(items as any)));

  server.registerTool("pipeline_summary", {
    title: "Pipeline summary",
    description: "Counts by status, recent activity, and ageOut: submitted applications with no answer for 45+ days, proposed as ghosted (move them with update_application only if the user agrees).",
    annotations: RO,
  }, wrap(() => { const p = pipeline(); return { counts: p.counts, recent: p.recent.slice(0, 20), ageOut: ageOutProposals() }; }));

  server.registerTool("log_event", {
    title: "Log event",
    description: "Record something that happened on an application: recruiter_reply, interview_scheduled, assessment, follow_up_sent, referral, etc.",
    inputSchema: { job_id: jobId, kind: z.string(), detail: z.string().optional() },
  }, wrap(({ job_id, kind, detail }) => {
    if (!db.getJob(job_id)) throw new Error(`Unknown job ${job_id}`);
    db.addEvent(job_id, kind, detail);
    return { logged: true };
  }));

  server.registerTool("open_dashboard", {
    title: "Open dashboard",
    description: "Start the local review dashboard (matches, packs, approvals, pipeline) and return its URL for the user.",
  }, wrap(async () => {
    const { startServer } = await import("./server/http.js");
    try {
      const s = await startServer(Number(process.env.OPENAPPLY_PORT) || 4646);
      return { url: s.url };
    } catch (e: any) {
      if (e?.code === "EADDRINUSE") return { url: `http://127.0.0.1:${Number(process.env.OPENAPPLY_PORT) || 4646}`, note: "Already running." };
      throw e;
    }
  }));

  // ---- research + outreach (recruiters: warm outbound and real understanding beat volume) ----
  server.registerTool("company_brief", {
    title: "Company brief",
    description: "Research scaffold for one job: hiring signals from the index (open roles, growth by team), why-now inferences from the posting, a checklist to research with your web tools, proof-of-work project ideas, and sharp questions to ask. Use before tailoring and before outreach.",
    inputSchema: { job_id: jobId }, annotations: RO,
  }, wrap(async ({ job_id }) => {
    const b = await companyBrief(job_id);
    return { ...b, job: b.job ? brief(b.job, 600) : undefined };
  }));

  server.registerTool("hiring_signals", {
    title: "Hiring signals", description: "How a company is hiring right now, from the local index: open and new roles, departments, locations, seniority mix.",
    inputSchema: { company: z.string() }, annotations: RO,
  }, wrap(({ company }) => hiringSignals(company)));

  server.registerTool("get_outreach_brief", {
    title: "Get outreach brief",
    description: "Who to contact at a company (recruiter, hiring manager, team member, founder), which channel, and the rules for a short message in the user's own voice. OpenApply never invents people or contact details: get names and addresses from the user or your own research. Draft, show the user, and let them send it.",
    inputSchema: { company: z.string(), job_id: jobId.optional() }, annotations: RO,
  }, wrap(({ company, job_id }) => outreachBrief(company, job_id)));

  server.registerTool("log_outreach", {
    title: "Log outreach",
    description: "Record a message the user sent (email, LinkedIn, X, text, intro request, event chat) so follow-ups can be tracked.",
    inputSchema: {
      company: z.string(), person: z.string(), channel: z.string(),
      job_id: jobId.optional(), role: z.string().optional(), contact: z.string().optional(),
      message: z.string().optional(), notes: z.string().optional(),
    },
  }, wrap((a) => logOutreach({ company: a.company, person: a.person, channel: a.channel, jobId: a.job_id, role: a.role, contact: a.contact, message: a.message, notes: a.notes })));

  server.registerTool("draft_outreach", {
    title: "Draft outreach",
    description: "Save a message for the user to send themselves. It shows in the dashboard under Outreach, Ready to send, with copy and 'I sent it' buttons; marking it sent starts follow-up tracking.",
    inputSchema: {
      company: z.string(), person: z.string(), channel: z.string(), message: z.string(),
      job_id: jobId.optional(), role: z.string().optional(), contact: z.string().optional(), notes: z.string().optional(),
    },
  }, wrap((a) => draftOutreach({ company: a.company, person: a.person, channel: a.channel, message: a.message, jobId: a.job_id, role: a.role, contact: a.contact, notes: a.notes })));

  server.registerTool("update_outreach", {
    title: "Update outreach",
    description: "Mark an outreach touch as sent (a draft the user just sent), replied, meeting, closed, or record that a follow-up was sent. " +
      "message rewrites the text of an unsent draft (status draft only; same rules as draft_outreach). The voice check runs again: rewrite anything in warnings flagged \"Voice:\" before the user sends it. " +
      "A sent message is the record of what went out and is refused; log a follow-up instead.",
    inputSchema: {
      id: z.number(), status: z.enum(["sent", "replied", "meeting", "no_reply", "closed"]).optional(),
      followed_up: z.boolean().optional(), notes: z.string().optional(), message: z.string().optional(),
    },
  }, wrap(({ id, status, followed_up, notes, message }) => updateOutreach(id, { status, followedUp: followed_up, notes, message })));

  server.registerTool("list_outreach", {
    title: "List outreach", description: "Outreach history, optionally for one company or status.",
    inputSchema: { company: z.string().optional(), status: z.string().optional() }, annotations: RO,
  }, wrap(({ company, status }) => listOutreach({ company, status: status as any })));

  server.registerTool("due_follow_ups", {
    title: "Follow-ups due",
    description: "Outreach that needs a decision, each row with a `kind` and a suggestion. " +
      "kind send_or_close: a draft the user has not sent for draft_days (default 2) or more. It was never sent, so never write a follow-up for it or mark followed_up; ask the user to send it (then update_outreach status sent) or close it. " +
      "If it has waitingOn \"submit\", hold it until the application is submitted. " +
      "kind propose_close: the linked application was rejected or withdrawn. Propose closing it to the user; never close it without their yes. " +
      "kind follow_up: a sent message with no reply for `days` (default 7) or more, up to 3 follow-ups each. Only these get a nudge, and the suggestion says what new value to add.",
    inputSchema: { days: z.number().optional(), draft_days: z.number().optional() }, annotations: RO,
  }, wrap(({ days, draft_days }) => dueFollowUps({ days, draftDays: draft_days })));

  server.registerTool("strategy_scoreboard", {
    title: "Strategy scoreboard",
    description: "Read-only. The job-search strategy's scoreboard (strategy.json in the data dir; built-in defaults with a warning when there is none, and this tool never writes it): " +
      "this week's warm asks sent (new people), applications sent, first conversations and rounds passed against the weekly targets (halved once if too few lead companies are in by the end of week 1); " +
      "48-hour flags (submitted applications with no named person contacted within 48 hours, with hours elapsed and any ready draft not on HOLD); " +
      "day-7 follow-ups due; the lead companies (applied, asked, person named, last touch, next action, the strategy's first move); live processes and the gate verdict; days to each milestone. " +
      "It counts sends and conversations, never artifacts made. Use it for the weekly scoreboard and to pick the next send; it changes nothing.",
    annotations: RO,
  }, wrap(() => strategyScoreboard()));

  // ---- prompts ----
  server.registerPrompt("find_and_apply", {
    title: "Find roles and get the best one ready",
    description: "Search, rank, tailor and prepare an application, holding it for approval.",
    argsSchema: { goal: z.string().optional().describe("e.g. remote product design roles") },
  }, ({ goal }) => ({
    messages: [{
      role: "user", content: {
        type: "text",
        text: `Using OpenApply: ${goal ? `find ${goal}.` : "find roles that fit me."} Start with get_started. Rank matches, pick the strongest 3 and tell me why. For the best one, write a tailored pack (no invented facts), inspect and fill the form, then show me exactly what would be sent and wait for my yes before submitting.`,
      },
    }],
  }));
}
