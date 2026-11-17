/**
 * Drafts for "why do you want to work at X?" answers. OpenApply does not write the prose itself (no LLM here): the
 * brief hands an agent the company's facts and the user's real material, and saveWhyUs stores what it wrote as an
 * answer awaiting the user's review (pack.drafted), so it never passes as finished and fill stays locked until the
 * user edits or keeps it. The pack guard (tailor.ts checkPack, whyus-check.ts) checks it like any other answer.
 */
import { getApplication, listApplications } from "./db.js";
import { getJobFull } from "./details.js";
import { companyBrief } from "./intel.js";
import { loadProfile, loadResume } from "./profile.js";
import { loadPack, packTodos, updatePack } from "./tailor.js";
import { isWhyUs, whyUsQuestions, WHY_US_WORDS } from "./whyus-check.js";
import type { ApplicationStatus } from "./types.js";

const TODO = /\btodo \([^()\n]{1,30}\)/i; // same marker as tailor.ts: any short owner
const SENT = new Set<ApplicationStatus>(["submitted", "needs_human", "interview", "offer", "rejected", "withdrawn", "ghosted"]);
/** Below this much posting text there is too little about the company to tie anything to honestly. */
const THIN_POSTING = 300;

export interface Evidence { id: string; from: string; text: string }

/** The user's real material, one item per checkable claim: resume bullets and projects, then proof points and story. */
export function evidenceBank(): Evidence[] {
  const r = loadResume();
  const p = loadProfile();
  const out: Evidence[] = [];
  (r?.experience ?? []).forEach((e, i) => (e.bullets ?? []).forEach((b, j) => out.push({ id: `exp${i + 1}.${j + 1}`, from: `${e.company}, ${e.title}`, text: b })));
  (r?.projects ?? []).forEach((x, i) => {
    const t = [x.description, ...(x.bullets ?? [])].filter(Boolean).join(" ");
    if (t) out.push({ id: `proj${i + 1}`, from: x.name, text: t });
  });
  (p?.proofPoints ?? []).forEach((t, i) => out.push({ id: `proof${i + 1}`, from: "profile.proofPoints", text: t }));
  if (p?.story?.trim()) out.push({ id: "story", from: "profile.story", text: p.story.trim() });
  return out;
}

type QState = "todo" | "drafted" | "written";

const RULES = [
  `Write ONE paragraph, ${WHY_US_WORDS.min} to ${WHY_US_WORDS.max} words, first person, in the user's plain voice.`,
  "Tie ONE specific thing about this company (its product, its customers, or the problem the posting says it is hiring for; quote it from companyFacts.posting) to ONE specific thing the user has actually done (one evidence item). Name the company.",
  "Only true claims. Every fact about the user comes from an evidence item; every number appears in that item exactly. Never use anything on the avoid list.",
  "No em dashes, never \"honestly\" or \"the honest answer\", no three-item lists, no filler (passionate, thrilled, leverage, excited to apply). Never name another company the user is applying to.",
  "examples are answers the user already sent elsewhere: copy their shape and plainness, never their company facts.",
  "If no evidence item honestly connects to something specific about this company (or companyFacts.thin is true), do not stretch: save with no_link true and a one or two sentence true stub the user will rewrite.",
  "Save with draft_why_us (job_id, question, answer, link: \"<company fact> -> <evidence id>\"). If it returns warnings for this answer, fix them and save again, at most twice.",
];

/** Everything an agent needs to draft the why-us answers for one job's pack. */
export async function whyUsBrief(jobId: string) {
  const job = await getJobFull(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  const pack = loadPack(jobId);
  if (!pack) throw new Error(`No pack for ${jobId}: draft the pack first (save_application_pack), then the why-us answers.`);
  const state = (q: string): QState => (pack.drafted?.[q] ? "drafted" : TODO.test(pack.answers[q] ?? "") || !(pack.answers[q] ?? "").trim() ? "todo" : "written");
  const questions = whyUsQuestions(pack.answers, job.company).map(q => ({ question: q, state: state(q), current: pack.answers[q] }));
  const cb = await companyBrief(jobId);
  const posting = job.description.trim();
  return {
    job: { id: job.id, company: job.company, title: job.title, location: job.location, url: job.url },
    questions,
    companyFacts: {
      posting: posting.length > 8000 ? `${posting.slice(0, 8000)}...` : posting,
      thin: posting.length < THIN_POSTING,
      whyNow: cb.whyNow,
      openRoles: cb.signals.openRoles,
    },
    evidence: evidenceBank(),
    avoid: loadProfile()?.avoidClaims ?? [],
    examples: sentExamples(jobId),
    rules: RULES,
    note: questions.length ? undefined : "This pack has no why-us question; nothing to draft.",
  };
}

/** Why-us answers the user already sent (submitted or later), at most 2: the voice to match. */
function sentExamples(jobId: string): Array<{ company: string; question: string; answer: string }> {
  const out: Array<{ company: string; question: string; answer: string }> = [];
  for (const a of listApplications([...SENT])) {
    if (a.jobId === jobId || out.length >= 2) continue;
    const pack = loadPack(a.jobId);
    for (const q of whyUsQuestions(pack?.answers, a.job?.company)) {
      const v = pack!.answers[q];
      if (v && !TODO.test(v) && !pack!.drafted?.[q]) { out.push({ company: a.job?.company ?? "", question: q, answer: v }); break; }
    }
  }
  return out;
}

/** The stub saved when no honest link exists and the drafter wrote none: true, short, and flagged for rewriting. */
export const noLinkStub = (company: string, title: string) =>
  `I am applying for the ${title} role at ${company}. (No honest link found between ${company} and your work yet: rewrite this with your own reason.)`;

/**
 * Save a drafted why-us answer for the user's review. Refuses questions that are not why-us, packs already sent, and
 * an answer the user wrote themselves (pass replace to overwrite it). With noLink and no answer, saves the stub.
 */
export async function saveWhyUs(jobId: string, input: { question: string; answer?: string; noLink?: boolean; link?: string; replace?: boolean }) {
  const pack = loadPack(jobId);
  if (!pack) throw new Error(`No pack for ${jobId}`);
  const job = await getJobFull(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  const status = getApplication(jobId)?.status;
  if (status && SENT.has(status)) throw new Error(`Cannot draft for ${jobId}: already ${status}`);
  const q = input.question;
  if (!Object.hasOwn(pack.answers, q)) throw new Error(`Not a question in this pack: ${q}. Questions: ${Object.keys(pack.answers).join(" | ")}`);
  if (!isWhyUs(q, job.company)) throw new Error(`Not a why-us question: ${q}`);
  const cur = pack.answers[q] ?? "";
  const own = cur.trim() && !TODO.test(cur) && !pack.drafted?.[q];
  if (own && !input.replace) throw new Error(`"${q}" already has your own answer; pass replace to overwrite it`);
  let answer = (input.answer ?? "").trim();
  if (!answer && !input.noLink) throw new Error("answer is required (or set no_link for the stub)");
  if (!answer) answer = noLinkStub(job.company, job.title);
  if (TODO.test(answer)) throw new Error("A drafted answer cannot be a TODO; leave the TODO as it is instead");

  const saved = await updatePack(jobId, {
    answers: { [q]: answer },
    drafted: { [q]: { at: new Date().toISOString(), ...(input.noLink ? { noLink: true } : {}), ...(input.link ? { link: input.link.slice(0, 300) } : {}) } },
  });
  return {
    question: q,
    answer,
    noLink: !!input.noLink,
    warnings: saved.warnings.filter(w => w.includes(`"${q}"`) || /^Voice:/.test(w)),
    todos: packTodos(saved),
    note: "Saved as a draft for the user's review: it counts as unfinished (fill stays locked) until they edit it or keep it in the dashboard.",
  };
}
