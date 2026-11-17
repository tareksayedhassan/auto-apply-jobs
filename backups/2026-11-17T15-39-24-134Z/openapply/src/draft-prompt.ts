/**
 * The prompt for the dashboard's "Draft pack" button: a headless `claude -p` run that may only call
 * the OpenApply tools listed in runs.ts. Edit freely; the job id, base resume path and its track (resume-track.ts)
 * are filled in.
 */
export function draftPrompt(jobId: string, resumePdf: string, track: string, reason: string): string {
  return `You are drafting a job application pack for the user, using only the openapply tools.

Job id: ${jobId}
Resume track: ${track} (${reason}); resume_pdf in step 3 is that track's PDF, do not swap it for another.

Steps:
1. Call get_tailoring_brief and company_brief for this job id. Call get_profile if you need more.
2. Write a cover letter (150 to 250 words) and the answers the form needs. When the brief has formQuestions (the real
   form), answer every question with needsAnswer true, keyed by its EXACT question text; skip the ones with willFill
   (OpenApply enters those from the profile) and leave optional ones out unless the profile makes the answer obvious.
   Choice questions: the answer is one of the listed options. Only when formQuestions is missing, answer the likely
   questions from questionsHint instead.
3. Call save_application_pack once with:
   - job_id: ${jobId}
   - resume: the master resume from the brief, unchanged. Do NOT write a tailored resume.
   - resume_pdf: ${resumePdf} (the user's own resume PDF, uploaded as is)
   - cover_letter and answers as written
4. If save_application_pack returns warnings, fix the cover letter or answers and save again (at most twice).
5. If the pack has a why-us question, call draft_why_us with job_id only, follow the rules it returns, and save each
   draft with draft_why_us. It is saved as a draft the user reviews; never write one without a true link to their work.

Voice (the user's own, from the brief's voiceSamples):
- Plain, short, specific. Every sentence must be about this company or this person.
- No em dashes anywhere.
- No filler: honestly, passionate, thrilled, leverage, proven track record, fast-paced, dynamic, seamless, robust.

Truth:
- Never invent employers, titles, dates, numbers, schools or skills. Use only the master resume, profile and profile.story.
- For any "why this company" / "why us" question, save the answer as exactly "TODO (you): one specific, true reason."
  in step 3; step 5 drafts it for the user's review.
- Personal facts you cannot find in the profile (start date, salary, references) and any form question only the user can answer get the same kind of TODO answer.
- Relocating, office or on-site days, commuting, travel, or starting in a given city: never answer these yourself, not even
  "yes". Use a saved answer only when it names that exact city (a New York answer does not answer a San Francisco or
  Chicago question; a question that names no city means the job's city, unless the job is remote). Otherwise set the
  answer to exactly "TODO (you): answer this form question". Skip it if the brief marks it willFill.

Do not call any other tools. Do not fill or submit anything. When the pack is saved, reply with one line: the number of warnings left.`;
}

/** The prompt for the dashboard's why-us "Draft" button: a headless run that may only call draft_why_us. */
export function whyUsPrompt(jobId: string, question?: string): string {
  return `You are drafting the user's answer to "why do you want to work here" for one job application, using only the openapply tool draft_why_us.

Job id: ${jobId}
${question ? `Question: ${JSON.stringify(question)} (draft only this one)` : "Draft every why-us question whose state is \"todo\" or \"drafted\"; leave \"written\" ones alone."}

1. Call draft_why_us with job_id only. It returns the questions, companyFacts (the posting), evidence (the user's real work), avoid, examples and rules.
2. For each question, find ONE specific thing in companyFacts.posting and ONE evidence item that truly connect. Write the answer by the rules.
   If nothing connects honestly, save with no_link true and a short true stub instead of stretching.
3. Save it: draft_why_us with job_id, question (exact text), answer, and link ("<company fact> -> <evidence id>").
4. If the save returns warnings about this answer, fix them and save again, at most twice.

Nothing is filled or sent; the user reviews every draft. Reply with one line per question: saved or no link, and warnings left.`;
}
