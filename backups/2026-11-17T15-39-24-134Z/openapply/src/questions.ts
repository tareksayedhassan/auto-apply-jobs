/**
 * The employer's real application questions, read from the ATS's public form data instead of a browser, so a
 * pack can be written (and checked) against what the form will actually ask. Greenhouse and Ashby (APIs) and
 * Lever (the public apply page's HTML); every failure resolves undefined and callers fall back to guessing.
 */
import { isLever } from "./apply/detect.js";
import { kvGetJson, kvSetJson } from "./db.js";
import { postingId } from "./details.js";
import { getJson, str, USER_AGENT } from "./sources/http.js";
import { decodeEntities } from "./text.js";
import type { FormField, Job } from "./types.js";

const TTL_MS = 12 * 3600_000; // forms rarely change between drafting a pack and filling it; the fill reads the live form anyway
const cacheKey = (jobId: string) => `formq:${jobId}`;

const ASHBY_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    applicationForm { sections { fieldEntries { ... on FormFieldEntry { field isRequired } } } }
  }
}`;

const GH_TYPES: Record<string, FormField["type"]> = {
  input_text: "text", textarea: "textarea", input_file: "file",
  multi_value_single_select: "select", multi_value_multi_select: "checkbox",
};

function greenhouse(d: any): FormField[] {
  const out: FormField[] = [];
  for (const q of [...(d?.questions ?? []), ...(d?.location_questions ?? [])]) {
    const fields: any[] = Array.isArray(q?.fields) ? q.fields : [];
    const f = fields.find(x => x?.type === "input_file") ?? fields[0]; // Resume/CV and Cover Letter offer a file or pasted text
    if (!f || f.type === "input_hidden" || !str(q.label)) continue; // latitude/longitude ride along with the location widget
    const options = (Array.isArray(f.values) ? f.values : []).map((v: any) => str(v?.label)).filter(Boolean);
    out.push({ key: str(f.name), label: str(q.label), type: GH_TYPES[f.type] ?? "unknown", required: !!q.required, ...(options.length ? { options } : {}) });
  }
  return out;
}

const ASHBY_TYPES: Record<string, FormField["type"]> = {
  String: "text", Email: "email", Phone: "tel", LongText: "textarea", File: "file", ValueSelect: "select",
  MultiValueSelect: "checkbox", Number: "number", Date: "date", Boolean: "select",
};

function ashby(d: any): FormField[] {
  const out: FormField[] = [];
  for (const section of d?.data?.jobPosting?.applicationForm?.sections ?? []) {
    for (const e of section?.fieldEntries ?? []) {
      const f = e?.field;
      if (!f || f.isDeactivated || !str(f.title)) continue;
      const options = f.type === "Boolean" ? ["Yes", "No"]
        : (Array.isArray(f.selectableValues) ? f.selectableValues : []).filter((v: any) => !v?.isArchived).map((v: any) => str(v?.label)).filter(Boolean);
      out.push({ key: str(f.path), label: str(f.title), type: ASHBY_TYPES[f.type] ?? "unknown", required: !!e.isRequired, ...(options.length ? { options } : {}) });
    }
  }
  return out;
}

const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1];
const plain = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/[*✱]/g, "").replace(/\s+/g, " ").trim();

/** Controls that belong to the applicant's profile, not the pack: the EEO and demographic surveys, GDPR consent. */
const NOT_PACK = /^(eeo|surveysResponses|consent)\[/;

/**
 * Lever has no question API, so read the public apply page: one `application-question` block per question (the
 * standard fields and every `cards[...]` custom question share the markup), plus the "Additional information"
 * textarea (`comments`) when the posting has one. A block with controls but no readable label means a layout this
 * reader does not know; give up (return nothing) rather than flag real questions as "Not on the form".
 */
function lever(html: string): FormField[] {
  const form = html.match(/<form\b[^>]*\bid="application-form"[\s\S]*?<\/form>/i)?.[0] ?? "";
  const out: FormField[] = [];
  for (const chunk of form.split(/(?=<(?:li|div)\b[^>]*\bclass="(?:application-question|section)[\s"])/)) {
    const controls = [...chunk.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>|<(?:input|textarea)\b[^>]*>/gi)].map(m => m[0])
      .filter(c => { const n = attr(c, "name"); return n && !NOT_PACK.test(n) && attr(c, "type")?.toLowerCase() !== "hidden"; });
    const first = controls[0];
    if (!first) continue;
    const key = attr(first, "name")!;
    const labelHtml = chunk.match(/\bclass="application-label[^"]*">([\s\S]*?)<div class="application-field/)?.[1] ?? "";
    const label = plain(labelHtml) || (key === "comments" ? "Additional information" : "");
    if (!label) return [];
    const tag = first.match(/^<(\w+)/)![1].toLowerCase();
    const kind = (attr(first, "type") ?? "text").toLowerCase();
    const group = controls.filter(c => attr(c, "name") === key);
    const options = tag === "select" ? [...first.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map(m => plain(m[1])).filter(Boolean)
      : kind === "radio" || kind === "checkbox" ? group.filter(c => attr(c, "type")?.toLowerCase() === kind).map(c => plain(attr(c, "value") ?? "")).filter(Boolean) : [];
    const type: FormField["type"] = tag === "textarea" ? "textarea" : tag === "select" || kind === "radio" ? "select" : kind === "checkbox" ? "checkbox"
      : kind === "file" ? "file" : (["email", "tel", "url", "number", "date"] as const).find(t => t === kind) ?? "text";
    const required = /class="required"/.test(labelHtml) || /\srequired(?=[\s=>/])/.test(first);
    out.push({ key, label, type, required, ...(options.length ? { options } : {}) });
  }
  return out;
}

const leverApplyUrl = (job: Job) => {
  const u = job.applyUrl || job.url;
  return isLever(u) ? (/\/apply\/?$/.test(u) ? u : `${u.replace(/\/$/, "")}/apply`) : `https://jobs.lever.co/${job.boardSlug}/${encodeURIComponent(postingId(job))}/apply`;
};

async function getHtml(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function fetchQuestions(job: Job): Promise<FormField[] | undefined> {
  const id = postingId(job);
  const opts = { retries: 0, timeoutMs: 8000 };
  if (job.ats === "greenhouse") return greenhouse(await getJson<any>(`https://boards-api.greenhouse.io/v1/boards/${job.boardSlug}/jobs/${encodeURIComponent(id)}?questions=true`, opts));
  if (job.ats === "ashby") {
    const body = { operationName: "ApiJobPosting", variables: { organizationHostedJobsPageName: job.boardSlug, jobPostingId: id }, query: ASHBY_QUERY };
    return ashby(await getJson<any>("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", { ...opts, body }));
  }
  if (job.ats === "lever") return lever(await getHtml(leverApplyUrl(job), opts.timeoutMs));
  return undefined; // the rest: no public question source yet
}

/** The job's real form questions in form order, or undefined when they could not be read (never throws). Cached 12 hours. */
export async function formQuestions(job: Job): Promise<FormField[] | undefined> {
  try {
    const hit = kvGetJson<{ at: number; fields: FormField[] }>(cacheKey(job.id));
    if (hit && Date.now() - hit.at < TTL_MS) return hit.fields;
    const fields = await fetchQuestions(job);
    if (fields?.length) kvSetJson(cacheKey(job.id), { at: Date.now(), fields });
    return fields?.length ? fields : undefined;
  } catch {
    return undefined;
  }
}
