import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-apply-"));
process.env.OPENAPPLY_HEADLESS = "1";
const db = await import("../src/db.js");
const { paths, packDir } = await import("../src/paths.js");
const engine = await import("../src/apply/engine.js");
const { browserContext, fullPageShot, openPage } = await import("../src/apply/browser.js");
const fm = await import("../src/apply/fieldmap.js");

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ats");
const ROUTES: Record<string, string> = {
  "/greenhouse/apply": "greenhouse.html", "/lever/apply": "lever.html",
  "/ashby/application": "ashby.html", "/captcha/apply": "captcha.html",
};
let server: Server;
let base = "";

const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

const START = "When is the earliest you would want to start working with us?";

// Ashby's server for the fixture (see src/apply/adapters/ashby.ts): a save lands on the form as it stood when the save
// arrived, so overlapping saves drop each other, as on the live server.
const AUTH = "Are you authorized to work in the country where the job is located?";
const ASHBY_TITLES: Record<string, string> = {
  _systemfield_name: "Legal Name", _systemfield_email: "Email", "f-phone": "Phone", "f-linkedin": "LinkedIn Profile",
  "f-auth": AUTH, "f-sponsor": "Will you now or in the future require sponsorship for employment visa status?",
  "f-why": "Why do you want to work at Acme?", "f-pronouns": "What pronouns would you like our team to use when addressing you?",
};
const ashbyForms = new Map<string, Record<string, unknown>>();
const ashbyDrop = new Set<string>(); // the next save to each of these paths is answered but not kept

async function ashbyApi(req: IncomingMessage, res: ServerResponse) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const { operationName, variables: v } = JSON.parse(raw);
  const form: Record<string, unknown> = { ...ashbyForms.get(v.formRenderIdentifier) };
  res.setHeader("content-type", "application/json");
  if (operationName === "ApiSubmitSingleApplicationFormAction") {
    return res.end(JSON.stringify({ missing: ["f-auth", "f-sponsor"].filter(p => form[p] == null).map(p => ASHBY_TITLES[p]) }));
  }
  if (operationName === "ApiCreateFileUploadHandle") return res.end("{}");
  await new Promise(r => setTimeout(r, operationName === "ApiSetFormValueToFile" ? 1500 : 200)); // the upload stands behind a file save
  if (!ashbyDrop.delete(v.path)) form[v.path] = v.value ?? null;
  ashbyForms.set(v.formRenderIdentifier, form);
  const fieldEntries = Object.keys(ASHBY_TITLES).map(p => ({ field: { path: p }, fieldValue: form[p] == null ? null : { value: form[p] } }));
  res.end(JSON.stringify({ data: { setFormValue: { sections: [{ fieldEntries }] } } }));
}

const job = (ats: string, path: string) => ({
  id: `${ats}:acme:fixture`, ats: "other" as const, boardSlug: "acme", company: "Acme",
  title: `Role ${ats}`, location: "New York, NY", remote: false, description: "", // distinct titles: same company + similar title is the duplicate guard
  url: base + path, applyUrl: base + path,
});

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api/non-user-graphql") return void ashbyApi(req, res);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (ROUTES[path]) return res.end(readFileSync(join(FIX, ROUTES[path])));
    if (path === "/lever/thanks") return res.end("<h2>Application submitted!</h2><p>Thanks for applying to Acme.</p>");
    // Lever refusing the submit (invisible hCaptcha failed): the form comes back with the banner and no resume.
    if (path === "/lever-verify/apply") {
      return res.end(/[?&]error=1/.test(req.url ?? "") ? readFileSync(join(FIX, "lever-verify-error.html"))
        : readFileSync(join(FIX, "lever.html"), "utf8").replace('"/lever/thanks"', '"/lever-verify/apply?error=1"'));
    }
    if (path.startsWith("/recaptcha/")) return res.end('<div style="border:1px solid #ccc;height:74px">[ ] I am not a robot</div>');
    res.end("<!doctype html><title>blank</title>");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  writeFileSync(paths.profile, JSON.stringify({
    firstName: "Test", lastName: "Person", email: "test@example.com", phone: "+1 555 010 0000",
    location: "Brooklyn, NY", linkedin: "https://linkedin.com/in/test-person", github: "https://github.com/test-person",
    website: "https://test.example.com", workAuthorizedUS: true, needsSponsorship: false,
    education: [{ school: "Riverside University", degree: "Bachelor's Degree", discipline: "Information Systems", endYear: 2023 }],
  }));
  writeFileSync(paths.resume, JSON.stringify({
    name: "Test Person", contact: { email: "test@example.com" }, education: [],
    experience: [{ company: "Example Corp", title: "Solutions Engineer", bullets: [] }],
  }));
  db.upsertJobs([job("greenhouse", "/greenhouse/apply"), job("lever", "/lever/apply"), job("ashby", "/ashby/application"), job("captcha", "/captcha/apply")]);
  for (const id of ["greenhouse", "lever", "ashby", "captcha"].map(a => `${a}:acme:fixture`)) {
    const dir = packDir(id);
    writeFileSync(join(dir, "resume.pdf"), PDF);
    writeFileSync(join(dir, "cover-letter.pdf"), PDF);
    writeFileSync(join(dir, "pack.json"), JSON.stringify({
      jobId: id, resume: { name: "Test Person", contact: {}, experience: [], education: [] },
      answers: { "Why Acme?": "I build agents that ship.", "Why do you want to work at Acme?": "I build agents that ship.", [START]: "1-2 weeks" },
      resumePdf: join(dir, "resume.pdf"), coverLetterPdf: join(dir, "cover-letter.pdf"), warnings: [], createdAt: new Date().toISOString(),
    }));
  }
});

after(async () => {
  await engine.closeBrowser();
  server.close();
});

const dom = (id: string, fn: string) => openPage(id)!.evaluate(fn);
const byLabel = (fields: { label: string }[], l: string) => fields.find(f => f.label === l);

test("fieldmap: yes/no, decline and no random picks", () => {
  assert.equal(fm.yesNoOption(["Yes", "No"], true), "Yes");
  assert.equal(fm.yesNoOption(["I am authorized to work in the US", "I am not authorized"], true), "I am authorized to work in the US");
  assert.equal(fm.bestOption(["Red", "Green", "Blue"], "Purple"), undefined);
  const ctx = { answers: {}, files: {}, profile: { firstName: "A", lastName: "B", email: "a@b.c", workAuthorizedUS: true, needsSponsorship: false } };
  const s = (label: string, options?: string[]) => fm.suggest({ key: "k", label, type: options ? "select" : "text", required: true, options }, ctx)?.value;
  assert.equal(s("Gender", ["Male", "Female", "Decline To Self Identify"]), "Decline To Self Identify");
  assert.equal(s("Will you require visa sponsorship?", ["Yes", "No"]), "No");
  assert.equal(s("Are you legally authorized to work in the US?", ["Yes", "No"]), "Yes");
  assert.equal(s("Favorite color?", ["Red", "Blue"]), undefined);
});

test("fieldmap: EEO answers come from the profile, alternates cover both wordings, nothing close declines", () => {
  const eeo = { gender: "Man|Male", race: "White", hispanic: "No", veteran: "No", disability: "No", transgender: "No", orientation: "Heterosexual|Straight" };
  const ctx = { answers: {}, files: {}, profile: { firstName: "A", lastName: "B", email: "a@b.c", eeo } };
  const s = (label: string, options: string[]) => fm.suggest({ key: "k", label, type: "select", required: false, options }, ctx)?.value;
  const NO = "I don't wish to answer";
  // Greenhouse "U.S. Standard Demographic Questions"
  assert.equal(s("How would you describe your gender identity? (mark all that apply)", ["Man", "Non-binary", "Woman", "I prefer to self-describe", NO]), "Man");
  assert.equal(s("How would you describe your racial/ethnic background? (mark all that apply)", ["Black or African American", "East Asian", "Hispanic or Latinx", "White", NO]), "White");
  assert.equal(s("How would you describe your sexual orientation? (mark all that apply)", ["Asexual", "Bisexual and/or pansexual", "Gay", "Heterosexual", "Lesbian", NO]), "Heterosexual");
  assert.equal(s("Do you identify as transgender?", ["Yes", "No", "I prefer to self-describe", NO]), "No");
  assert.equal(s("Do you have a disability or chronic condition that substantially limits one or more of your major life activities?", ["Yes", "No", NO]), "No");
  assert.equal(s("Are you a veteran or active member of the United States Armed Forces?", ["Yes", "No", NO]), "No");
  // classic EEOC wording
  assert.equal(s("Gender", ["Female", "Male", "Decline To Self Identify"]), "Male");
  assert.equal(s("Are you Hispanic/Latino?", ["Yes", "No", "Decline To Self Identify"]), "No");
  assert.equal(s("Veteran Status", ["I identify as one or more of the classifications of protected veteran", "I am not a protected veteran", NO]), "I am not a protected veteran");
  assert.equal(s("Disability Status", ["Yes, I have a disability (or previously had a disability)", "No, I do not have a disability", "I do not want to answer"]), "No, I do not have a disability");
  // no close option: decline, never a guess
  assert.equal(s("Gender", ["Cisgender woman", "Transgender woman", NO]), NO);
});

test("fillForm refuses TODO or blank answers (pack or caller) before the form is opened", async () => {
  const id = "greenhouse:acme:todo";
  db.upsertJobs([{ ...job("greenhouse", "/greenhouse/apply"), id, title: `Role ${id.split(":")[2]}` }]);
  const dir = packDir(id);
  const pack = (answers: Record<string, string>) => writeFileSync(join(dir, "pack.json"), JSON.stringify({
    jobId: id, resume: { name: "Test Person", contact: {}, experience: [], education: [] }, answers, warnings: [], createdAt: new Date().toISOString(),
  }));
  db.setApplication(id, { status: "drafted" });
  pack({ "Why Acme?": "TODO (you): your real reason", "Start date?": "Two weeks" });
  await assert.rejects(engine.fillForm(id), /Cannot fill .*unfinished.*: Why Acme\?/);
  pack({ "Why Acme?": "I build agents that ship.", "Start date?": "Two weeks" });
  await assert.rejects(engine.fillForm(id, { "Start date?": "  " }), /unfinished.*: Start date\?/); // a blank override is unfinished too
  assert.equal(openPage(id), undefined, "the form was never opened");
  assert.equal(db.getApplication(id)?.status, "drafted");
});

test("fillForm refuses OpenApply's rendered resume when the user has their own PDF; the OSS default still uses it", async () => {
  const id = "greenhouse:acme:rendered";
  db.upsertJobs([{ ...job("greenhouse", "/greenhouse/apply"), id, title: `Role ${id.split(":")[2]}` }]);
  const dir = packDir(id);
  writeFileSync(join(dir, "resume.pdf"), PDF);
  const own = join(dir, "Noel_Turlington_Product.pdf");
  writeFileSync(own, PDF);
  // A TODO keeps the allowed case from opening the form: getting past the resume check to the TODO check is the proof.
  const pack = (resumePdf: string) => writeFileSync(join(dir, "pack.json"), JSON.stringify({
    jobId: id, resume: { name: "Test Person", contact: {}, experience: [], education: [] },
    answers: { "Why Acme?": "TODO (you): your real reason" }, resumePdf, warnings: [], createdAt: new Date().toISOString(),
  }));
  db.setApplication(id, { status: "drafted" });
  const saved = readFileSync(paths.profile, "utf8");
  const REFUSED = /Fill refused: this pack uses OpenApply's rendered resume; save the pack with resume_pdf \(your own PDF\)/;
  try {
    pack(join(dir, "resume.pdf"));
    await assert.rejects(engine.fillForm(id), /unfinished/, "no resume of the user's own: the rendered one is allowed");

    writeFileSync(paths.profile, JSON.stringify({ ...JSON.parse(saved), resumePdf: own }));
    await assert.rejects(engine.fillForm(id), REFUSED);
    writeFileSync(paths.profile, JSON.stringify({ ...JSON.parse(saved), resumes: { product: { pdf: own } } }));
    await assert.rejects(engine.fillForm(id), REFUSED, "a resume track counts as the user's own too");

    pack(own); // saved with resume_pdf: past the resume check
    await assert.rejects(engine.fillForm(id), /unfinished/);
  } finally {
    writeFileSync(paths.profile, saved);
  }
  assert.equal(openPage(id), undefined, "the form was never opened");
  assert.equal(db.getApplication(id)?.status, "drafted");
});

test("greenhouse fixture: inspect, fill, refuse without code, submit with code", async () => {
  process.env.OPENAPPLY_ADAPTER = "greenhouse";
  const id = "greenhouse:acme:fixture";
  const ins = await engine.inspectForm(id);
  assert.equal(ins.adapter, "greenhouse");
  assert.equal(ins.captchaDetected, false);
  assert.equal(byLabel(ins.fields, "Resume/CV")?.type, "file");
  assert.ok(byLabel(ins.fields, "Country")?.options?.includes("United States +1"));
  assert.equal(byLabel(ins.fields, "Location (City)")?.type, "combobox");
  assert.equal(byLabel(ins.fields, "First Name")?.suggested, "Test");
  // Education: School is search-backed (no recorded options), Degree and Discipline read their lists; the profile fills all three
  assert.equal(byLabel(ins.fields, "School")?.options, undefined);
  assert.ok(byLabel(ins.fields, "Discipline")?.options?.includes("Information Systems"));
  assert.deepEqual(["School", "Degree", "Discipline", "Start date year", "End date year"].map(l => byLabel(ins.fields, l)?.suggested),
    ["Riverside University", "Bachelor's Degree", "Information Systems", undefined, "2023"]);
  assert.deepEqual(ins.missing, ["Have you ever interviewed at Acme before?"]);

  const res = await engine.fillForm(id, { "Have you ever interviewed at Acme before?": "No" });
  assert.match(res.confirmationCode, /^[A-Z2-9]{6}$/);
  assert.ok(res.screenshot && readFileSync(res.screenshot).length > 1000);
  const v = await dom(id, `(() => {
    const sv = id => document.getElementById(id).closest(".select-shell").dataset.value;
    return { first: first_name.value, last: last_name.value, email: email.value, phone: phone.value,
      country: sv("country"), loc: sv("candidate-location"), auth: sv("question_1002"), sponsor: sv("question_1003"),
      hear: sv("question_1005"), before: sv("question_1006"), gender: sv("gender"), vet: sv("veteran_status"),
      dis: sv("disability_status"), school: sv("school--0"), degree: sv("degree--0"), disc: sv("discipline--0"),
      start: document.getElementById("start-year--0").value, end: document.getElementById("end-year--0").value, why: question_1004.value, linkedin: question_1001.value,
      files: [...document.querySelectorAll(".file-upload__filename")].map(p => p.textContent) };
  })()`) as Record<string, unknown>;
  assert.deepEqual(v, {
    first: "Test", last: "Person", email: "test@example.com", phone: "+1 555 010 0000",
    country: "United States +1", loc: "Brooklyn, New York, United States", auth: "Yes", sponsor: "No",
    hear: "Company Website", before: "No", gender: "Decline To Self Identify", vet: "I don't wish to answer",
    dis: "I do not want to answer", school: "Riverside University", degree: "Bachelor's Degree", disc: "Information Systems",
    start: "", end: "2023", why: "I build agents that ship.", linkedin: "https://linkedin.com/in/test-person",
    files: ["resume.pdf", "cover-letter.pdf"],
  });
  assert.equal(db.getApplication(id)?.status, "filled");

  await assert.rejects(engine.submitForm(id), /Submit refused/);
  await assert.rejects(engine.submitForm(id, "WRONG1"), /Submit refused/);
  const sub = await engine.submitForm(id, res.confirmationCode);
  assert.equal(sub.outcome, "submitted", sub.detail);
  assert.match(sub.detail, /confirmation seen/);
  assert.ok(sub.screenshot && readFileSync(sub.screenshot).length > 0, "the thank-you page is kept as a screenshot");
  assert.equal(openPage(id), undefined, "the submitted tab is closed");
  const app = db.getApplication(id)!;
  assert.equal(app.status, "submitted");
  assert.ok(app.submittedAt);
  assert.equal(app.confirmationCode, undefined);
  await assert.rejects(engine.submitForm(id, res.confirmationCode), /already submitted/);
});

test("greenhouse School search: a school the results do not list exactly is left for the user, never a lookalike", async () => {
  process.env.OPENAPPLY_ADAPTER = "greenhouse";
  const id = "greenhouse:acme:school";
  db.upsertJobs([{ ...job("greenhouse", "/greenhouse/apply"), id, title: `Role ${id.split(":")[2]}` }]);
  const dir = packDir(id);
  writeFileSync(join(dir, "resume.pdf"), PDF);
  writeFileSync(join(dir, "pack.json"), JSON.stringify({
    jobId: id, resume: { name: "Test Person", contact: {}, experience: [], education: [] },
    answers: { "Why Acme?": "I build agents that ship.", "Have you ever interviewed at Acme before?": "No" },
    resumePdf: join(dir, "resume.pdf"), warnings: [], createdAt: new Date().toISOString(),
  }));
  const original = readFileSync(paths.profile, "utf8");
  // "Riverside" is a prefix of both Riverside College and Riverside University in the search results
  writeFileSync(paths.profile, JSON.stringify({ ...JSON.parse(original), education: [{ school: "Riverside", degree: "Bachelor's Degree" }] }));
  try {
    const res = await engine.fillForm(id);
    assert.deepEqual(res.failed, ["School"]);
    assert.equal(await dom(id, `document.getElementById("school--0").closest(".select-shell").dataset.value ?? ""`), "");
  } finally {
    writeFileSync(paths.profile, original);
  }
});

test("a required question nothing answers is a blank: stored with the fill, approve and submit refuse", async () => {
  process.env.OPENAPPLY_ADAPTER = "greenhouse";
  const track = await import("../src/track.js");
  const id = "greenhouse:acme:blank";
  const q = "Have you ever interviewed at Acme before?";
  db.upsertJobs([{ ...job("greenhouse", "/greenhouse/apply"), id, title: `Role ${id.split(":")[2]}` }]);
  const dir = packDir(id);
  writeFileSync(join(dir, "resume.pdf"), PDF);
  writeFileSync(join(dir, "pack.json"), JSON.stringify({
    jobId: id, resume: { name: "Test Person", contact: {}, experience: [], education: [] }, answers: { "Why Acme?": "I build agents that ship." },
    resumePdf: join(dir, "resume.pdf"), warnings: [], createdAt: new Date().toISOString(),
  }));

  const res = await engine.fillForm(id);
  assert.deepEqual(res.blanks, [q]);
  assert.match(res.skipped.find(x => x.label === q)!.reason, /^required, no answer/);
  assert.match(JSON.parse(readFileSync(join(packDir(id), "pack.json"), "utf8")).answers[q], /^TODO \(you\)/); // now a question to answer in the pack
  assert.ok(res.filled.some(f => f.label === "First Name" && f.value === "Test"));
  const stored = track.currentFill(id)!;
  assert.deepEqual(stored.blanks, [q]);
  assert.deepEqual(stored.filled, res.filled);
  assert.equal(stored.code, res.confirmationCode);
  assert.throws(() => track.approve(id, res.confirmationCode), /required fields are blank on the form: Have you ever interviewed/);
  await assert.rejects(engine.submitForm(id, res.confirmationCode), /Submit refused: required fields are blank/);
  assert.equal(db.getApplication(id)?.status, "filled");

  // Re-opening the form voids the stored fill; filling again with the answer replaces it.
  await engine.inspectForm(id);
  assert.equal(track.currentFill(id), undefined);
  const ok = await engine.fillForm(id, { [q]: "No" });
  assert.deepEqual(ok.blanks, []);
  assert.deepEqual(track.currentFill(id)?.blanks, []);
  assert.equal(track.approve(id, ok.confirmationCode).status, "approved");
  const sub = await engine.submitForm(id);
  assert.equal(sub.outcome, "submitted", sub.detail);
});

test("lever fixture: radios, checkboxes, selects, location autocomplete, invisible hCaptcha", async () => {
  process.env.OPENAPPLY_ADAPTER = "lever";
  const id = "lever:acme:fixture";
  const ins = await engine.inspectForm(id);
  assert.equal(ins.captchaDetected, false, "hidden hCaptcha is not an interactive challenge");
  assert.equal(byLabel(ins.fields, "Full name")?.suggested, "Test Person");
  assert.equal(byLabel(ins.fields, "Resume/CV")?.type, "file");
  assert.deepEqual(ins.missing, ["Language Skill(s) (Check all that apply)"]);

  const res = await engine.fillForm(id, { "Language Skill(s) (Check all that apply)": "English, French" }, true);
  assert.ok(res.skipped.some(s => /hasInvisibleCaptcha/.test(s.reason)));
  const v = await dom(id, `(() => {
    const f = document.getElementById("application-form");
    const val = n => f.querySelector('[name="' + n + '"]').value;
    const checked = n => [...f.querySelectorAll('[name="' + n + '"]:checked')].map(i => i.value);
    return { name: val("name"), email: val("email"), phone: val("phone"), org: val("org"), loc: val("location"),
      picked: val("selectedLocation") !== "", li: val("urls[LinkedIn]"), gh: val("urls[GitHub]"),
      auth: checked("cards[c1][field0]"), sponsor: checked("cards[c1][field1]"), langs: checked("cards[c2][field0]"),
      hear: val("cards[c2][field1]"), why: val("cards[c2][field2]"), gender: val("eeo[gender]"), race: val("eeo[race]"),
      vet: val("eeo[veteran]"), file: document.querySelector(".filename").textContent };
  })()`);
  assert.deepEqual(v, {
    name: "Test Person", email: "test@example.com", phone: "+1 555 010 0000", org: "Example Corp",
    loc: "Brooklyn, NY, United States", picked: true, li: "https://linkedin.com/in/test-person", gh: "https://github.com/test-person",
    auth: ["Yes"], sponsor: ["No"], langs: ["English (ENG)", "French (FRA)"], hear: "Company Website",
    why: "I build agents that ship.", gender: "Decline to self-identify", race: "Decline to self-identify",
    vet: "Decline to self-identify", file: "resume.pdf",
  });
  const saved = JSON.parse(readFileSync(paths.profile, "utf8")).savedAnswers;
  assert.equal(saved["Language Skill(s) (Check all that apply)"], "English, French", "remember: true saves answers");

  await assert.rejects(engine.submitForm(id), /Submit refused/);
  const sub = await engine.submitForm(id, res.confirmationCode);
  assert.equal(sub.outcome, "submitted", sub.detail);
  assert.ok(sub.screenshot, "the confirmation is kept as a screenshot");
  assert.equal(openPage(id), undefined, "the submitted tab is closed");
  assert.equal(db.getApplication(id)?.status, "submitted");
});

test("ashby fixture: yes/no buttons, async location, date picker, radio and checkbox groups, EEO survey", async () => {
  process.env.OPENAPPLY_ADAPTER = "ashby";
  const id = "ashby:acme:fixture";
  const ins = await engine.inspectForm(id);
  assert.equal(byLabel(ins.fields, "Legal Name")?.suggested, "Test Person");
  const start = fm.toDate("1-2 weeks")!;
  assert.deepEqual([byLabel(ins.fields, START)?.type, byLabel(ins.fields, START)?.suggested], ["date", start], "the pack's '1-2 weeks' becomes a date");
  assert.deepEqual(byLabel(ins.fields, "Are you authorized to work in the country where the job is located?")?.options, ["Yes", "No"]);
  assert.ok(!ins.fields.some(f => /autofill/i.test(f.label)), "autofill pane is not a question");
  assert.deepEqual(ins.missing, []);

  const res = await engine.fillForm(id);
  const v = await dom(id, `(() => {
    const yn = p => document.querySelector('[data-field-path="' + p + '"] [aria-pressed="true"]')?.textContent;
    const radio = n => { const i = document.querySelector('input[name="' + n + '"]:checked'); return i && document.querySelector('label[for="' + i.id + '"]').textContent; };
    return { name: _systemfield_name.value, email: _systemfield_email.value, phone: document.getElementById("f-phone").value,
      loc: document.querySelector("[role=combobox]").value, linkedin: document.getElementById("f-linkedin").value,
      auth: yn("f-auth"), sponsor: yn("f-sponsor"), why: document.getElementById("f-why").value,
      start: document.querySelector(".ashby-application-form-input-date").value,
      pronouns: radio("3d7cd789-3d2d-4bc8-a632-65e511d0c41c_f-pronouns"), hear: [...document.querySelectorAll('fieldset input[type=checkbox]:checked')].map(i => i.name),
      gender: radio("eeoc_gender"), race: radio("eeoc_race"), vet: radio("eeoc_vet"),
      files: [...document.querySelectorAll(".file-name")].map(s => s.textContent),
      consent: !!document.querySelector('[name=communicationConsent]:checked') };
  })()`);
  assert.deepEqual(v, {
    name: "Test Person", email: "test@example.com", phone: "+1 555 010 0000", loc: "Brooklyn, New York, United States",
    linkedin: "https://linkedin.com/in/test-person", auth: "Yes", sponsor: "No", why: "I build agents that ship.",
    start: start.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1"), // typed in the picker's own format
    pronouns: "Prefer not to say", hear: ["Company website"], gender: "Decline to self-identify",
    race: "Decline to self-identify", vet: "Decline to self-identify", files: ["resume.pdf", "cover-letter.pdf"], consent: false,
  });
  // What Ashby submits is its server's copy, not the page: every answer the page shows must be held there.
  const stored = async () => {
    const s = ashbyForms.get(await dom(id, "RENDER") as string) ?? {};
    return { resume: s._systemfield_resume, name: s._systemfield_name, auth: s["f-auth"], sponsor: s["f-sponsor"], why: s["f-why"], linkedin: s["f-linkedin"] };
  };
  const held = { resume: "resume.pdf", name: "Test Person", auth: true, sponsor: false, why: "I build agents that ship.", linkedin: "https://linkedin.com/in/test-person" };
  assert.deepEqual(res.failed, []);
  assert.deepEqual(await stored(), held, "back-to-back saves did not drop an answer");
  // A re-fill reuses the open page; clicking a pressed yes/no again would clear the answer on Ashby.
  const again = await engine.fillForm(id);
  assert.deepEqual(again.failed, []);
  assert.deepEqual(await stored(), held, "a re-fill keeps every answer");
  await assert.rejects(engine.submitForm(id), /Submit refused/);
  const sub = await engine.submitForm(id, again.confirmationCode);
  assert.equal(sub.outcome, "submitted", sub.detail);
  assert.equal(db.getApplication(id)?.status, "submitted");
});

test("ashby: an answer Ashby's server did not keep is a failed field, though the page shows it", async () => {
  process.env.OPENAPPLY_ADAPTER = "ashby";
  const id = "ashby-drop:acme:fixture";
  db.upsertJobs([{ ...job("ashby", "/ashby/application"), id, title: "Fixture drop check" }]);
  const dir = packDir(id);
  writeFileSync(join(dir, "resume.pdf"), PDF);
  writeFileSync(join(dir, "pack.json"), JSON.stringify({
    jobId: id, resume: { name: "Test Person", contact: {}, experience: [], education: [] },
    answers: { "Why do you want to work at Acme?": "I build agents that ship.", [START]: "1-2 weeks" },
    resumePdf: join(dir, "resume.pdf"), warnings: [], createdAt: new Date().toISOString(),
  }));
  ashbyDrop.add("f-auth").add("f-pronouns"); // a yes/no, and a radio question named <form render id>_<path>
  const res = await engine.fillForm(id);
  assert.deepEqual(res.failed, [AUTH]); // pronouns is optional: skipped, not failed
  for (const label of [AUTH, ASHBY_TITLES["f-pronouns"]]) {
    assert.match(byLabel(res.skipped, label)?.reason ?? "", /Ashby's server did not keep/, label);
  }
  assert.equal(await dom(id, `document.querySelector('[data-field-path="f-auth"] [aria-pressed="true"]')?.textContent`), "Yes",
    "the page still shows Yes, so the screenshot alone cannot tell");
});

test("captcha fixture: interactive challenge stops at needs_human, page stays open", async () => {
  process.env.OPENAPPLY_ADAPTER = "generic";
  const id = "captcha:acme:fixture";
  const ins = await engine.inspectForm(id);
  assert.equal(ins.captchaDetected, true);
  const res = await engine.fillForm(id);
  assert.equal(res.captchaDetected, true);
  assert.equal(await dom(id, "document.getElementById('name').value"), "Test Person");
  const sub = await engine.submitForm(id, res.confirmationCode);
  assert.equal(sub.outcome, "needs_human");
  assert.match(sub.detail, /does not solve CAPTCHAs/);
  assert.equal(db.getApplication(id)?.status, "needs_human");
  assert.ok(openPage(id), "browser page left open for the user");
  assert.match(openPage(id)!.url(), /\/captcha\/apply$/, "never submitted");
});

test("submit refuses when the filled page is gone (restart)", async () => {
  process.env.OPENAPPLY_ADAPTER = "generic";
  const id = "captcha:acme:fixture";
  const res = await engine.fillForm(id);
  await engine.closeBrowser();
  await assert.rejects(engine.submitForm(id, res.confirmationCode), /Run fill again/);
});

test("approval is bound to one fill: re-fill, re-inspect, navigation and races all void it", async () => {
  process.env.OPENAPPLY_ADAPTER = "lever";
  const track = await import("../src/track.js");
  const id = "gate:acme:fixture";
  db.upsertJobs([{ ...job("lever", "/lever/apply"), id, title: "Role gate" }]);
  const dir = packDir(id);
  writeFileSync(join(dir, "resume.pdf"), PDF);
  writeFileSync(join(dir, "pack.json"), JSON.stringify({
    jobId: id, resume: { name: "Test Person", contact: {}, experience: [], education: [] }, answers: {},
    resumePdf: join(dir, "resume.pdf"), warnings: [], createdAt: new Date().toISOString(),
  }));

  // Dashboard approval of fill 1 does not carry over to fill 2.
  const c1 = (await engine.fillForm(id)).confirmationCode;
  track.approve(id, c1);
  const c2 = (await engine.fillForm(id, { "Additional information": "changed after approval" })).confirmationCode;
  assert.equal(db.getApplication(id)?.status, "filled");
  await assert.rejects(engine.submitForm(id), /Submit refused/);
  await assert.rejects(engine.submitForm(id, c1), /Submit refused/);
  assert.throws(() => track.approve(id, c1), /filled again/);

  // The page moved after the fill.
  await openPage(id)!.goto(`${base}/elsewhere`);
  await assert.rejects(engine.submitForm(id, c2), /page moved/);

  // Re-inspecting re-opens (and wipes) the form.
  const c3 = (await engine.fillForm(id)).confirmationCode;
  await engine.inspectForm(id);
  await assert.rejects(engine.submitForm(id, c3), /Submit refused/);

  // A submit racing a re-fill waits for it and then finds its code stale.
  const c4 = (await engine.fillForm(id)).confirmationCode;
  const refill = engine.fillForm(id);
  await assert.rejects(engine.submitForm(id, c4), /Submit refused/);
  const c5 = (await refill).confirmationCode;

  const sub = await engine.submitForm(id, c5);
  assert.equal(sub.outcome, "submitted", sub.detail);
  await assert.rejects(engine.submitForm(id, c5), /already submitted/);
  await assert.rejects(engine.fillForm(id), /already submitted/);
});

test("screenshot: Dia's empty full-page capture falls back to CDP; nothing back means no file", async () => {
  const page = await (await browserContext()).newPage();
  try {
    await page.setContent('<body style="margin:0"><div style="height:3000px"></div></body>');
    page.screenshot = async () => Buffer.alloc(0); // what Dia returns for fullPage
    const png = await fullPageShot(page);
    assert.equal(png?.subarray(1, 4).toString(), "PNG");
    assert.ok(png!.readUInt32BE(20) >= 3000); // the whole page, not the 900 px viewport
    page.context = () => ({ newCDPSession: async () => { throw new Error("no CDP"); } }) as any;
    assert.equal(await fullPageShot(page), undefined);
  } finally {
    await page.close();
  }
});

/**
 * Dia's capture rule, measured 2026-11-02 on a temp profile (Dia 156, retina): Playwright pins the page at
 * devicePixelRatio 1 while Dia paints the window at 2, and Dia hands back an empty PNG (no error) for any scaled
 * capture whose image has an odd width or height. Most forms are an odd number of CSS px tall, and the live window is
 * 1265 px wide beside a classic scrollbar, so nearly every plain full-page capture came back empty.
 */
function captureLikeDia(page: any): void {
  const real = page.screenshot.bind(page);
  page.screenshot = async (o: any = {}) => {
    const size = o.clip ?? (o.fullPage ? await page.evaluate(() => ({
      width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    })) : page.viewportSize());
    return size.width % 2 || size.height % 2 ? Buffer.alloc(0) : real(o);
  };
}

test("screenshot: an odd-sized form comes back whole under Dia's capture rule, without the CDP fallback", async () => {
  const page = await (await browserContext()).newPage();
  try {
    await page.setViewportSize({ width: 1265, height: 900 }); // the live fill window's content width
    await page.setContent(readFileSync(join(FIX, "odd-form.html"), "utf8"));
    assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]), [1265, 2237]);
    captureLikeDia(page);
    // In Dia the fresh-session fallback errors or never answers past about 8000 CSS px, so the first capture must work.
    page.context = () => ({ newCDPSession: async () => { throw new Error("fallback used"); } }) as any;
    const png = await fullPageShot(page);
    assert.equal(png?.subarray(1, 4).toString(), "PNG");
    assert.deepEqual([png!.readUInt32BE(16), png!.readUInt32BE(20)], [1264, 2236]); // the whole form, at most 1 px short
  } finally {
    await page.close();
  }
});

test("screenshot: a CDP fallback that never answers gives no screenshot instead of hanging the fill", async () => {
  const page = await (await browserContext()).newPage();
  try {
    await page.setContent('<body style="margin:0"><div style="height:3000px"></div></body>');
    page.screenshot = async () => Buffer.alloc(0);
    let detached = false;
    page.context = () => ({
      newCDPSession: async () => ({
        send: async (m: string) => m === "Page.getLayoutMetrics" ? { cssContentSize: { width: 1280, height: 20_000 } } : new Promise(() => {}),
        detach: async () => { detached = true; },
      }),
    }) as any;
    const t0 = Date.now();
    assert.equal(await fullPageShot(page, 200), undefined);
    assert.ok(Date.now() - t0 < 5000, "gave up after the timeout");
    assert.ok(detached);
  } finally {
    await page.close();
  }
});

test("screenshot: captured from the top, so a sticky header (Ashby's logo bar) covers no question mid-page", async () => {
  const c = await browserContext();
  const page = await c.newPage(), probe = await c.newPage();
  try {
    await page.setContent('<body style="margin:0"><div style="position:sticky;top:0;height:100px;background:#f00"></div><div style="height:3000px"></div></body>');
    await page.evaluate(() => window.scrollTo(0, 1500)); // a fill ends near the bottom of the form
    page.screenshot = async () => Buffer.alloc(0); // Dia: the CDP capture
    const png = await fullPageShot(page);
    const at = await probe.evaluate(async src => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const cv = document.createElement("canvas");
      [cv.width, cv.height] = [img.width, img.height];
      const g = cv.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const k = img.height / 3100; // device pixels per CSS pixel
      return [50, 1550].map(y => g.getImageData(10, Math.round(y * k), 1, 1).data[1] < 50 ? "header" : "page");
    }, `data:image/png;base64,${png!.toString("base64")}`);
    assert.deepEqual(at, ["header", "page"]);
  } finally {
    await Promise.all([page.close(), probe.close()]);
  }
});

test("fillForm refuses a role already submitted under another job id before touching the pack or browser", async () => {
  const id = "other:acme:repost";
  db.upsertJobs([{ ...job("greenhouse", "/greenhouse/apply"), id }]); // same company and title as the submitted greenhouse fixture
  db.setApplication("greenhouse:acme:fixture", { status: "submitted" });
  await assert.rejects(engine.fillForm(id), /Already applied to Acme · Role greenhouse/);
  assert.equal(db.getApplication(id), undefined);
});

test("tabs the browser restored from its last run close once OpenApply opens its own; popups and blank tabs stay", async () => {
  process.env.OPENAPPLY_ADAPTER = "lever";
  await engine.closeBrowser();
  const c = await browserContext();
  const restored = await c.newPage(); // stands in for a tab Dia brings back on launch
  await restored.goto(`${base}/restored`);
  const id = "restore:acme:fixture";
  db.upsertJobs([{ ...job("lever", "/lever/apply"), id, title: "Role restore" }]);
  await engine.inspectForm(id);
  const ours = openPage(id)!;
  // A restored tab can also arrive a moment after launch, already on its URL.
  const cdp = await c.newCDPSession(ours);
  const arrived = c.waitForEvent("page");
  await cdp.send("Target.createTarget", { url: `${base}/late` });
  const lateTab = await arrived;
  const popup = ours.waitForEvent("popup");
  await ours.evaluate(u => { window.open(u); }, `${base}/popup`);
  const pop = await popup;
  const blank = await c.newPage();
  await new Promise(r => setTimeout(r, 1000));
  assert.ok(restored.isClosed(), "the restored tab is closed");
  assert.ok(lateTab.isClosed(), "the late restored tab is closed");
  assert.ok(!pop.isClosed(), "a popup from our page stays");
  assert.ok(!blank.isClosed(), "a new blank tab stays");
  assert.ok(!ours.isClosed(), "our form stays");
  await Promise.all([pop.close(), blank.close()]);
});

test("inspect without a pack suggests the role's resume track, not profile.resumePdf", async () => {
  process.env.OPENAPPLY_ADAPTER = "greenhouse";
  const id = "greenhouse:acme:defi-nopack";
  db.upsertJobs([{ ...job("greenhouse", "/greenhouse/apply"), id, title: "Protocol Engineer, DeFi" }]);
  const dir = mkdtempSync(join(tmpdir(), "oa-tracks-"));
  const [basePdf, product, crypto] = ["Noel_Turlington.pdf", "Noel_Turlington_Product.pdf", "Noel_Turlington_Crypto.pdf"].map(f => join(dir, f));
  for (const f of [basePdf, product, crypto]) writeFileSync(f, PDF);
  const saved = readFileSync(paths.profile, "utf8");
  try {
    writeFileSync(paths.profile, JSON.stringify({
      ...JSON.parse(saved), resumePdf: basePdf, defaultResume: "product",
      resumes: { product: { pdf: product, useFor: ["forward deployed"] }, crypto: { pdf: crypto, useFor: ["defi"] } },
    }));
    const ins = await engine.inspectForm(id);
    assert.equal(byLabel(ins.fields, "Resume/CV")?.suggested, crypto);
  } finally {
    writeFileSync(paths.profile, saved);
    await engine.closeBrowser();
  }
});

test("lever detection: the verification banner and a dropped resume are a refused submit; only /thanks or 'Application submitted!' is success", async () => {
  const { lever, leverRejection } = await import("../src/apply/adapters/lever.js");
  const page = await (await browserContext()).newPage();
  try {
    await page.setContent(readFileSync(join(FIX, "lever-verify-error.html"), "utf8"));
    assert.match(String(await leverRejection(page)), /error verifying your application.*resume was dropped/);
    assert.equal(await lever.confirmSubmitted(page), false);

    await page.setContent(readFileSync(join(FIX, "lever-thanks.html"), "utf8"));
    assert.equal(await leverRejection(page), null);
    assert.equal(await lever.confirmSubmitted(page), true, "the text alone proves it");

    await page.setContent("<h2>Thank you for applying!</h2>");
    assert.equal(await lever.confirmSubmitted(page), false, "a generic thank-you is not Lever's proof");
    await page.goto(`${base}/lever/thanks`);
    assert.equal(await lever.confirmSubmitted(page), true, "the /thanks URL proves it");

    // The form before submit, resume attached: nothing refused yet.
    await page.goto(`${base}/lever/apply`);
    await page.setInputFiles("#resume-upload-input", { name: "resume.pdf", mimeType: "application/pdf", buffer: Buffer.from(PDF) });
    assert.equal(await leverRejection(page), null);
  } finally {
    await page.close();
  }
});

test("lever submit refused by verification: verification_failed, not submitted, names the normal-browser fix", async () => {
  process.env.OPENAPPLY_ADAPTER = "lever";
  const id = "verify:acme:fixture";
  db.upsertJobs([{ ...job("lever", "/lever-verify/apply"), id, title: "Role verify" }]);
  const dir = packDir(id);
  writeFileSync(join(dir, "resume.pdf"), PDF);
  writeFileSync(join(dir, "pack.json"), JSON.stringify({
    jobId: id, resume: { name: "Test Person", contact: {}, experience: [], education: [] },
    answers: { "Why do you want to work at Acme?": "I build agents that ship." },
    resumePdf: join(dir, "resume.pdf"), warnings: [], createdAt: new Date().toISOString(),
  }));
  const res = await engine.fillForm(id, { "Language Skill(s) (Check all that apply)": "English" });
  const sub = await engine.submitForm(id, res.confirmationCode);
  assert.equal(sub.outcome, "verification_failed", sub.detail);
  assert.match(sub.detail, /NOT submitted.*error verifying.*normal browser/);
  assert.equal(sub.applyUrl, `${base}/lever-verify/apply`);
  assert.equal(sub.resume, join(dir, "resume.pdf"));
  assert.equal(db.getApplication(id)?.status, "needs_human");
  assert.equal(db.getApplication(id)?.submittedAt, undefined);
  const ev = db.listEvents(id).find(e => e.kind === "verification_failed");
  assert.equal(JSON.parse(ev!.detail!).applyUrl, sub.applyUrl, "the dashboard reads the link from the event");
  assert.ok(openPage(id), "the window stays open");
});

test("update_application to submitted on a Lever job without /thanks proof keeps a note", async () => {
  const track = await import("../src/track.js");
  const lv = (id: string) => ({ ...job("lever", "/x"), id, ats: "lever" as const, title: `Role ${id}`, url: "https://jobs.lever.co/acme/1", applyUrl: "https://jobs.lever.co/acme/1/apply" });
  db.upsertJobs([lv("lever:acme:noproof"), lv("lever:acme:proof")]);
  const a = track.updateStatus("lever:acme:noproof", "submitted", "Finished in Dia");
  assert.match(a.notes ?? "", /Finished in Dia\n.*without Lever's confirmation/);
  assert.ok(db.listEvents("lever:acme:noproof").some(e => e.kind === "note" && /without Lever's confirmation/.test(e.detail ?? "")));
  const b = track.updateStatus("lever:acme:proof", "submitted", "Saw the /thanks page in Dia");
  assert.doesNotMatch(b.notes ?? "", /without Lever's confirmation/);
  const c = track.updateStatus("greenhouse:acme:fixture", "submitted");
  assert.doesNotMatch(c.notes ?? "", /Lever/, "only Lever jobs");
});
