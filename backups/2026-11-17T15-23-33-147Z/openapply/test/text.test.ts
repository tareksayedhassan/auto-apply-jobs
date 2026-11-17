import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, detectRemote, parseSalary, toIso } from "../src/text.js";

test("htmlToText strips tags, decodes entities, keeps paragraph breaks", () => {
  const t = htmlToText("<h2>About</h2><p>We&#39;re building &amp; shipping&nbsp;fast &mdash; join us.</p><ul><li>One</li><li>Two &lt;3</li></ul><br>Bye");
  assert.equal(t, "About\n\nWe're building & shipping fast - join us.\n\n- One\n- Two <3\n\nBye");
});

test("htmlToText handles numeric entities, scripts and empties", () => {
  assert.equal(htmlToText("<script>x()</script><p>caf&#xE9; &#8212; ok</p>"), "café — ok");
  assert.equal(htmlToText(""), "");
});

test("detectRemote", () => {
  assert.equal(detectRemote("Remote - US"), true);
  assert.equal(detectRemote("Anywhere"), true);
  assert.equal(detectRemote("New York, NY"), false);
  assert.equal(detectRemote("New York, NY (Hybrid)"), false);
  assert.equal(detectRemote("Berlin", "This is a fully remote role."), true);
  assert.equal(detectRemote("Berlin", "This role is not remote."), false);
});

test("parseSalary", () => {
  assert.deepEqual(parseSalary("Pay range: $150,000 - $190,000 per year"), { min: 150000, max: 190000, currency: "USD" });
  assert.deepEqual(parseSalary("$150K–$190K"), { min: 150000, max: 190000, currency: "USD" });
  assert.deepEqual(parseSalary("$150-190K"), { min: 150000, max: 190000, currency: "USD" });
  assert.deepEqual(parseSalary("USD 120k"), { min: 120000, currency: "USD" });
  assert.deepEqual(parseSalary("€70,000 to €90,000"), { min: 70000, max: 90000, currency: "EUR" });
  assert.equal(parseSalary("We raised $200 million in 2024"), undefined);
  assert.equal(parseSalary("$45 - $60 per hour"), undefined);
  assert.equal(parseSalary("competitive pay"), undefined);
});

test("toIso", () => {
  assert.equal(toIso("2026-10-05 16:05:18 UTC"), "2026-10-05T16:05:18.000Z");
  assert.equal(toIso("2026-10-08T21:47:32"), "2026-10-08T21:47:32.000Z");
  assert.equal(toIso(1791756036), "2026-10-11T22:00:36.000Z");
  assert.equal(toIso("not a date"), undefined);
});
