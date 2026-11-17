import { test } from "node:test";
import assert from "node:assert/strict";
import type { FormField, Profile } from "../src/types.js";

const { suggest, pickOptions, toDate } = await import("../src/apply/fieldmap.js");

// The real option lists from a live Greenhouse form (boards-api.greenhouse.io/v1/boards/<slug>/jobs/<id>?questions=true).
const AI_EXPERIENCE = [
  "I use AI tools daily as part of my professional job duties for my employer, but don't teach others.",
  "I use AI tools daily as part of my professional job duties for my employer, and I teach others.",
  "I do not use AI at work, but I regularly use it in my personal life. I'd love to learn more.",
  "I use AI tools at work, but only occasionally or weekly. I'd love to learn more.",
  "I do not use AI tools in my work or personal life. I am opening to learning",
];
const TANGIBLE = ["Career Growth", "Work-life Balance", "Remote Work", "Leadership", "Compensation", "Benefits", "PTO", "Career Stability", "Culture", "Company Outlook"];
const DEGREES = ["Associate's Degree", "Bachelor's Degree", "Doctor of Medicine (MD)", "Doctor of Philosophy (PhD)", "Engineer's Degree", "High School Diploma", "Juris Doctor (JD)", "Master of Business Administration (MBA)", "Master's Degree", "N/A - Did Not Complete", "Other", "Trade School / Vocational Program"];
const DISCIPLINES = ["Accounting", "Business", "Chemistry", "Computer Science", "Economics", "Engineering", "Information Systems", "Law", "Naval Science", "Political Science", "Science", "Social Science", "Social Sciences", "Statistics & Decision Theory"];

const checkbox = (label: string, options: string[]): FormField => ({ key: "q[]", label, type: "checkbox", required: true, options });
const ask = (f: FormField, answer: string, profile?: Profile) => suggest(f, { answers: { [f.label]: answer }, files: {}, profile })?.value;

test("multi-select: an answer equal to one option picks exactly that option, commas and all", () => {
  const f = checkbox("Which statement best describes your current experience with AI?", AI_EXPERIENCE);
  assert.equal(ask(f, AI_EXPERIENCE[1]), AI_EXPERIENCE[1]);
  assert.equal(ask(f, AI_EXPERIENCE[0]), AI_EXPERIENCE[0]);
  assert.equal(ask(f, AI_EXPERIENCE[3]), AI_EXPERIENCE[3]);
  assert.equal(ask(f, AI_EXPERIENCE[1].replace(/\.$/, "")), AI_EXPERIENCE[1], "punctuation and case do not matter");
  assert.deepEqual(pickOptions(AI_EXPERIENCE, AI_EXPERIENCE[1]), [AI_EXPERIENCE[1]]);
});

test("multi-select: a list picks each option, even when an option contains commas", () => {
  const ai = checkbox("Which statement best describes your current experience with AI?", AI_EXPERIENCE);
  assert.equal(ask(ai, `${AI_EXPERIENCE[1]}, ${AI_EXPERIENCE[3]}`), `${AI_EXPERIENCE[1]}, ${AI_EXPERIENCE[3]}`);
  assert.deepEqual(pickOptions(AI_EXPERIENCE, `${AI_EXPERIENCE[3]} | ${AI_EXPERIENCE[0]}`), [AI_EXPERIENCE[3], AI_EXPERIENCE[0]]);
  const tangible = checkbox("What tangible factors are most important to you when considering a job opportunity?", TANGIBLE);
  assert.equal(ask(tangible, "Career Growth, Compensation, Remote Work"), "Career Growth, Compensation, Remote Work");
  assert.equal(ask(tangible, "remote work; PTO"), "Remote Work, PTO");
  assert.equal(ask(tangible, "Career Growth"), "Career Growth");
});

test("multi-select: a partial piece never picks a different option", () => {
  const f = checkbox("Which statement best describes your current experience with AI?", AI_EXPERIENCE);
  // Half of an option (cut at its comma) fits two options equally: no pick, so the form reports a blank.
  assert.equal(ask(f, "I use AI tools daily as part of my professional job duties for my employer"), undefined);
  assert.equal(ask(f, "I use AI tools"), undefined, "three options start this way");
  assert.deepEqual(pickOptions(AI_EXPERIENCE, "I use AI tools daily as part of my professional job duties for my employer, and I teach others"), [AI_EXPERIENCE[1]]);
});

test("multi-select: an answer worded differently from the options picks one option only when it is clear, else none", () => {
  const f = checkbox("Which statement best describes your current experience with AI?", AI_EXPERIENCE);
  // the option minus its trailing sentence, or cut off after its first clause, still names exactly one option
  assert.equal(ask(f, "I do not use AI at work, but I regularly use it in my personal life."), AI_EXPERIENCE[2]);
  assert.equal(ask(f, "I do not use AI at work"), AI_EXPERIENCE[2]);
  assert.equal(ask(f, "I use AI tools at work, but only occasionally or weekly."), AI_EXPERIENCE[3]);
  // an option's word inside a sentence is not a pick
  assert.deepEqual(pickOptions(["Other", "Python, Go", "Rust"], "I work in Rust and other things"), []);
  assert.deepEqual(pickOptions(["Other", "Python, Go", "Rust"], "Rust and Other"), ["Rust", "Other"]);
  // the plain option is not ticked when the answer is the longer option reworded
  assert.deepEqual(pickOptions(["Yes", "Yes, and I will relocate", "No"], "Yes, I will relocate"), ["Yes, and I will relocate"]);
});

test("education: school, degree and discipline come from the profile; lists need the exact listed wording", () => {
  const profile: Profile = { firstName: "A", lastName: "B", email: "a@b.c", education: [{ school: "Riverside University", degree: "Bachelor's Degree", discipline: "Information Science", endYear: 2023 }] };
  const ctx = { answers: {}, files: {}, profile };
  const field = (label: string, type: FormField["type"], options?: string[]): FormField => ({ key: label, label, type, required: label !== "Start date year", options });
  const s = (f: FormField, c: typeof ctx = ctx) => suggest(f, c);
  assert.deepEqual(s(field("School", "combobox")), { value: "Riverside University", source: "profile" });
  assert.equal(s(field("Degree", "combobox", DEGREES))?.value, "Bachelor's Degree");
  assert.equal(s(field("End date year", "number"))?.value, "2023");
  assert.equal(s(field("Start date year", "number")), undefined, "no start year, nothing invented");
  // the listed wording, whatever the case, is taken; a different discipline never is
  const withDiscipline = (discipline: string) => ({ ...ctx, profile: { ...profile, education: [{ school: "X", discipline }] } });
  assert.equal(s(field("Discipline", "combobox", DISCIPLINES), withDiscipline("information systems"))?.value, "Information Systems");
  assert.equal(s(field("Discipline", "combobox", DISCIPLINES)), undefined, "Information Science is not Information Systems");
  for (const [list, want] of [[["Biochemistry", "Physics"], "Chemistry"], [["Econometrics", "Physics", "Law"], "Economics"], [["Neuropsychology", "Law"], "Psychology"], [["Mathematical Statistics", "Law"], "Mathematics"]] as const) {
    assert.equal(s(field("Discipline", "combobox", [...list]), withDiscipline(want)), undefined, `${want} is not ${list[0]}`);
  }
  // an unrelated question that merely mentions school is not the education block
  assert.equal(s(field("Why did you leave school?", "textarea")), undefined);
  assert.equal(suggest(field("School", "combobox"), { answers: {}, files: {}, profile: { ...profile, education: undefined } }), undefined);
});

test("education: a year the profile lacks stays blank and never falls through to the notice period", () => {
  const base: Profile = { firstName: "A", lastName: "B", email: "a@b.c", noticePeriod: "1-2 weeks" };
  const year = (label: string): FormField => ({ key: "k", label, type: "number", required: false });
  for (const education of [undefined, [{ school: "X", endYear: 2023 }]]) {
    const ctx = { answers: {}, files: {}, profile: { ...base, education } };
    assert.equal(suggest(year("Start date year"), ctx), undefined);
  }
  assert.equal(suggest(year("End date year"), { answers: {}, files: {}, profile: { ...base, education: [{ school: "X", startYear: 2019 }] } }), undefined);
  assert.equal(suggest({ key: "k", label: "Start date", type: "text", required: false }, { answers: {}, files: {}, profile: base })?.value, "1-2 weeks", "a real start-date question still gets the notice period");
});

test("date fields: a start-date answer becomes a real YYYY-MM-DD date, anything else waits for the user", () => {
  const wed = new Date(2026, 9, 21); // Wednesday 2026-10-21
  for (const [raw, want] of [
    ["1-2 weeks", "2026-11-04"], ["2 weeks", "2026-11-04"], ["two weeks' notice", "2026-11-04"], ["within 2 weeks", "2026-11-04"],
    ["1 to 2 weeks", "2026-11-04"], ["Immediately", "2026-10-21"], ["ASAP", "2026-10-21"],
    ["3 days", "2026-10-26"], // Saturday 10-24 moves to the Monday
    ["a month", "2026-11-20"],
    ["2026-11-15", "2026-11-15"], ["11/15/2026", "2026-11-15"], ["Nov 15, 2026", "2026-11-15"], ["November 15", "2026-11-15"], // a date given stays, Sunday or not
    ["Jan 5", "2027-01-05"],
  ] as const) assert.equal(toDate(raw, wed), want, raw);
  for (const raw of ["After my notice period", "Flexible", "13/01/2026", "Feb 30, 2027", "", "1-2"]) assert.equal(toDate(raw, wed), undefined, raw);

  const date: FormField = { key: "k", label: "When is the earliest you would want to start working with us?", type: "date", required: true };
  assert.match(ask(date, "1-2 weeks")!, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ask(date, "1-2 weeks"), toDate("1-2 weeks"));
  assert.equal(ask(date, "After my notice period"), undefined, "a non-date answer is never typed into a date picker");
  const profile: Profile = { firstName: "A", lastName: "B", email: "a@b.c", noticePeriod: "2 weeks" };
  assert.equal(suggest(date, { answers: {}, files: {}, profile })?.value, toDate("2 weeks"), "the profile's notice period too");
});

test("relocation and office-day questions about a place take only a profile or saved answer that covers that place", async () => {
  const { commitmentPlace } = await import("../src/apply/fieldmap.js");
  const SF_OFFICE = "Are you willing to work from our office in San Francisco, California full-time, 3+ days a week?";
  const SF_RELOCATE = "If you are not located near San Francisco, California, are you willing to relocate if offered employment?";
  const NY = "I'm based in New York, so no relocation needed. I prefer hybrid but I'm open to being in person.";
  const yesNo = (label: string): FormField => ({ key: label, label, type: "select", required: true, options: ["Yes", "No"] });
  const text = (label: string): FormField => ({ key: label, label, type: "text", required: true });
  const profile: Profile = { firstName: "A", lastName: "B", email: "a@b.c", location: "New York, NY", savedAnswers: { "Willing to relocate": NY } };
  const ctx = { answers: {}, files: {}, profile };
  const willing = { ...ctx, profile: { ...profile, willingToRelocate: true } };
  // a generic yes or a New York answer never commits to San Francisco
  for (const c of [ctx, willing]) for (const f of [yesNo(SF_OFFICE), yesNo(SF_RELOCATE), text(SF_RELOCATE)]) assert.equal(suggest(f, c), undefined, f.label);
  const commute = { ...ctx, profile: { ...profile, savedAnswers: { "Open to commuting to the office": "Yes" } } };
  assert.equal(suggest(text("Are you open to commuting to our Austin office?"), commute), undefined);
  assert.equal(suggest(text("When can you start in Boston?"), { ...ctx, profile: { ...profile, noticePeriod: "1-2 weeks" } }), undefined);
  // a saved answer that names the place answers it; the New York one still answers New York
  const sf = { ...ctx, profile: { ...profile, savedAnswers: { "Willing to relocate": "Yes, happy to move to San Francisco" } } };
  assert.equal(suggest(yesNo(SF_RELOCATE), sf)?.value, "Yes");
  assert.equal(suggest(text("Are you willing to relocate to New York?"), ctx)?.value, NY);
  // a question that names no place: the job's city is the place, unless the job is remote
  assert.equal(suggest(yesNo("Are you willing to relocate?"), willing)?.value, "Yes");
  assert.equal(suggest(text("Are you willing to relocate?"), { ...ctx, job: { location: "Chicago", remote: false } }), undefined);
  assert.equal(suggest(yesNo("Are you willing to relocate?"), { ...willing, job: { location: "Chicago", remote: false } }), undefined);
  assert.equal(suggest(text("Are you willing to relocate?"), { ...ctx, job: { location: "New York, NY", remote: false } })?.value, NY);
  assert.equal(suggest(text("Are you willing to relocate?"), { ...ctx, job: { location: "United States", remote: true } })?.value, NY);
  assert.equal(suggest(text("Are you willing to relocate?"), { ...ctx, job: { location: "NYC", remote: false } })?.value, NY, "NYC is New York");
  // sponsorship and work authorization are never place commitments, whatever cities or start words they mention
  const auth = { ...ctx, profile: { ...profile, location: "Brooklyn, NY", needsSponsorship: false, workAuthorizedUS: true } };
  assert.equal(suggest(yesNo("Do you now, or will you in the future, require sponsorship for employment visa status (e.g., H-1B visa, etc.) or a visa extension in order to start or continue to work legally for Umbrella in the United States?"), auth)?.value, "No");
  assert.equal(suggest(yesNo("Are you legally authorized to work in the United States for Umbrella?"), auth)?.value, "Yes");
  assert.equal(commitmentPlace("Do you have any experience in mailroom operations, reprographics, imaging services, or other related office support roles?"), undefined, "office work is not an office location");
  // start dates and the user's own pack answers are unchanged
  assert.equal(suggest(text("When can you start working with Umbrella?"), { ...ctx, profile: { ...profile, savedAnswers: { "When can you start": "1-2 weeks" } } })?.value, "1-2 weeks");
  assert.equal(suggest(yesNo(SF_OFFICE), { ...ctx, answers: { [SF_OFFICE]: "Yes" } })?.value, "Yes");
});
