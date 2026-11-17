import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-scoreboard-"));
const sb = await import("../src/scoreboard.js");
const { STRATEGY_DEFAULTS, loadStrategy, parseStrategy, initStrategy, strategyPath } = await import("../src/strategy.js");
import type { ScoreApplication, ScoreEvent, ScoreboardInput } from "../src/scoreboard.js";
import type { StrategyConfig } from "../src/strategy.js";
import type { Outreach } from "../src/types.js";

/** The example strategy file: five lead companies, the bench, milestones, the Dec 3 gate. */
const EXAMPLE_FILE = join(import.meta.dirname, "..", "strategy", "example.json");
const parsed = parseStrategy(JSON.parse(readFileSync(EXAMPLE_FILE, "utf8")));
const cfg: StrategyConfig = parsed.config;
const TZ = cfg.timeZone;
/** Tue Nov 3 2026, 06:00 ET. */
const NOW = new Date("2026-11-03T11:00:00Z");

let nextId = 1;
function out(p: Partial<Outreach> & { company: string; person: string }): Outreach {
  const at = p.sentAt ?? "2026-11-02T15:00:00Z";
  return { id: nextId++, channel: "linkedin", status: "sent", followUps: 0, sentAt: at, lastTouchAt: p.lastTouchAt ?? at, ...p };
}
const app = (p: Partial<ScoreApplication> & { jobId: string; company: string }): ScoreApplication =>
  ({ title: "Implementation Lead", status: "submitted", ...p });
const input = (p: Partial<ScoreboardInput>): ScoreboardInput => ({ applications: [], outreach: [], events: [], followUps: [], ...p });

test("localDate and instant read stored times in New York time; plain dates and zone-less times stay local", () => {
  assert.equal(sb.localDate("2026-11-03T03:06:13.868Z", TZ), "2026-11-02", "11 pm ET the night before");
  assert.equal(sb.localDate("2026-11-02", TZ), "2026-11-02");
  assert.equal(sb.localDate("2026-11-06T10:00", TZ), "2026-11-06");
  assert.equal(new Date(sb.instant("2026-11-02", TZ)!).toISOString(), "2026-11-02T05:00:00.000Z", "midnight EST");
  assert.equal(new Date(sb.instant("2026-10-30T09:00", TZ)!).toISOString(), "2026-10-30T13:00:00.000Z", "EDT before Nov 1");
  assert.equal(sb.instant("not a date", TZ), undefined);
});

test("the example strategy file passes every check", () => {
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(cfg.companies.map(c => c.company), ["Hooli", "Wonka", "Soylent", "Tyrell", "Oscorp"]);
  assert.ok(!readFileSync(EXAMPLE_FILE, "utf8").includes("\u2014"), "no em dashes");
  assert.deepEqual([STRATEGY_DEFAULTS.companies, STRATEGY_DEFAULTS.bench, STRATEGY_DEFAULTS.milestones], [[], [], []], "the code defaults name nobody");
  assert.ok(!cfg.companies.some(c => JSON.stringify(STRATEGY_DEFAULTS).includes(c.company)));
});

test("outreachSent: open statuses count, drafts never, closed only with proof", () => {
  const ev: ScoreEvent[] = [
    { jobId: "j1", at: "2026-11-02T15:00:00Z", kind: "outreach", detail: "draft ready: linkedin to Ann (CEO) at A" },
    { jobId: "j2", at: "2026-11-02T15:00:00Z", kind: "outreach", detail: "linkedin to Bo at B" },
  ];
  assert.equal(sb.outreachSent(out({ company: "A", person: "Ann", status: "replied" }), ev), true);
  assert.equal(sb.outreachSent(out({ company: "A", person: "Ann", status: "draft" }), ev), false);
  assert.equal(sb.outreachSent(out({ company: "A", person: "Ann", status: "closed", jobId: "j1" }), ev), false, "a skipped draft");
  assert.equal(sb.outreachSent(out({ company: "B", person: "Bo", status: "closed", jobId: "j2" }), ev), true, "sent, then closed");
  assert.equal(sb.outreachSent(out({ company: "C", person: "Cy", status: "closed", followUps: 1 }), ev), true);
  assert.equal(sb.outreachSent(out({ company: "C", person: "Cy", status: "closed" }), ev), false, "no job, no proof");
});

test("outreachSent: a later send to the same person is not proof for a closed draft; the person must match exactly", () => {
  // Umbrella: row 1 a draft closed unsent, row 8 a new draft to the same person, then sent (one send event)
  const closed = out({ company: "Umbrella", person: "Morgan Hale", status: "closed", jobId: "au", sentAt: "2026-10-13T15:00:00Z" });
  const resent = out({ company: "Umbrella", person: "Morgan Hale", status: "sent", jobId: "au", sentAt: "2026-11-03T15:00:00Z" });
  const ev: ScoreEvent[] = [
    { jobId: "au", at: "2026-10-13T15:00:00Z", kind: "outreach", detail: "draft ready: linkedin to Morgan Hale at Umbrella" },
    { jobId: "au", at: "2026-11-03T15:00:00Z", kind: "outreach", detail: "linkedin to Morgan Hale at Umbrella" },
  ];
  const all = [closed, resent];
  assert.equal(sb.outreachSent(closed, ev, all), false, "the one send event belongs to the sent row");
  assert.equal(sb.outreachSent(resent, ev, all), true);
  // sent, then closed, then a new note sent: two send events, both rows count
  const ev2 = [...ev, { jobId: "au", at: "2026-10-13T16:00:00Z", kind: "outreach", detail: "linkedin to Morgan Hale (CEO) at Umbrella" }];
  assert.equal(sb.outreachSent(closed, ev2, all), true);
  // two closed rows, one send event: it belongs to the row sent at that time, else the closest earlier row
  const older = out({ company: "Umbrella", person: "Morgan Hale", status: "closed", jobId: "au", sentAt: "2026-10-14T15:00:00Z" });
  const newer = out({ company: "Umbrella", person: "Morgan Hale", status: "closed", jobId: "au", sentAt: "2026-10-18T15:00:00Z" });
  const sendAt = (at: string) => [{ jobId: "au", at, kind: "outreach", detail: "linkedin to Morgan Hale at Umbrella" }];
  const both = [older, newer];
  assert.deepEqual([sb.outreachSent(older, sendAt("2026-10-20T15:00:00Z"), both), sb.outreachSent(newer, sendAt("2026-10-20T15:00:00Z"), both)], [false, true]);
  assert.deepEqual([sb.outreachSent(older, sendAt("2026-10-14T15:00:00.004Z"), both), sb.outreachSent(newer, sendAt("2026-10-14T15:00:00.004Z"), both)], [true, false], "the row sent at that moment");
  assert.deepEqual([sb.outreachSent(older, sendAt("2026-10-10T15:00:00Z"), both), sb.outreachSent(newer, sendAt("2026-10-10T15:00:00Z"), both)], [false, false], "no row before it: nobody");
  // "Ann" is not proven by a send to "Anna Lee"
  const ann = out({ company: "A", person: "Ann", status: "closed", jobId: "a" });
  assert.equal(sb.outreachSent(ann, [{ jobId: "a", at: "2026-11-02T15:00:00Z", kind: "outreach", detail: "linkedin to Anna Lee at A" }]), false);
  assert.equal(sb.outreachSent(ann, [{ jobId: "a", at: "2026-11-02T15:00:00Z", kind: "outreach", detail: "linkedin to Ann" }]), true);
});

test("weeks: each person counts once, in the week first asked; applications by submit date", () => {
  const later = new Date("2026-11-17T15:00:00Z"); // Tue of week 3
  const s = sb.computeScoreboard(input({
    outreach: [
      out({ company: "Wonka", person: "Avery" }),
      out({ company: "Wonka", person: "Avery", sentAt: "2026-11-03T15:00:00Z" }), // same person, same week
      out({ company: "Soylent", person: "Dana", sentAt: "2026-11-03T15:00:00Z" }),
      out({ company: "Wayne", person: "Dana", sentAt: "2026-11-04T15:00:00Z" }), // same connector, another company
      out({ company: "Soylent", person: "dana ", sentAt: "2026-11-10T15:00:00Z" }), // asked again in week 2
      out({ company: "Oscorp", person: "Robin", status: "draft" }), // a draft is not an ask
      out({ company: "Tyrell", person: "Shay", sentAt: "2026-11-09T15:00:00Z" }),
      out({ company: "Piper", person: "Toby", sentAt: "2026-11-10T15:00:00Z" }),
      out({ company: "Old", person: "Pre", sentAt: "2026-10-30T15:00:00Z" }), // before week 1
    ],
    applications: [
      app({ jobId: "a1", company: "Wonka", submittedAt: "2026-11-04T19:00:00Z" }),
      app({ jobId: "a2", company: "Soylent", submittedAt: "2026-11-09", status: "rejected" }),
      app({ jobId: "a3", company: "Tyrell", status: "drafted" }),
      app({ jobId: "a4", company: "Zed", submittedAt: "2026-11-15T03:00:00Z" }), // Sat 22:00 ET: week 2
      app({ jobId: "a5", company: "Yu", submittedAt: "2026-11-12T15:00:00Z" }),
    ],
  }), cfg, later);
  assert.deepEqual(sb.computeScoreboard(input({}), cfg, later).weeks.map(w => w.week), [1, 2, 3]);
  const [w1, w2, w3] = s.weeks;
  assert.deepEqual([w1.warmAsks, w1.applications, w1.slipped], [2, 1, true], "Avery and Dana; Dana's second company is not a new ask");
  assert.deepEqual([w2.warmAsks, w2.applications], [2, 3], "Shay and Toby; Dana again does not count");
  assert.deepEqual([w3.current, w3.slipped], [true, null]);
  assert.equal(s.week.week, 3);
  assert.equal(s.totals.warmAsks, 4, "distinct people since the start");
  assert.equal(s.totals.applications, 4);
});

test("halving (STRATEGY.md section 4): fewer than 3 of the five in by the end of week 1 halves every target once, for the rest", () => {
  const asks = ["P1", "P2", "P3", "P4"].map(p => out({ company: "Bench Co", person: p, sentAt: "2026-11-03T15:00:00Z" }));
  const five = (n: number, extra = 0) => [
    ...["Hooli", "Wonka", "Soylent", "Tyrell", "Oscorp"].slice(0, n).map((c, i) => app({ jobId: `f${i}`, company: c, submittedAt: "2026-11-04T15:00:00Z" })),
    ...Array.from({ length: extra }, (_, i) => app({ jobId: `x${i}`, company: `Other ${i}`, submittedAt: "2026-11-05T15:00:00Z" })),
  ];
  const wk3 = new Date("2026-11-17T15:00:00Z");
  // 5 applications and 4 asks, none at the five: on target, but the strategy still halves
  const a = sb.computeScoreboard(input({ outreach: asks, applications: five(0, 5) }), cfg, wk3);
  assert.deepEqual([a.weeks[0].slipped, a.weeks[0].halved, a.weeks[1].halved], [false, false, true]);
  assert.deepEqual(a.weeks[1].targets, { warmAsks: 2, applications: 3 });
  assert.deepEqual(a.weeks[2].targets, { warmAsks: 2, applications: 3 }, "stays halved, never halved again");
  assert.deepEqual(a.halving, { threshold: 3, submittedByWeek1: 0, decided: true, halved: true });
  // 3 of the five in with 3 applications and 4 asks: under target, but no halving
  const b = sb.computeScoreboard(input({ outreach: asks, applications: five(3) }), cfg, wk3);
  assert.deepEqual([b.weeks[0].slipped, b.weeks[1].halved, b.weeks[2].halved], [true, false, false]);
  assert.deepEqual(b.weeks[2].targets, { warmAsks: 4, applications: 5 });
  // empty weeks: one halving, not 4/5, 2/3, 1/2, 1/1
  const c = sb.computeScoreboard(input({}), cfg, new Date("2026-11-30T15:00:00Z"));
  assert.deepEqual(c.weeks.map(w => `${w.targets.warmAsks}/${w.targets.applications}`), ["4/5", "2/3", "2/3", "2/3", "2/3"]);
  // during week 1 nothing is decided yet; with no lead companies the rule never applies
  assert.equal(sb.computeScoreboard(input({}), cfg, NOW).halving.decided, false);
  assert.equal(sb.computeScoreboard(input({}), STRATEGY_DEFAULTS, wk3).weeks[1].halved, false);
});

const ev = (jobId: string, at: string, kind: string, detail?: unknown): ScoreEvent =>
  ({ jobId, at, kind, detail: detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail) });
/** A mail the outcomes bridge recorded before date_source existed: a plain date (the mail's day) and its source_id. */
const bridgeMail = (jobId: string, day: string, n = day) => ev(jobId, `${day}T12:15:00Z`, "interview", { summary: `${day}: interview mail`, date: day, source_id: `mail:${n}` });
const convo = (apps: ScoreApplication[], events: ScoreEvent[], today?: string) =>
  sb.conversations(apps, events, TZ, today).map(c => [c.date, c.scheduled, c.first, c.round ?? null, !!c.possibleRound]);
const at = (iso: string) => new Date(iso);

test("conversations: a booked one counts in its week; a second booking is a possible round, never a round passed", () => {
  const events: ScoreEvent[] = [
    ev("t", "2026-11-03T03:06:13Z", "status", "interview"),
    ev("t", "2026-11-03T03:06:13Z", "interview", { summary: "screen", date: "2026-11-06T10:00" }),
    ev("t", "2026-11-07T16:00:00Z", "interview_scheduled", { date: "2026-11-12T14:00" }), // booked the day after the screen
    ev("f", "2026-11-04T15:00:00Z", "status", "interview"), // no interview event: one undated conversation
    ev("old", "2026-10-01T15:00:00Z", "screen"), // no date: a notice, so an undated conversation
  ];
  const apps = [
    app({ jobId: "t", company: "Hooli", status: "interview", submittedAt: "2026-10-11" }),
    app({ jobId: "f", company: "Foo", status: "interview" }),
    app({ jobId: "old", company: "Old", status: "rejected" }),
  ];
  assert.deepEqual(sb.conversations(apps, events, TZ).map(x => [x.company, x.date, x.scheduled, x.first]), [
    ["Old", "2026-10-01", false, true], ["Foo", "2026-11-04", false, true], ["Hooli", "2026-11-06", true, true], ["Hooli", "2026-11-12", true, false],
  ]);
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, NOW);
  assert.deepEqual([s.week.firstConversations, s.week.firstConversationsBooked], [2, 1], "Foo (in process) and Hooli (booked); Old is before the start");
  assert.equal(s.totals.firstConversations, 0, "as of Nov 3 none has happened yet");
  assert.deepEqual(s.upcoming.map(x => x.date), ["2026-11-06", "2026-11-12"], "the undated one is never upcoming");
  const after = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-13T15:00:00Z"));
  assert.deepEqual(after.weeks.map(w => [w.roundsPassed, w.possibleRounds]), [[0, 0], [0, 1]], "the Nov 12 conversation is only a possible round");
  assert.deepEqual([after.totals.pastFirstScreen, after.totals.possibleRounds, after.totals.firstConversations], [0, 1, 2]);
  assert.equal(after.gate.note, cfg.gate.noRoundPassed, "the screen-is-the-problem warning stays");
  assert.match(sb.scoreboardText(after), /1 possible next round not logged/);
  assert.match(sb.scoreboardText(after), /Log a round with log_event \(JSON round: 2\) when a second round is booked\./);
});

test("B1: invite, confirmation and reminder mails from the sweep are one conversation, not three rounds", () => {
  const apps = [app({ jobId: "s", company: "Wonka", status: "interview", submittedAt: "2026-11-04T15:00:00Z" })];
  const events: ScoreEvent[] = [ev("s", "2026-11-09T12:00:00Z", "status", "interview"),
    bridgeMail("s", "2026-11-09"), bridgeMail("s", "2026-11-10"), bridgeMail("s", "2026-11-12")];
  assert.deepEqual(convo(apps, events), [["2026-11-09", false, true, 1, false]], "notices: one in-process conversation, held when the status changed");
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-13T15:00:00Z"));
  assert.deepEqual([s.weeks[1].firstConversations, s.weeks[1].roundsPassed, s.totals.pastFirstScreen, s.totals.firstConversations], [1, 0, 0, 1]);
  assert.equal(s.gate.note, cfg.gate.noRoundPassed, "the screen-is-the-problem note shows");
  assert.deepEqual(s.upcoming, []);
  // the same with the sweep's date_source: "mail" notices
  const tagged = events.map(e => e.kind === "interview" ? { ...e, detail: JSON.stringify({ ...JSON.parse(e.detail!), date_source: "mail" }) } : e);
  assert.deepEqual(convo(apps, tagged), [["2026-11-09", false, true, 1, false]]);
  // mails a week apart are still one conversation; only an explicit round marker counts a round
  assert.deepEqual(convo(apps, [bridgeMail("s", "2026-11-09"), bridgeMail("s", "2026-11-17")]), [["2026-11-09", false, true, 1, false]]);
  const marked = [bridgeMail("s", "2026-11-09"), ev("s", "2026-11-11T15:00:00Z", "interview", { date: "2026-11-11", round: 2 })];
  const m = sb.computeScoreboard(input({ applications: apps, events: marked }), cfg, at("2026-11-13T15:00:00Z"));
  assert.deepEqual([m.weeks[1].roundsPassed, m.totals.pastFirstScreen, m.gate.note ?? null], [1, 1, null]);
});

test("S: a reschedule is the same conversation; a far booking with no reschedule mark is a separate one but no round", () => {
  const apps = [app({ jobId: "t", company: "Hooli", status: "interview" })];
  const moved: ScoreEvent[] = [
    ev("t", "2026-11-03T03:00:00Z", "interview", { date: "2026-11-06T10:00" }),
    ev("t", "2026-11-05T15:00:00Z", "interview_rescheduled", { date: "2026-11-09T10:00" }),
  ];
  assert.deepEqual(convo(apps, moved), [["2026-11-09", true, true, 1, false]]);
  const s = sb.computeScoreboard(input({ applications: apps, events: moved }), cfg, at("2026-11-10T15:00:00Z"));
  assert.deepEqual([s.totals.pastFirstScreen, s.totals.firstConversations, s.totals.possibleRounds], [0, 1, 0]);
  const viaField: ScoreEvent[] = [moved[0], ev("t", "2026-11-05T15:00:00Z", "interview", { date: "2026-11-16T10:00", rescheduled_from: "2026-11-06T10:00" })];
  assert.deepEqual(convo(apps, viaField), [["2026-11-16", true, true, 1, false]]);
  const unmarked: ScoreEvent[] = [moved[0], ev("t", "2026-11-05T15:00:00Z", "interview", { date: "2026-11-16T10:00" })];
  const u = sb.computeScoreboard(input({ applications: apps, events: unmarked }), cfg, at("2026-11-17T15:00:00Z"));
  assert.deepEqual([u.totals.firstConversations, u.totals.pastFirstScreen, u.totals.possibleRounds], [1, 0, 1]);
});

test("S: round 1 recorded only as the status change and a later booking are one conversation, not a round passed", () => {
  const apps = [app({ jobId: "f", company: "Foo", status: "interview" })];
  const events: ScoreEvent[] = [
    ev("f", "2026-11-04T15:00:00Z", "status", "interview"),
    ev("f", "2026-11-11T15:00:00Z", "interview_scheduled", { date: "2026-11-12T14:00" }),
  ];
  assert.deepEqual(convo(apps, events), [["2026-11-12", true, true, 1, false]], "the status change attaches to the booking");
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-13T15:00:00Z"));
  assert.deepEqual([s.totals.firstConversations, s.totals.pastFirstScreen], [1, 0]);
});

test("S: a booked next round is not a round passed before (or after) it happens", () => {
  const apps = [app({ jobId: "r", company: "Soylent", status: "interview" })];
  const events: ScoreEvent[] = [
    ev("r", "2026-11-04T15:00:00Z", "interview", { date: "2026-11-04T10:00" }),
    ev("r", "2026-11-05T15:00:00Z", "interview_scheduled", { date: "2026-11-20T10:00" }),
  ];
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-17T15:00:00Z"));
  assert.deepEqual([s.weeks.map(w => w.roundsPassed), s.totals.pastFirstScreen, s.upcoming.map(c => c.date)], [[0, 0, 0], 0, ["2026-11-20"]]);
  const held = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-21T15:00:00Z"));
  assert.deepEqual([held.totals.pastFirstScreen, held.totals.possibleRounds], [0, 1]);
});

test("Hooli today: events 665 and 902 (both Nov 6 10:00) and the status change are one first conversation booked, zero rounds", () => {
  const apps = [app({ jobId: "history:hooli:solutions-architect", company: "Hooli", title: "Solutions Architect", status: "interview", submittedAt: "2026-10-11" })];
  const j = apps[0].jobId;
  const events: ScoreEvent[] = [
    ev(j, "2026-11-03T03:06:13.868Z", "status", "interview"),
    ev(j, "2026-11-03T03:06:13.868Z", "interview", { summary: "2026-11-06T10:00: Interview with Hooli | Solutions Architect", date: "2026-11-06T10:00", source_id: "msg-0001" }),
    ev(j, "2026-11-03T12:15:23.024Z", "interview", { summary: "2026-11-06T10:00: Invitation: Interview with Hooli", date: "2026-11-06T10:00", source_id: "mail:calendar-0001", mail_date: "2026-10-13", date_source: "invite" }),
  ];
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-03T13:00:00Z"));
  assert.deepEqual(convo(apps, events), [["2026-11-06", true, true, 1, false]]);
  assert.deepEqual([s.week.firstConversations, s.week.firstConversationsBooked, s.week.roundsPassed, s.week.possibleRounds], [1, 1, 0, 0]);
  assert.deepEqual([s.totals.firstConversations, s.totals.pastFirstScreen, s.totals.possibleRounds], [0, 0, 0]);
  assert.deepEqual(s.upcoming.map(c => [c.company, c.date]), [["Hooli", "2026-11-06"]]);
  assert.equal(s.companies.find(c => c.company === "Hooli")!.nextAction, "Prepare for the conversation on 2026-11-06.");
});

test("H1: status set to interview when the invite came, then a booking for later that week: one conversation, no round", () => {
  const apps = [app({ jobId: "s", company: "Wonka", status: "interview", submittedAt: "2026-11-03T15:00:00Z" })];
  const events: ScoreEvent[] = [ev("s", "2026-11-04T15:00:00Z", "status", "interview"), ev("s", "2026-11-05T15:00:00Z", "interview_scheduled", { date: "2026-11-07T10:00" })];
  assert.deepEqual(convo(apps, events), [["2026-11-07", true, true, 1, false]]);
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-08T15:00:00Z"));
  assert.deepEqual([s.totals.pastFirstScreen, s.weeks[0].roundsPassed, s.weeks[0].firstConversations], [0, 0, 1]);
});

test("R2-1: Hooli round 2 booked for Mon Nov 9 (logged Nov 7) never swallows the held Fri Nov 6 screen", () => {
  const apps = [app({ jobId: "t", company: "Hooli", title: "Solutions Architect", status: "interview", submittedAt: "2026-10-11" })];
  const live: ScoreEvent[] = [
    ev("t", "2026-11-03T03:06:13Z", "status", "interview"),
    ev("t", "2026-11-03T03:06:13Z", "interview", { date: "2026-11-06T10:00", source_id: "a" }),
    ev("t", "2026-11-03T12:15:23Z", "interview", { date: "2026-11-06T10:00", source_id: "b", date_source: "invite" }),
  ];
  const r2 = ev("t", "2026-11-07T15:00:00Z", "interview_scheduled", { date: "2026-11-09T14:00", round: 2 });
  const events = [...live, r2];
  assert.deepEqual(convo(apps, events, "2026-11-08"), [["2026-11-06", true, true, 1, false], ["2026-11-09", true, false, 2, false]]);
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-08T15:00:00Z"));
  assert.deepEqual([s.weeks[0].firstConversations, s.weeks[0].firstConversationsBooked, s.weeks[0].roundsPassed], [1, 0, 1]);
  assert.deepEqual([s.gate.progress.firstConversations.actual, s.gate.progress.pastFirstScreen.actual, s.gate.note ?? null], [1, 1, null]);
  assert.deepEqual(s.upcoming.map(c => [c.date, c.round]), [["2026-11-09", 2]]);
  assert.match(sb.scoreboardText(s), /2026-11-09  Hooli · Solutions Architect \(round 2\)/);
  const later = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-10T15:00:00Z"));
  assert.deepEqual(later.weeks.map(w => [w.firstConversations, w.roundsPassed, w.possibleRounds]), [[1, 1, 0], [0, 0, 0]], "round 2 is never a first conversation");
  // a reminder dated between them joins only its nearest conversation and links nothing
  const reminder = ev("t", "2026-11-08T12:00:00Z", "interview", { date: "2026-11-08T14:00", source_id: "c", date_source: "invite" });
  assert.equal(convo(apps, [...events, reminder]).length, 2);
  // round 2 noted again with a new date far away is the same round-2 conversation, moved
  const moved = ev("t", "2026-11-08T15:00:00Z", "interview", { date: "2026-11-20T14:00", round: 2 });
  assert.deepEqual(convo(apps, [...events, moved]), [["2026-11-06", true, true, 1, false], ["2026-11-20", true, false, 2, false]]);
  // a round 2 marker with no date: one conversation, round 1, still one round passed
  const bare = [...live, ev("t", "2026-11-07T15:00:00Z", "interview_scheduled", { round: 2 })];
  const b = sb.computeScoreboard(input({ applications: apps, events: bare }), cfg, at("2026-11-08T15:00:00Z"));
  assert.deepEqual([convo(apps, bare), b.weeks[0].firstConversations, b.weeks[0].roundsPassed], [[["2026-11-06", true, true, 1, false]], 1, 1]);
});

test("R3-A: an unmarked sweep invite logged after the held screen never swallows it, with or without a round marker", () => {
  const apps = [app({ jobId: "t", company: "Hooli", title: "Solutions Architect", status: "interview", submittedAt: "2026-10-11" })];
  const live: ScoreEvent[] = [
    ev("t", "2026-11-03T03:06:13Z", "status", "interview"),
    ev("t", "2026-11-03T03:06:13Z", "interview", { date: "2026-11-06T10:00", source_id: "a" }),
    ev("t", "2026-11-03T12:15:23Z", "interview", { date: "2026-11-06T10:00", source_id: "b", date_source: "invite" }),
  ];
  const sweep = ev("t", "2026-11-07T12:15:00Z", "interview", { date: "2026-11-09T14:00", source_id: "mail:r2", date_source: "invite", mail_date: "2026-11-07" });
  const dated = ev("t", "2026-11-07T16:00:00Z", "interview", { date: "2026-11-09T14:00", round: 2 });
  const bare = ev("t", "2026-11-07T16:00:00Z", "interview", { round: 2 });
  const cases: Array<[string, ScoreEvent[], number | null, boolean]> = [
    ["A: dated marker after the invite", [...live, sweep, dated], 2, true],
    ["A2: undated marker after the invite", [...live, sweep, bare], null, true],
    ["A3: marker before the invite", [...live, { ...dated, at: "2026-11-07T11:00:00Z" }, sweep], 2, true],
    ["A4: no marker", [...live, sweep], null, false],
  ];
  for (const [name, events, round2, marked] of cases) {
    assert.deepEqual(convo(apps, events, "2026-11-10"), [["2026-11-06", true, true, 1, false], ["2026-11-09", true, false, round2, !marked]], name);
    const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-10T15:00:00Z"));
    assert.deepEqual(s.weeks.map(w => [w.firstConversations, w.firstConversationsBooked, w.roundsPassed, w.possibleRounds]),
      [[1, 0, marked ? 1 : 0, 0], [0, 0, 0, marked ? 0 : 1]], `${name}: Nov 6 held in week 1; Nov 9 a round passed only with a marker`);
    assert.equal(s.totals.firstConversations, 1, name);
  }
});

test("R3-B: an unmarked invite moving an unheld screen more than 3 days is a separate conversation (known limit) unless it names rescheduled_from", () => {
  const apps = [app({ jobId: "t", company: "Hooli", title: "Solutions Architect", status: "interview", submittedAt: "2026-10-11" })];
  const screen = ev("t", "2026-11-03T12:15:23Z", "interview", { date: "2026-11-06T10:00", source_id: "b", date_source: "invite" });
  const moved = { date: "2026-11-12T10:00", source_id: "m2", date_source: "invite" };
  const plain = [screen, ev("t", "2026-11-05T12:00:00Z", "interview", moved)];
  assert.deepEqual(convo(apps, plain, "2026-11-05").map(c => c[0]), ["2026-11-06", "2026-11-12"], "both listed; the scoreboard cannot tell a move from a booked next round");
  const named = [screen, ev("t", "2026-11-05T12:00:00Z", "interview", { ...moved, rescheduled_from: "2026-11-06T10:00" })];
  assert.deepEqual(convo(apps, named, "2026-11-05"), [["2026-11-12", true, true, 1, false]]);
  assert.equal(sb.computeScoreboard(input({ applications: apps, events: named }), cfg, at("2026-11-05T15:00:00Z")).companies.find(c => c.company === "Hooli")!.nextAction,
    "Prepare for the conversation on 2026-11-12.");
});

test("R2-2: an offer alone is never a round passed, even set twice", () => {
  const apps = [app({ jobId: "o", company: "Soylent", status: "offer" })];
  const events: ScoreEvent[] = [
    ev("o", "2026-11-03T15:00:00Z", "interview", { date: "2026-11-03T10:00" }),
    ev("o", "2026-11-04T15:00:00Z", "status", "offer"),
    ev("o", "2026-11-05T15:00:00Z", "status", "interview"),
    ev("o", "2026-11-06T15:00:00Z", "status", "offer"),
  ];
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-08T15:00:00Z"));
  assert.deepEqual([s.weeks[0].roundsPassed, s.totals.pastFirstScreen, s.totals.firstConversations], [0, 0, 1]);
  assert.equal(s.gate.note, cfg.gate.noRoundPassed, "log the rounds with log_event (JSON round: N) to clear it");
});

test("R2-5: a dateless manual event is a notice: it attaches to the booking that follows instead of a second conversation", () => {
  const apps = [app({ jobId: "t", company: "Hooli", status: "interview" })];
  const text = ev("t", "2026-11-03T15:00:00Z", "interview_scheduled", "Screen with Brett Fri Nov 10");
  const invite = ev("t", "2026-11-05T15:00:00Z", "interview", { date: "2026-11-10T10:00", source_id: "i", date_source: "invite" });
  assert.deepEqual(convo(apps, [text]), [["2026-11-03", false, true, 1, false]], "until a date comes: one undated in-process conversation");
  assert.deepEqual(convo(apps, [text, invite]), [["2026-11-10", true, true, 1, false]]);
  const mailNoDate = ev("t", "2026-11-03T15:00:00Z", "interview", { summary: "process active", date_source: "mail" });
  assert.deepEqual(convo(apps, [mailNoDate, invite]), [["2026-11-10", true, true, 1, false]]);
  const s = sb.computeScoreboard(input({ applications: apps, events: [text, invite] }), cfg, at("2026-11-06T15:00:00Z"));
  assert.deepEqual([s.totals.firstConversations, s.weeks[0].firstConversations, s.upcoming.map(c => c.date)], [0, 0, ["2026-11-10"]]);
});

test("H2: a status change logged a week after the screen does not start a second conversation", () => {
  const apps = [app({ jobId: "s", company: "Wonka", status: "interview", submittedAt: "2026-11-03T15:00:00Z" })];
  const events: ScoreEvent[] = [ev("s", "2026-11-03T15:00:00Z", "interview_scheduled", { date: "2026-11-06T10:00" }), ev("s", "2026-11-14T15:00:00Z", "status", "interview")];
  assert.deepEqual(convo(apps, events), [["2026-11-06", true, true, 1, false]]);
  assert.equal(sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-15T15:00:00Z")).totals.pastFirstScreen, 0);
});

test("H3: a missed screen rescheduled after its date is the same conversation", () => {
  const apps = [app({ jobId: "t", company: "Hooli", status: "interview" })];
  const events: ScoreEvent[] = [ev("t", "2026-11-03T03:00:00Z", "interview", { date: "2026-11-06T10:00" }), ev("t", "2026-11-07T15:00:00Z", "interview_rescheduled", { date: "2026-11-10T10:00" })];
  assert.deepEqual(convo(apps, events), [["2026-11-10", true, true, 1, false]]);
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-11T15:00:00Z"));
  assert.deepEqual([s.totals.pastFirstScreen, s.totals.firstConversations, s.totals.possibleRounds], [0, 1, 0]);
});

test("H4: two bookings logged the same day: one first conversation, both upcoming, the next action names the earliest", () => {
  const apps = [app({ jobId: "a", company: "Tyrell", status: "interview" })];
  const events: ScoreEvent[] = [
    ev("a", "2026-11-03T15:00:00Z", "interview_scheduled", { date: "2026-11-05T10:00" }),
    ev("a", "2026-11-03T15:05:00Z", "interview_scheduled", { date: "2026-11-19T10:00" }),
  ];
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-04T15:00:00Z"));
  assert.deepEqual([s.weeks[0].firstConversations, s.upcoming.map(c => c.date)], [1, ["2026-11-05", "2026-11-19"]]);
  assert.equal(s.companies.find(c => c.company === "Tyrell")!.nextAction, "Prepare for the conversation on 2026-11-05.");
  const later = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-20T15:00:00Z"));
  assert.deepEqual([later.totals.firstConversations, later.totals.pastFirstScreen, later.totals.possibleRounds], [1, 0, 1]);
});

test("H5: a chain of sweep mails every 3 to 5 days is one conversation, no rounds", () => {
  const apps = [app({ jobId: "x", company: "Soylent", status: "interview" })];
  const events = ["2026-11-03", "2026-11-06", "2026-11-11", "2026-11-16", "2026-11-20"].map(d => bridgeMail("x", d));
  assert.deepEqual(convo(apps, events), [["2026-11-03", false, true, 1, false]]);
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-21T15:00:00Z"));
  assert.deepEqual([s.totals.pastFirstScreen, s.totals.possibleRounds, s.gate.note], [0, 0, cfg.gate.noRoundPassed]);
});

test("H15: an explicit round 2 and its reminders count one round passed, once, in the week it was logged", () => {
  const apps = [app({ jobId: "r", company: "Soylent", status: "interview" })];
  const events: ScoreEvent[] = [
    ev("r", "2026-11-03T15:00:00Z", "interview", { date: "2026-11-04T10:00" }),
    ev("r", "2026-11-05T15:00:00Z", "interview", { date: "2026-11-06", round: 2 }),
    ev("r", "2026-11-06T12:00:00Z", "interview", { date: "2026-11-06" }),
    ev("r", "2026-11-06T12:00:00Z", "interview", { date: "2026-11-06", round: 2 }),
  ];
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-10T15:00:00Z"));
  assert.deepEqual([s.weeks[0].roundsPassed, s.weeks[1].roundsPassed, s.totals.pastFirstScreen], [1, 0, 1]);
  // a round marker with no date (log_event JSON round: 3 when round 3 is booked) adds one more, in its week
  const r3 = sb.computeScoreboard(input({ applications: apps, events: [...events, ev("r", "2026-11-12T15:00:00Z", "interview_scheduled", { round: 3 })] }), cfg, at("2026-11-13T15:00:00Z"));
  assert.deepEqual([r3.weeks[0].roundsPassed, r3.weeks[1].roundsPassed, r3.totals.pastFirstScreen], [1, 1, 1]);
  assert.deepEqual(convo(apps, events), [["2026-11-04", true, true, 1, false], ["2026-11-06", true, false, 2, false]],
    "the round 2 booking keeps its own conversation; the held Nov 4 screen stays round 1");
});

test("H16: a screen moved earlier is one conversation on the new date; once held it is no longer upcoming", () => {
  const apps = [app({ jobId: "s", company: "Soylent", title: "FDE", status: "interview" })];
  const events: ScoreEvent[] = [
    ev("s", "2026-11-03T15:00:00Z", "interview_scheduled", { date: "2026-11-10T10:00" }),
    ev("s", "2026-11-04T15:00:00Z", "interview_rescheduled", { date: "2026-11-06T10:00" }),
  ];
  const s = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-05T15:00:00Z"));
  assert.deepEqual([convo(apps, events), s.upcoming.map(c => c.date)], [[["2026-11-06", true, true, 1, false]], ["2026-11-06"]]);
  assert.equal(s.companies.find(c => c.company === "Soylent")!.nextAction, "Prepare for the conversation on 2026-11-06.");
  const s2 = sb.computeScoreboard(input({ applications: apps, events }), cfg, at("2026-11-07T15:00:00Z"));
  assert.deepEqual([s2.upcoming, s2.weeks[0].firstConversations, s2.weeks[0].firstConversationsBooked, s2.totals.firstConversations], [[], 1, 0, 1]);
});

test("H6, H7, H8: halving threshold never above the companies listed, 0 stays 0, and the week-1 decision never changes later", () => {
  const two = parseStrategy({ ...JSON.parse(readFileSync(EXAMPLE_FILE, "utf8")), companies: cfg.companies.slice(0, 2) }).config;
  const both = [app({ jobId: "1", company: "Hooli", submittedAt: "2026-11-03T15:00:00Z" }), app({ jobId: "2", company: "Wonka", submittedAt: "2026-11-03T15:00:00Z" })];
  const h6 = sb.computeScoreboard(input({ applications: both }), two, at("2026-11-10T15:00:00Z"));
  assert.deepEqual([h6.halving, h6.weeks[1].targets], [{ threshold: 2, submittedByWeek1: 2, decided: true, halved: false }, { warmAsks: 4, applications: 5 }]);
  const zero = { ...cfg, weeklyTargets: { warmAsks: 0, applications: 5 } };
  assert.deepEqual(sb.computeScoreboard(input({}), zero, at("2026-11-10T15:00:00Z")).weeks.map(w => w.targets), [{ warmAsks: 0, applications: 5 }, { warmAsks: 0, applications: 3 }]);
  const apps = [app({ jobId: "1", company: "Hooli", submittedAt: "2026-11-03T15:00:00Z" }), app({ jobId: "2", company: "Soylent", submittedAt: "2026-11-04T15:00:00Z" })];
  const before = sb.computeScoreboard(input({ applications: apps }), cfg, at("2026-11-20T15:00:00Z"));
  const after = sb.computeScoreboard(input({ applications: [...apps, app({ jobId: "3", company: "Wonka", status: "interview" })],
    events: [ev("3", "2026-11-19T15:00:00Z", "status", "interview")] }), cfg, at("2026-11-20T15:00:00Z"));
  assert.deepEqual([before.halving.submittedByWeek1, before.halving.halved, after.halving.submittedByWeek1, after.halving.halved], [2, true, 2, true]);
  assert.deepEqual(after.weeks[1].targets, { warmAsks: 2, applications: 3 });
  // no submittedAt, but its status moved to submitted in week 1: it counts
  const early = sb.computeScoreboard(input({ applications: [...apps, app({ jobId: "3", company: "Wonka", status: "interview" })],
    events: [ev("3", "2026-11-05T15:00:00Z", "status", "submitted"), ev("3", "2026-11-19T15:00:00Z", "status", "interview")] }), cfg, at("2026-11-20T15:00:00Z"));
  assert.deepEqual([early.halving.submittedByWeek1, early.halving.halved], [3, false]);
  // a week-1 submit date logged in week 3 (offsite, recorded late) never reaches back: the decision stays
  const late = [...apps, app({ jobId: "3", company: "Wonka", submittedAt: "2026-11-05T15:00:00Z" })];
  const viaEvent = sb.computeScoreboard(input({ applications: late, events: [ev("3", "2026-11-18T15:00:00Z", "status", "submitted")] }), cfg, at("2026-11-20T15:00:00Z"));
  const viaLoader = sb.computeScoreboard(input({ applications: [...apps, { ...late[2], recordedAt: "2026-11-18T15:00:00Z" }] }), cfg, at("2026-11-20T15:00:00Z"));
  assert.deepEqual([viaEvent.halving.submittedByWeek1, viaEvent.halving.halved, viaLoader.halving.halved, viaEvent.weeks[1].targets.applications], [2, true, true, 3]);
  const onTime = sb.computeScoreboard(input({ applications: [...apps, { ...late[2], recordedAt: "2026-11-05T15:00:00Z" }] }), cfg, at("2026-11-20T15:00:00Z"));
  assert.equal(onTime.halving.halved, false, "recorded in week 1: counts");
  // the end of week 1 is Sunday midnight New York time
  const three = (t: string) => ["Hooli", "Wonka", "Soylent"].map((c, i) => app({ jobId: `b${i}`, company: c, submittedAt: t }));
  assert.equal(sb.computeScoreboard(input({ applications: three("2026-11-09T04:30:00Z") }), cfg, at("2026-11-10T15:00:00Z")).halving.halved, false, "Sun 23:30 ET");
  assert.equal(sb.computeScoreboard(input({ applications: three("2026-11-09T05:30:00Z") }), cfg, at("2026-11-10T15:00:00Z")).halving.halved, true, "Mon 00:30 ET");
});

test("H9, H10: closed-row send credit goes to the row sent at that time, and a row with no send event takes none", () => {
  const A = out({ company: "Vandelay", person: "Jamie Rowe", status: "closed", jobId: "c", sentAt: "2026-11-03T16:00:00Z" });
  const B = out({ company: "Vandelay", person: "Jamie Rowe", status: "closed", jobId: "c", sentAt: "2026-11-12T16:00:00Z" });
  const events: ScoreEvent[] = [
    ev("c", "2026-11-03T15:00:00Z", "outreach", "draft ready: linkedin to Jamie Rowe at Vandelay"),
    ev("c", "2026-11-03T16:00:00.002Z", "outreach", "linkedin to Jamie Rowe at Vandelay"),
    ev("c", "2026-11-12T16:00:00Z", "outreach", "draft ready: linkedin to Jamie Rowe at Vandelay"),
  ];
  assert.deepEqual([sb.outreachSent(A, events, [A, B]), sb.outreachSent(B, events, [A, B])], [true, false]);
  const s = sb.computeScoreboard(input({ applications: [app({ jobId: "c", company: "Vandelay", submittedAt: "2026-11-03T14:00:00Z" })], outreach: [A, B], events }), cfg, at("2026-11-13T15:00:00Z"));
  assert.deepEqual([s.weeks[0].warmAsks, s.weeks[1].warmAsks, s.personFlags], [1, 0, []]);
  const R = out({ company: "Vandelay", person: "Jamie Rowe", status: "replied", jobId: "c", sentAt: "2026-11-12T16:00:00Z" }); // draft moved straight to replied
  assert.equal(sb.outreachSent(A, [events[1]], [A, R]), true, "the replied row has no send event of its own and takes none");
});

test("gate totals stop at the gate date", () => {
  const s = sb.computeScoreboard(input({
    outreach: [out({ company: "A", person: "One", sentAt: "2026-12-01T15:00:00Z" }), out({ company: "B", person: "Two", sentAt: "2026-12-10T15:00:00Z" })],
    applications: [app({ jobId: "z", company: "Z", submittedAt: "2026-12-10T15:00:00Z" })],
  }), cfg, new Date("2026-12-12T15:00:00Z"));
  assert.deepEqual([s.gate.progress.warmAsks.actual, s.gate.progress.applications.actual], [1, 0]);
});

test("48-hour rule: flags live applications with nobody contacted in time, with hours elapsed", () => {
  const s = sb.computeScoreboard(input({
    applications: [
      app({ jobId: "due", company: "Kelp", submittedAt: "2026-11-02" }),                       // logged 22:59 ET: 8 h, 40 h left
      app({ jobId: "ok", company: "Soylent", submittedAt: "2026-11-02T14:00:00Z" }),                 // asked the day before
      app({ jobId: "late", company: "Zeta", submittedAt: "2026-10-30T14:00:00Z" }),               // before the rule, not watched
      app({ jobId: "bench", company: "Vandelay", submittedAt: "2026-10-21T21:50:54Z" }),            // bench: watched whatever the date
      app({ jobId: "benchold", company: "Vandelay", submittedAt: "2026-08-23", source: "history" }), // imported history: not watched
      app({ jobId: "slow", company: "Umbrella Inc", submittedAt: "2026-10-21T21:52:18Z" }),         // note went out after 48 h
      app({ jobId: "int", company: "Hooli", status: "interview", submittedAt: "2026-11-02" }),    // already in conversation
      app({ jobId: "rej", company: "Gone", status: "rejected", submittedAt: "2026-11-02" }),
    ],
    outreach: [
      out({ company: "Soylent", person: "Dana", sentAt: "2026-11-01T14:00:00Z" }),
      out({ company: "Umbrella", person: "Morgan Hale", sentAt: "2026-10-25T14:00:00Z" }),
      out({ company: "Vandelay", person: "Jamie Rowe", status: "draft", lastTouchAt: "2026-11-03T05:00:00Z" }),
      out({ company: "Vandelay", person: "Old Contact", status: "no_reply", sentAt: "2026-07-01T14:00:00Z" }), // too old to count
      out({ company: "Vandelay", person: "Held Draft", status: "draft", lastTouchAt: "2026-11-03T06:00:00Z", notes: "QA: HOLD: warm path first" }),
    ],
    events: [{ jobId: "due", at: "2026-11-03T02:59:50.803Z", kind: "submitted", detail: "LinkedIn Easy Apply 2026-11-02" }],
  }), cfg, NOW);
  assert.deepEqual(s.personFlags.map(f => [f.company, f.state]), [["Kelp", "due"], ["Vandelay", "overdue"], ["Umbrella Inc", "sent_late"]]);
  const [due, over, slow] = s.personFlags;
  assert.equal(due.hoursElapsed, 8, "a plain date starts the clock when the submission was logged that day");
  assert.equal(due.hoursLeft, 40);
  assert.equal(over.hoursElapsed, 301);
  assert.equal(over.draft?.person, "Jamie Rowe", "the ready draft is named, never the HOLD one");
  const noLog = sb.computeScoreboard(input({ applications: [app({ jobId: "d", company: "Kelp", submittedAt: "2026-11-02" })] }), cfg, NOW);
  assert.deepEqual([noLog.personFlags[0].hoursElapsed, noLog.personFlags[0].hoursLeft], [6, 42], "no log: the end of that day");
  assert.equal(slow.sentLate?.person, "Morgan Hale");
});

test("the five: applied, asked, person named, last touch and the next action", () => {
  const s = sb.computeScoreboard(input({
    applications: [
      app({ jobId: "t", company: "Hooli", status: "interview", submittedAt: "2026-10-11" }),
      app({ jobId: "si", company: "Wonka", status: "drafted" }),
      app({ jobId: "so", company: "Soylent", submittedAt: "2026-11-02T20:00:00Z" }),
      app({ jobId: "au", company: "Oscorp", submittedAt: "2026-11-02T20:00:00Z" }),
      app({ jobId: "ax", company: "Tyrell", status: "drafted", title: "Solutions Engineer" }),
    ],
    events: [{ jobId: "t", at: "2026-11-03T03:06:13Z", kind: "interview", detail: JSON.stringify({ date: "2026-11-06T10:00" }) }],
    outreach: [
      out({ company: "Wonka", person: "Avery Dunn", role: "Strategist", sentAt: "2026-11-02T13:00:00Z" }),
      out({ company: "Soylent", person: "David Fullerton", status: "draft" }),
      out({ company: "Oscorp", person: "Robin Vale", sentAt: "2026-11-02T21:00:00Z" }),
      out({ company: "Tyrell", person: "Alex Tran", status: "draft", notes: "HOLD, do not send this connect note" }),
    ],
  }), cfg, NOW);
  const by = Object.fromEntries(s.companies.map(c => [c.company, c]));
  assert.deepEqual(s.companies.map(c => c.company), ["Hooli", "Wonka", "Soylent", "Tyrell", "Oscorp"]);
  assert.equal(by.Hooli.nextAction, "Prepare for the conversation on 2026-11-06.");
  assert.equal(by.Hooli.applied, true);
  assert.equal(by.Hooli.inProcess, true);
  assert.equal(by.Hooli.lastTouch, "2026-11-03T03:06:13Z", "the interview booking is a touch");
  assert.deepEqual([by.Wonka.applied, by.Wonka.asked, by.Wonka.personNamed?.person, by.Wonka.personNamed?.sent], [false, true, "Avery Dunn", true]);
  assert.equal(by.Wonka.nextAction, "Apply: the pack is drafted.");
  assert.equal(by.Wonka.lastTouch, "2026-11-02T13:00:00Z");
  assert.equal(by.Soylent.nextAction, "Send the note to David Fullerton (48-hour rule).");
  assert.equal(by.Soylent.personNamed?.sent, false);
  assert.equal(by.Tyrell.nextAction, "Decide the Jo ask; apply the same day either way.", "no send, no application: the strategy's first move, never the HOLD draft");
  assert.deepEqual(by.Tyrell.personNamed && [by.Tyrell.personNamed.person, by.Tyrell.personNamed.onHold], ["Alex Tran", true]);
  assert.equal(by.Tyrell.applicationTitle, "Solutions Engineer", "the status pill says which role it comes from");
  assert.equal(by.Tyrell.lastTouch, undefined);
  assert.equal(by.Wonka.inProcess, false);
  assert.equal(by.Oscorp.nextAction, "Wait for a reply (no chase).");
  assert.equal(by.Oscorp.lastTouch, "2026-11-02T21:00:00Z");
  assert.ok(by.Wonka.path?.includes("Avery Dunn"), "the strategy's path rides along");
});

test("live processes and the Dec 3 gate: recent interview or offer activity only; hold at 3", () => {
  const apps = ["a", "b", "c", "old"].map(id => app({ jobId: id, company: id.toUpperCase(), status: "interview" }));
  const events: ScoreEvent[] = [
    { jobId: "a", at: "2026-11-01T15:00:00Z", kind: "status", detail: "interview" },
    { jobId: "b", at: "2026-10-20T15:00:00Z", kind: "note", detail: "prep" },
    { jobId: "old", at: "2026-09-01T15:00:00Z", kind: "status", detail: "interview" }, // over 30 days quiet
  ];
  const two = sb.computeScoreboard(input({ applications: apps, events }), cfg, NOW);
  assert.deepEqual(two.liveProcesses.map(p => p.company), ["A", "B"], "C has no activity at all (history only)");
  assert.deepEqual([two.gate.verdict, two.gate.reached, two.gate.daysLeft], ["widen", false, 30]);
  assert.equal(two.gate.progress.applications.target, 20);
  const three = sb.computeScoreboard(input({ applications: apps, events: [...events, { jobId: "c", at: "2026-11-02T15:00:00Z", kind: "offer" }] }), cfg, NOW);
  assert.equal(three.gate.verdict, "hold");
  assert.equal(three.gate.action, cfg.gate.hold);
});

test("milestones count down in local days; past ones say so", () => {
  const s = sb.computeScoreboard(input({}), cfg, new Date("2026-11-06T04:30:00Z")); // Thu Nov 5, 23:30 ET
  assert.equal(s.today, "2026-11-05");
  const m = Object.fromEntries(s.milestones.map(x => [x.date, x]));
  assert.deepEqual([m["2026-11-05"].state, m["2026-11-05"].daysLeft], ["today", 0]);
  assert.equal(m["2026-11-06"].daysLeft, 1);
  assert.equal(m["2026-12-03"].gate, true);
  assert.equal(m["2027-01-15"].daysLeft, 71);
  assert.ok(!JSON.stringify(cfg).includes("\u2014"), "no em dashes in the defaults");
});

test("follow-ups due: only sent messages quiet for a week, with the day they fell due and the row's notes; none at a no-chase company", () => {
  const base = out({ company: "Globex Ai", person: "Riley Park", sentAt: "2026-10-14T20:03:28Z", notes: "Once connected, send the longer note" });
  const s = sb.computeScoreboard(input({ followUps: [
    { ...base, kind: "follow_up", daysSinceTouch: 19, suggestion: "Follow-up 1" },
    { ...out({ company: "Oscorp", person: "Robin Vale", sentAt: "2026-10-14T20:03:28Z" }), kind: "follow_up", daysSinceTouch: 19, suggestion: "Follow-up 1" },
    { ...out({ company: "X", person: "Draft", status: "draft" }), kind: "send_or_close", daysSinceTouch: 3, suggestion: "send" },
  ] }), cfg, NOW);
  assert.deepEqual(s.followUpsDue.map(f => [f.person, f.daysSinceTouch, f.dueSince]), [["Riley Park", 19, "2026-10-21"]]);
  assert.equal(s.followUpsDue[0].notes, "Once connected, send the longer note");
});

test("strategy.json: reading never writes it; --init-config writes it once and never overwrites", () => {
  const path = strategyPath();
  assert.equal(existsSync(path), false);
  const missing = loadStrategy();
  assert.deepEqual([missing.config, missing.exists], [STRATEGY_DEFAULTS, false]);
  assert.match(missing.warnings[0], /--init-config/);
  assert.equal(existsSync(path), false, "a read leaves no file behind");
  assert.equal(sb.strategyScoreboard().configExists, false);
  assert.equal(existsSync(path), false, "the scoreboard leaves no file behind");
  const bad = join(process.env.OPENAPPLY_HOME!, "bad.json");
  writeFileSync(bad, JSON.stringify({ gate: { date: "Dec 3" } }));
  assert.throws(() => initStrategy(bad), /gate\.date/);
  assert.equal(existsSync(path), false, "a file with problems is not written");
  initStrategy(EXAMPLE_FILE);
  assert.deepEqual(loadStrategy(), { config: cfg, path, exists: true, warnings: [] });
  assert.throws(() => initStrategy(), /already exists/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), JSON.parse(readFileSync(EXAMPLE_FILE, "utf8")), "not overwritten");
});

test("strategy.json: partial nested edits merge over the defaults; bad values fall back with a warning; a broken file falls back", () => {
  const path = strategyPath();
  const original = readFileSync(path, "utf8");
  try {
    writeFileSync(path, JSON.stringify({ weeklyTargets: { warmAsks: 6 } }));
    const w = loadStrategy();
    assert.deepEqual(w.config.weeklyTargets, { warmAsks: 6, applications: 5 });
    assert.deepEqual(w.warnings, []);
    writeFileSync(path, JSON.stringify({ gate: { date: "2026-12-10", holdAtLiveProcesses: 2 } }));
    const g = loadStrategy().config;
    assert.deepEqual([g.gate.date, g.gate.holdAtLiveProcesses, g.gate.targets], ["2026-12-10", 2, STRATEGY_DEFAULTS.gate.targets]);
    assert.equal(sb.computeScoreboard(input({}), g, NOW).gate.progress.firstConversations.target, 6, "no crash");
    writeFileSync(path, JSON.stringify({ timeZone: "Mars/Olympus", weeklyTargets: { applications: "five" }, milestones: [{ date: "soon" }] }));
    const v = loadStrategy();
    assert.deepEqual([v.config.timeZone, v.config.weeklyTargets.applications, v.config.milestones], ["America/New_York", 5, []]);
    assert.equal(v.warnings.length, 3);
    assert.match(v.warnings.join("\n"), /timeZone.*milestones.*weeklyTargets\.applications/s);
    writeFileSync(path, "{ not json");
    const broken = loadStrategy();
    assert.equal(broken.config, STRATEGY_DEFAULTS);
    assert.match(broken.warnings[0], /could not be read/);
    assert.equal(readFileSync(path, "utf8"), "{ not json", "a broken file is not overwritten");
  } finally {
    writeFileSync(path, original);
  }
});

test("strategyScoreboard reads the DB without writing: a used-up follow-up is not closed", async () => {
  const db = await import("../src/db.js");
  const o = await import("../src/outreach.js");
  db.upsertJobs([{ id: "ashby:soylent:1", ats: "ashby", boardSlug: "soylent", company: "Soylent", title: "Forward Deployed Engineer",
    location: "New York", remote: false, description: "d", url: "https://x/1", applyUrl: "https://x/1" }]);
  db.setApplication("ashby:soylent:1", { status: "submitted", submittedAt: new Date(Date.now() - 3 * 86400e3).toISOString() });
  const spent = o.logOutreach({ company: "Spent", person: "Max", channel: "email" });
  db.getDb().prepare("UPDATE outreach SET follow_ups = 3, last_touch_at = ? WHERE id = ?").run(new Date(Date.now() - 9 * 86400e3).toISOString(), spent.id);
  const quiet = o.logOutreach({ company: "Quiet", person: "Q", channel: "email" });
  db.getDb().prepare("UPDATE outreach SET last_touch_at = ? WHERE id = ?").run(new Date(Date.now() - 8 * 86400e3).toISOString(), quiet.id);
  const s = sb.strategyScoreboard();
  assert.equal(o.listOutreach({ company: "Spent" })[0].status, "sent", "read-only: not moved to no_reply");
  assert.deepEqual(s.followUpsDue.map(f => f.person), ["Q"]);
  assert.ok(s.personFlags.some(f => f.company === "Soylent" && f.state === "overdue"));
  assert.ok(s.configPath.endsWith("strategy.json"));
  assert.equal(s.configExists, true);
  assert.match(sb.scoreboardText(s), /48-hour rule \(1 flagged\)/);
  const rec = sb.loadScoreboardInput(loadStrategy().config).applications.find(a => a.jobId === "ashby:soylent:1")!;
  assert.ok(rec.recordedAt && Date.now() - Date.parse(rec.recordedAt) < 60e3, "recordedAt is the submitted status row's time");
});

test("H12: impossible dates and a non-boolean noChase are refused with a warning", () => {
  const d = parseStrategy({ gate: { date: "2026-02-30" }, start: "2026-13-01", milestones: [{ date: "2026-11-31", title: "t", doneMeans: "d" }] });
  assert.deepEqual([d.config.gate.date, d.config.start, d.config.milestones], [STRATEGY_DEFAULTS.gate.date, STRATEGY_DEFAULTS.start, []]);
  assert.equal(d.warnings.length, 3);
  const n = parseStrategy({ companies: [{ company: "X", seat: "s", noChase: "false" }, { company: "Y", seat: "s", noChase: true }] });
  assert.deepEqual(n.config.companies.map(c => c.noChase), [undefined, true], "the string is ignored, the boolean kept");
  assert.match(n.warnings.join("\n"), /"X" noChase is "false"/);
  assert.equal(parseStrategy({ start: "2028-02-29" }).warnings.length, 0, "a real leap day passes");
  assert.equal(STRATEGY_DEFAULTS.companies.length, 0, "the defaults are not changed");
});
