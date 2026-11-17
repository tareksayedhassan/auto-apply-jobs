import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-questions-"));
const db = await import("../src/db.js");
const profile = await import("../src/profile.js");
const imp = await import("../src/resume-import.js");
const tailor = await import("../src/tailor.js");
const { formQuestions } = await import("../src/questions.js");
const engine = await import("../src/apply/engine.js");
const { suggest } = await import("../src/apply/fieldmap.js");
const { closePdfBrowser } = await import("../src/pdf.js");
after(() => closePdfBrowser());

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/ats/${name}`, import.meta.url)), "utf8");
const GH = fixture("greenhouse-questions.json");
const ASHBY = fixture("ashby-form.json");
// Lever apply pages trimmed to the <form>, with ids, names and question wording changed: one has the standard fields only, the other adds custom cards and a demographic survey.
const STANDARD_APPLY = fixture("lever-apply-standard.html");
const CARDS_APPLY = fixture("lever-apply-cards.html");
const STANDARD_ID = "1e6d7070-2772-5ec9-a9f1-e6d06760a52a";
const CARDS_ID = "8a50be0f-16af-5f04-b1a6-80214fa65f59";

const ONSITE = "This position requires working onsite in New York City three days per week and includes in-person interviews. Are you currently able to meet this requirement?";
const SQL = "In 1-2 sentences, what's the most complex thing you've done with SQL, APIs, or scripting?";

const realFetch = globalThis.fetch;
let calls: string[] = [];
function stub(handler: (url: string) => Response) {
  calls = [];
  globalThis.fetch = (async (input: any) => { const url = String(input?.url ?? input); calls.push(url); return handler(url); }) as typeof fetch;
}
const serveForms = () => stub(url => {
  if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/initech/jobs/5522110044?questions=true")) return new Response(GH);
  if (url.startsWith("https://jobs.ashbyhq.com/api/non-user-graphql")) return new Response(ASHBY);
  if (url === `https://jobs.lever.co/initrode-2/${STANDARD_ID}/apply`) return new Response(STANDARD_APPLY);
  if (url === `https://jobs.lever.co/vandelay/${CARDS_ID}/apply`) return new Response(CARDS_APPLY);
  return new Response("{}", { status: 404 });
});
afterEach(() => { globalThis.fetch = realFetch; });

const job = (ats: "greenhouse" | "ashby", slug: string, id: string) => ({
  id: `${ats}:${slug}:${id}`, ats, boardSlug: slug, company: slug, title: "Solutions Engineer", location: "NYC", remote: false,
  description: "Help customers integrate.", url: "u", applyUrl: "u",
});
const leverJob = (slug: string, id: string, title: string) => ({
  ...job("greenhouse", slug, id), id: `lever:${slug}:${id}`, ats: "lever" as const, company: slug, title,
  url: `https://jobs.lever.co/${slug}/${id}`, applyUrl: `https://jobs.lever.co/${slug}/${id}/apply`,
});
const INITECH = job("greenhouse", "initech", "5522110044");
const GLOBEX = job("ashby", "globex-ai", "94f65003-608e-5b60-ace5-e9793c8fe2fd");
const STANDARD = leverJob("initrode-2", STANDARD_ID, "GTM Engineer");
const CARDS = leverJob("vandelay", CARDS_ID, "GTM Engineer");
db.upsertJobs([INITECH, GLOBEX, STANDARD, CARDS]);
profile.saveProfile({ firstName: "Jane", lastName: "Doe", email: "jane.doe@example.com", phone: "555-010-0000", location: "New York, NY", workAuthorizedUS: true, needsSponsorship: false });
const master = await imp.importResume(fileURLToPath(new URL("./fixtures/resume/jane.txt", import.meta.url)));

test("greenhouse: questions come from the API with labels, requiredness, types and options", async () => {
  serveForms();
  const q = (await formQuestions(INITECH as any))!;
  assert.ok(q);
  const by = (label: string) => q.find(f => f.label === label)!;
  assert.deepEqual(by("First Name"), { key: "first_name", label: "First Name", type: "text", required: true });
  assert.equal(by("Resume/CV").type, "file");
  assert.equal(by("LinkedIn Profile").required, false);
  assert.equal(by(SQL).type, "text");
  assert.equal(by(SQL).required, true);
  assert.equal(by(ONSITE).options!.length, 3);
  assert.ok(by(ONSITE).options!.includes("No"));
  assert.ok(!q.some(f => /veteran/i.test(f.label)), "EEO questions are the profile's, not the pack's");
  assert.ok(calls.every(c => c.includes("questions=true")));
  const n = calls.length;
  await formQuestions(INITECH as any);
  assert.equal(calls.length, n, "second read comes from the cache");
});

test("greenhouse: hidden location fields (latitude, longitude) are not questions", async () => {
  const ACME = job("greenhouse", "acme", "4411220033");
  db.upsertJobs([ACME]);
  stub(() => new Response(JSON.stringify({ questions: [], location_questions: [
    { label: "Longitude", required: true, fields: [{ name: "longitude", type: "input_hidden" }] },
    { label: "Latitude", required: true, fields: [{ name: "latitude", type: "input_hidden" }] },
    { label: "Location", required: true, fields: [{ name: "location", type: "input_text" }] },
  ] })));
  assert.deepEqual((await formQuestions(ACME as any))!.map(f => f.label), ["Location"]);
});

test("ashby: fieldEntries map to questions, selectable values become options", async () => {
  serveForms();
  const q = (await formQuestions(GLOBEX as any))!;
  const onsite = q.find(f => /5-days in office/.test(f.label))!;
  assert.equal(onsite.type, "select");
  assert.equal(onsite.required, true);
  assert.equal(onsite.options!.length, 3);
  assert.equal(q.find(f => f.label === "Name")!.key, "_systemfield_name");
  assert.equal(q.find(f => f.label === "Resume")!.type, "file");
  assert.equal(q.find(f => f.label === "LinkedIn Profile")!.required, false);
  assert.equal(q.find(f => /authorized to work/.test(f.label))!.options!.join(), "Yes,No");
});

test("lever: the standard fields of a form without custom cards are read from the apply page", async () => {
  serveForms();
  const q = (await formQuestions(STANDARD as any))!;
  assert.deepEqual(q.map(f => f.label), [
    "Resume/CV", "Full name", "Pronouns", "Email", "Phone", "Current location", "Current company",
    "LinkedIn URL", "GitHub URL", "Portfolio URL", "Personal Website URL", "Other URL",
  ]);
  assert.deepEqual(calls, [`https://jobs.lever.co/initrode-2/${STANDARD_ID}/apply`]);
  assert.deepEqual(q.find(f => f.label === "Full name"), { key: "name", label: "Full name", type: "text", required: true });
  assert.equal(q.find(f => f.label === "Resume/CV")!.type, "file");
  assert.equal(q.find(f => f.label === "Email")!.type, "email");
  assert.deepEqual(q.filter(f => f.required).map(f => f.label), ["Resume/CV", "Full name", "Email", "Phone", "Current location"]);
  const pronouns = q.find(f => f.label === "Pronouns")!;
  assert.equal(pronouns.type, "checkbox");
  assert.ok(pronouns.options!.includes("They/them") && pronouns.options!.includes("Use name only"));
  assert.ok(!q.some(f => /gender|eeo/i.test(f.label + f.key)), "the EEO section is the profile's, not the pack's");
  assert.ok(!q.some(f => /^(selectedLocation|accountId|h-captcha-response)$/.test(f.key)), "hidden fields are not questions");
  const n = calls.length;
  await formQuestions(STANDARD as any);
  assert.equal(calls.length, n, "second read comes from the cache");
});

test("lever: custom card questions keep their wording, type, options and requiredness; surveys are skipped", async () => {
  serveForms();
  const q = (await formQuestions(CARDS as any))!;
  const by = (label: string) => q.find(f => f.label === label)!;
  const COMP = "What is your target compensation (USD/Year)?";
  assert.deepEqual(by(COMP), { key: "cards[eb287668-92b8-5b59-9199-2800f793ed16][field0]", label: COMP, type: "textarea", required: true });
  const visa = by("Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?");
  assert.deepEqual([visa.type, visa.required, visa.options], ["select", true, ["Yes", "No"]]);
  assert.equal(by("Are you currently using AI in your work?").required, false);
  assert.equal(by("Are you located in the Springfield area?").type, "checkbox");
  assert.equal(by("Are you open to being onsite?").type, "select");
  assert.equal(by("Workflow building: how much experience do you have building automated workflows or AI agents?").options!.length, 4);
  assert.equal(q.filter(f => f.key.startsWith("cards[")).length, 19);
  assert.ok(q.slice(0, 12).some(f => f.label === "Twitter URL"), "standard fields come first, in form order");
  assert.ok(!q.some(f => /surveysResponses|eeo\[/.test(f.key)), "the demographic survey is the profile's, not the pack's");
  assert.ok(!q.some(f => f.label === "What is your location?"), "controls with no name are not questions");
});

test("lever: the Additional information textarea (comments) is an optional question when the page has one", async () => {
  // Synthetic: none of the saved Lever pages has this block, so the markup follows Lever's documented field name.
  stub(() => new Response(`<form id="application-form"><div class="section page-centered application-form"><h4>Additional information</h4>
    <textarea name="comments" id="additional-information" placeholder="Add a cover letter or anything else you want to share."></textarea></div></form>`));
  const J = leverJob("acme", "11", "Engineer");
  db.upsertJobs([J]);
  assert.deepEqual(await formQuestions(J as any), [{ key: "comments", label: "Additional information", type: "textarea", required: false }]);
});

test("lever: a question block with no readable label is a layout we do not know, so the read gives undefined", async () => {
  stub(() => new Response(`<form id="application-form"><ul><li class="application-question"><label><div class="application-label">Full name</div><div class="application-field"><input name="name" required></div></label></li>
    <li class="application-question"><div class="mystery"><input type="text" name="cards[x][field0]"></div></li></ul></form>`));
  const J = leverJob("acme", "12", "Engineer");
  db.upsertJobs([J]);
  assert.equal(await formQuestions(J as any), undefined);
  stub(() => new Response("<html><body>This job is no longer open</body></html>"));
  assert.equal(await formQuestions(leverJob("acme", "13", "Gone") as any), undefined);
});

test("other ATSes and failed reads give undefined, never a throw", async () => {
  serveForms();
  assert.equal(await formQuestions({ ...INITECH, id: "workable:x:1", ats: "workable", boardSlug: "x" } as any), undefined);
  stub(() => { throw new Error("offline"); });
  assert.equal(await formQuestions(job("greenhouse", "initech", "0001") as any), undefined);
  assert.equal(await formQuestions(leverJob("initrode-2", "0001", "Offline") as any), undefined);
  stub(() => new Response("{}", { status: 500 }));
  assert.equal(await formQuestions(job("ashby", "globex-ai", "bad") as any), undefined);
  assert.equal(await formQuestions(leverJob("initrode-2", "0002", "Broken") as any), undefined);
  serveForms();
  assert.equal(await formQuestions(leverJob("initrode-2", "gone", "Closed") as any), undefined, "a closed posting (404) falls back to guessing");
});

test("brief lists the real questions, marks what the profile fills, and drops the generic hint", async () => {
  serveForms();
  const b = await tailor.tailoringBrief(INITECH.id);
  assert.equal(b.questionsHint.length, 0);
  const q = (label: string) => b.formQuestions!.find(x => x.question === label)!;
  assert.equal(q("First Name").willFill, "Jane");
  assert.equal(q("First Name").needsAnswer, false);
  assert.equal(q("Are you eligible to work in the US?").willFill, "Yes");
  assert.equal(q("Resume/CV").needsAnswer, false);
  assert.equal(q(ONSITE).needsAnswer, true);
  assert.equal(q(ONSITE).willFill, undefined);
  assert.equal(q(SQL).needsAnswer, true);
  assert.deepEqual(b.formQuestions!.filter(x => x.required && x.needsAnswer).map(x => x.question), [ONSITE, SQL]);
});

test("brief falls back to the generic hint when the form cannot be read", async () => {
  stub(() => new Response("", { status: 503 }));
  const other = job("greenhouse", "globex", "9");
  db.upsertJobs([other]);
  const b = await tailor.tailoringBrief(other.id);
  assert.equal(b.formQuestions, undefined);
  assert.ok(b.questionsHint.some(h => /Globex/i.test(h)));
  assert.deepEqual(await tailor.alignPack(other.id), []);
});

test("savePack seeds required unanswered questions and flags answers the form never asks", async () => {
  serveForms();
  const pack = await tailor.savePack(INITECH.id, { resume: master, answers: { "Why Initech?": "TODO (you): one true reason", "Are you eligible to work in the US?": "Yes" } });
  assert.equal(pack.answers[ONSITE], "TODO (you): answer this form question");
  assert.equal(pack.answers[SQL], "TODO (you): answer this form question");
  assert.ok(!("First Name" in pack.answers) && !("Phone" in pack.answers), "profile-filled questions are not seeded");
  assert.ok(!("LinkedIn Profile" in pack.answers), "optional questions are not seeded");
  assert.ok(pack.warnings.includes("Not on the form: Why Initech? (this answer will not be used)"));
  assert.ok(!pack.warnings.some(w => /Not on the form: Are you eligible/.test(w)));
  assert.deepEqual(tailor.packTodos(tailor.loadPack(INITECH.id)).sort(), [ONSITE, SQL, "Why Initech?"].sort());
});

test("alignPack: seeds before a fill, is idempotent, and the fill gates refuse until the user answers", async () => {
  serveForms();
  const id = "greenhouse:initech:5522110044";
  await tailor.savePack(id, { resume: master }); // seeds both
  // simulate a pack saved before the form was readable: drop the seeds, then align
  const p = tailor.loadPack(id)!;
  const { packDir } = await import("../src/paths.js");
  writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ ...p, answers: {} }));
  assert.deepEqual((await tailor.alignPack(id)).sort(), [ONSITE, SQL].sort());
  assert.deepEqual(await tailor.alignPack(id), [], "idempotent");
  assert.equal(Object.keys(tailor.loadPack(id)!.answers).length, 2);
  assert.ok(db.listEvents(id).some(e => /Form read: 2 required/.test(e.detail ?? "")));
  await assert.rejects(engine.fillForm(id), /unfinished answers.*onsite/);

  // the user's dashboard edit of a seeded question works, and answers passed with the fill count as answered
  const edited = await tailor.updatePack(id, { answers: { [SQL]: "Wrote a Python script that reconciled two APIs." } });
  assert.equal(edited.answers[SQL], "Wrote a Python script that reconciled two APIs.");
  assert.equal(tailor.packTodos(edited).join(), ONSITE);
  // an answer passed with the fill under the form's own wording replaces the TODO seeded under the API's
  assert.deepEqual(await tailor.alignPack(id, { [`${ONSITE} *`]: "Yes" }), []);
  assert.equal(tailor.loadPack(id)!.answers[ONSITE], "Yes");
  assert.deepEqual(tailor.packTodos(tailor.loadPack(id)!), []);
});

test("alignPack: a TODO seed for a question the profile can now answer is dropped, so the fill gate opens", async () => {
  serveForms();
  const id = "greenhouse:initech:5522110044";
  await tailor.savePack(id, { resume: master });
  const p = tailor.loadPack(id)!;
  const { packDir } = await import("../src/paths.js");
  const seed = "TODO (you): answer this form question";
  // a pack saved before the profile could answer First Name (a user's own TODO text elsewhere is left alone)
  writeFileSync(join(packDir(id), "pack.json"), JSON.stringify({ ...p, answers: { ...p.answers, "First Name": seed, "LinkedIn Profile": "TODO (you): my own note" } }));
  await tailor.alignPack(id);
  const after = tailor.loadPack(id)!.answers;
  assert.ok(!("First Name" in after), "the profile answers it");
  assert.equal(after["LinkedIn Profile"], "TODO (you): my own note");
  assert.ok(after[SQL], "questions the profile cannot answer stay seeded");
});

test("a long free-text question that mentions a profile keyword still needs an answer", async () => {
  const NYC = job("greenhouse", "acme", "77");
  db.upsertJobs([NYC]);
  const Q = "Why are you interested in our New York City office?";
  stub(() => new Response(JSON.stringify({ questions: [
    { label: "Location (City)", required: true, fields: [{ name: "loc", type: "input_text" }] },
    { label: Q, required: true, fields: [{ name: "q1", type: "textarea" }] },
  ] })));
  const brief = await tailor.tailoringBrief(NYC.id);
  assert.equal(brief.formQuestions!.find(q => q.question === Q)!.needsAnswer, true);
  assert.ok(brief.formQuestions!.find(q => q.question === "Location (City)")!.willFill, "a short profile question is still filled from the profile");
});

test("a date question: a span like '1-2 weeks' counts as answered, an answer that names no date goes back as a TODO", async () => {
  const START = "When is the earliest you would want to start working with us?";
  const Z = job("ashby", "umbrella", "0f1e2d3c");
  db.upsertJobs([Z]);
  stub(() => new Response(JSON.stringify({ data: { jobPosting: { applicationForm: { sections: [{ fieldEntries: [
    { field: { path: "start", title: START, type: "Date" }, isRequired: true },
  ] }] } } } })));
  assert.equal((await tailor.savePack(Z.id, { resume: master, answers: { [START]: "1-2 weeks" } })).answers[START], "1-2 weeks");
  assert.equal((await tailor.savePack(Z.id, { resume: master, answers: { [START]: "After my notice period" } })).answers[START], "TODO (you): answer this form question");
  assert.deepEqual(await tailor.alignPack(Z.id), [], "a seeded date question is not seeded again");
});

test("alignPack does nothing without a pack or when the form cannot be read", async () => {
  serveForms();
  assert.deepEqual(await tailor.alignPack("greenhouse:initech:nopack"), []);
  stub(() => { throw new Error("offline"); });
  const other = job("greenhouse", "initech", "offline1");
  db.upsertJobs([other]);
  const pack = await tailor.savePack(other.id, { resume: master, answers: { "Why us?": "Because." } });
  assert.deepEqual(Object.keys(pack.answers), ["Why us?"]);
  assert.deepEqual(await tailor.alignPack(other.id), []);
});

test("lever brief: the real questions replace the generic hint, and nothing the form lacks blocks the fill", async () => {
  serveForms();
  const b = await tailor.tailoringBrief(STANDARD.id);
  assert.equal(b.questionsHint.length, 0);
  assert.deepEqual(b.formQuestions!.map(x => x.question).slice(0, 2), ["Resume/CV", "Full name"]);
  const q = (label: string) => b.formQuestions!.find(x => x.question === label)!;
  assert.equal(q("Full name").willFill, "Jane Doe");
  assert.equal(q("Email").willFill, "jane.doe@example.com");
  assert.equal(q("Current location").needsAnswer, false);
  assert.deepEqual(b.formQuestions!.filter(x => x.required && x.needsAnswer), [], "every required field comes from the profile");
});

test("lever pack: a generic 'Why <company>?' answer is flagged Not on the form and no TODO is seeded", async () => {
  serveForms();
  const pack = await tailor.savePack(STANDARD.id, { resume: master, answers: { "Why Initrode?": "Because of the scheduling work." } });
  assert.ok(pack.warnings.includes("Not on the form: Why Initrode? (this answer will not be used)"));
  assert.ok(!Object.values(pack.answers).some(a => /^TODO/.test(a)), "the form asks nothing the profile cannot answer");
  assert.deepEqual(tailor.packTodos(tailor.loadPack(STANDARD.id)), []);
  assert.deepEqual(await tailor.alignPack(STANDARD.id), []);
});

test("lever brief: a form with custom cards lists them, and the required ones the profile cannot answer", async () => {
  serveForms();
  const b = await tailor.tailoringBrief(CARDS.id);
  const q = (label: string) => b.formQuestions!.find(x => x.question === label)!;
  assert.equal(q("Are you legally eligible to work in the U.S.?").willFill, "Yes");
  assert.equal(q("What is your target compensation (USD/Year)?").needsAnswer, true);
  assert.ok(b.formQuestions!.filter(x => x.required && x.needsAnswer).some(x => /Workflow building/.test(x.question)));
  assert.equal(q("Are you currently using AI in your work?").required, false);
});

test("country comes from a US state in the location when the phone has no +1", () => {
  const field = { key: "country", label: "Country", type: "select" as const, required: true, options: ["Canada", "United States", "Mexico"] };
  const ctx = (location?: string) => ({ profile: { firstName: "J", lastName: "D", email: "j@d.co", phone: "555-010-0000", location }, answers: {}, files: {} });
  assert.equal(suggest(field, ctx("New York, NY"))?.value, "United States");
  assert.equal(suggest(field, ctx("Austin, Texas"))?.value, "United States");
  assert.equal(suggest(field, ctx("Brooklyn, New York, United States"))?.value, "United States");
  assert.equal(suggest(field, ctx("Toronto, Canada"))?.value, "Canada");
  assert.equal(suggest(field, ctx("Tbilisi, Georgia")), undefined);
  const abroad = { profile: { firstName: "J", lastName: "D", email: "j@d.co", phone: "+49 30 1234567", location: "Berlin, DE" }, answers: {}, files: {} };
  assert.notEqual(suggest(field, abroad)?.value, "United States"); // DE is Germany here, not Delaware
});
