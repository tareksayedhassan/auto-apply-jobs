import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverLetterTex, texEsc } from "../src/render/cover-tex.js";
import { coverLetterHtml, letterParts } from "../src/render/cover.js";
import { texEngine, texToPdf } from "../src/pdf.js";
import type { Job, Profile } from "../src/types.js";

const profile = { firstName: "Jane", lastName: "Doe", email: "jane_doe@example.com", phone: "(212) 555-0142", location: "New York, NY",
  linkedin: "linkedin.com/in/jane-doe", website: "https://janedoe.dev/" } as Profile;
const job = { company: "Globex" } as Job;

test("texEsc escapes every LaTeX special character", () => {
  assert.equal(texEsc("50% & $300K #1 a_b ~x {y} 2^3 C:\\dir"),
    "50\\% \\& \\$300K \\#1 a\\_b \\textasciitilde{}x \\{y\\} 2\\textasciicircum{}3 C:\\textbackslash{}dir");
  assert.equal(texEsc("a < b > c | d"), "a \\textless{} b \\textgreater{} c \\textbar{} d");
  assert.equal(texEsc('the "agent" said'), "the \\textquotedblleft{}agent\\textquotedblright{} said");
  assert.equal(texEsc(undefined), "");
});

test("coverLetterTex fills the resume preamble with the header, date, paragraphs and signature", () => {
  const tex = coverLetterTex("Dear Globex,\n\nI cut costs 40% & saved $300K.\nSecond line.\n\nJane Doe", profile);
  assert.match(tex, /\\documentclass\[letterpaper,11pt\]\{article\}/);
  assert.match(tex, /\\usepackage\[empty\]\{fullpage\}/);
  assert.ok(tex.includes("{\\Huge\\scshape Jane Doe}"));
  assert.ok(tex.includes("\\href{mailto:jane_doe@example.com}{jane\\_doe@example.com} $\\cdot$ \\href{https://linkedin.com/in/jane-doe}{linkedin.com/in/jane-doe} $\\cdot$ \\href{https://janedoe.dev/}{janedoe.dev} $\\cdot$ (212) 555-0142 $\\cdot$ New York, NY"), tex);
  assert.ok(tex.includes("I cut costs 40\\% \\& saved \\$300K.\\newline\nSecond line."));
  assert.ok(tex.includes("Sincerely,\\newline\nJane Doe\n"), "closing goes above the name");
  assert.match(tex, new RegExp(new Date().getFullYear().toString()));
  assert.ok(!tex.includes("<<"), "every slot filled");
  assert.match(tex, /\\end\{document\}\s*$/);
});

test("a letter signed without a closing gets the closing above the name, in both renderers", () => {
  assert.deepEqual(letterParts("Hi.\n\nJane Doe\njanedoe.dev", profile).sig, ["Sincerely,", "Jane Doe", "janedoe.dev"]);
  assert.deepEqual(letterParts("Hi.\n\nBest,\nJane Doe", profile).sig, []);
  assert.deepEqual(letterParts("Hi.\n\nThanks,", profile).sig, ["Jane Doe"]);
  assert.deepEqual(letterParts("Hi.", profile).sig, ["Sincerely,", "Jane Doe"]);
  const html = coverLetterHtml("Hi.\n\nJane Doe", profile, job);
  assert.ok(html.indexOf("Sincerely,") < html.lastIndexOf("Jane Doe"), html);
});

test("quotes after ! or ? never form the inverted-mark ligatures, and backticks print as backticks", () => {
  assert.equal(texEsc('wow!"Next" why?"x"'), "wow!\\textquotedblleft{}Next\\textquotedblright{} why?\\textquotedblleft{}x\\textquotedblright{}");
  assert.equal(texEsc("run!`ls`"), "run!\\textasciigrave{}ls\\textasciigrave{}");
  assert.ok(!/[!?](``|`)/.test(texEsc('a!"b" c?`d`')));
});

test("smart quotes, dashes, ellipsis and bullets map to TeX; a glyph Latin Modern lacks refuses the build, naming it", () => {
  assert.equal(texEsc("\u2018a\u2019 \u201cb\u201d c\u2013d\u2014e\u2026 \u2022 f"),
    "\\textquoteleft{}a\\textquoteright{} \\textquotedblleft{}b\\textquotedblright{} c\\textendash{}d\\textemdash{}e\\ldots{} \\textbullet{} f");
  assert.doesNotThrow(() => coverLetterTex("Caf\u00e9 na\u00efve \u0141\u00f3d\u017a \u201cok\u201d", profile));
});

test("symbols Latin Modern has go to LaTeX, and decomposed accents are composed first", () => {
  const tex = coverLetterTex("Revenue to \u20ac2M\u2122 \u2020 \u2192 3\u2030 \u22122 at Cafe\u0301", profile);
  assert.ok(tex.includes("Revenue to \u20ac2M\u2122 \u2020 \u2192 3\u2030 \u22122 at Caf\u00e9"), tex);
});

test("a glyph Latin Modern lacks refuses the build, naming it", { skip: !texEngine() && "no TeX engine on this machine" }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), "oa-tex-")), "letter.pdf");
  await assert.rejects(texToPdf(coverLetterTex("Shipped \u2713 and \u{1F600} and \u4e2d", profile), out), /no glyph for .*U\+2713.*U\+1F600.*U\+4E2D/u);
  await texToPdf(coverLetterTex("Revenue to \u20ac2M\u2122 \u2020 \u2192 3\u2030 \u22122 at Cafe\u0301\n\nJane Doe", profile), out);
});

test("lines inside a paragraph break with \\newline, so a line starting with [ or * stays literal", () => {
  const tex = coverLetterTex("Done:\n[x] shipped\n* item\n\nJane Doe", profile);
  assert.ok(tex.includes("Done:\\newline\n[x] shipped\\newline\n* item"), tex);
  assert.ok(!/\\\\\s*[[*]/.test(tex), "no \\\\ before [ or *");
});

test("link targets keep & # % ~ _ as written; only TeX specials are escaped", () => {
  const tex = coverLetterTex("Hi.", { ...profile, linkedin: undefined, website: "https://e.com/p?a=1&b=2#f", github: "https://e.com/a%20b/~u_v$w x" } as Profile);
  assert.ok(tex.includes("\\href{https://e.com/p?a=1\\&b=2\\#f}{e.com/p?a=1\\&b=2\\#f}"), tex);
  assert.ok(tex.includes("\\href{https://e.com/a\\%20b/~u_v$w\\%20x}"), tex);
});

test("a link with a second # keeps everything after it, as %23", () => {
  const tex = coverLetterTex("Hi.", { ...profile, linkedin: undefined, website: "https://e.com/#/p#s", github: "e.com/~me/#a#b&c%" } as Profile);
  assert.ok(tex.includes("\\href{https://e.com/\\#/p\\%23s}"), tex);
  assert.ok(tex.includes("\\href{https://e.com/~me/\\#a\\%23b\\&c\\%}"), tex);
});

test("the last paragraph is the signature only when it is the name, or a sign-off line then the name", () => {
  const site = "Thanks for reading. More at janedoe.dev and doe.dev";
  assert.deepEqual(letterParts(`Hi.\n\n${site}`, profile), { ...letterParts(`Hi.\n\n${site}`, profile), paras: ["Hi.", site], sig: ["Sincerely,", "Jane Doe"] });
  assert.deepEqual(letterParts("Hi.\n\nDoe & Co hired me.", profile).sig, ["Sincerely,", "Jane Doe"]);
  assert.deepEqual(letterParts("Hi.\n\nJane Doe", profile).sig, ["Sincerely,", "Jane Doe"]);
  assert.deepEqual(letterParts("Hi.\n\nWarmly,\nJane Doe\njanedoe.dev", profile).sig, []);
  assert.deepEqual(letterParts("Hi.\n\nSincerely,\n\nJane A. Doe", profile).sig, []);
});

test("any short sign-off ending in a comma, a one-line or dashed signature, and a name with a suffix sign only once", () => {
  for (const s of ["Best wishes,\nJane Doe", "Thank you for your consideration,\nJane Doe", "All the best,\nJane Doe", "Yours sincerely,\nJane Doe",
    "Many thanks,\nJane Doe", "Best, Jane Doe", "\u2013 Jane Doe", "Best regards,\nJane Doe (he/him)", "Yours truly,\n\nJane Doe"]) {
    assert.deepEqual(letterParts(`Dear Globex,\n\nI ship things.\n\n${s}`, profile).sig, [], s);
  }
  assert.deepEqual(letterParts("Hi.\n\nJane Doe, PhD", profile).sig, ["Sincerely,", "Jane Doe, PhD"]);
  assert.deepEqual(letterParts("Hi.\n\nThank you for your consideration,", profile).sig, ["Jane Doe"]);
  assert.deepEqual(letterParts("Hi.\n\nDoe, Smith and I built it.", profile).sig, ["Sincerely,", "Jane Doe"]);
  const html = coverLetterHtml("Hi.\n\nBest wishes,\nJane Doe", profile, job);
  assert.equal(html.split('<div class="letter">')[1].split("Jane Doe").length - 1, 1, html);
});

test("the name under any closing line, or after a double dash, signs the letter once", () => {
  for (const s of ["-- Jane Doe", "Best wishes!\nJane Doe", "Best wishes\nJane Doe", "Warm regards —\nJane Doe",
    "Thank you so much for your time and consideration,\nJane Doe", "Best wishes!\nJane Doe\njanedoe.dev"]) {
    assert.deepEqual(letterParts(`Dear Globex,\n\nI ship things.\n\n${s}`, profile).sig, [], s);
    const tex = coverLetterTex(`Dear Globex,\n\nI ship things.\n\n${s}`, profile);
    assert.equal(tex.split("\\begin{document}")[1].split("Jane Doe").length - 1, 2, tex); // header + signature
  }
});

test("inputs are NFC-composed before escaping, so a singleton like U+1FEF never becomes a raw backtick", () => {
  const tex = coverLetterTex("Dear Globex,\n\nwow!` and ok?` and ``q.\n\nJane Doe", { ...profile, location: "Café `" } as Profile);
  assert.ok(!tex.includes("`"), tex);
  assert.ok(tex.includes("wow!\\textasciigrave{} and ok?\\textasciigrave{}"), tex);
  assert.ok(tex.includes("Café \\textasciigrave{}"), tex);
});

test("a live build keeps [x], * item, wow!\"Next\" and the link target exactly", { skip: !texEngine() && "no TeX engine on this machine" }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), "oa-tex-")), "letter.pdf");
  const p = { ...profile, linkedin: undefined, website: "https://e.com/p?a=1&b=2#f" } as Profile;
  await texToPdf(coverLetterTex('Dear Globex,\n\nChecklist:\n[x] shipped\n* item\n\nwow!"Next" and why?"Not"\n\nJane Doe', p), out);
  const { getDocumentProxy, extractText } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(readFileSync(out)));
  const { text } = await extractText(doc, { mergePages: true });
  for (const s of ["[x] shipped", "* item", "wow!\u201cNext\u201d", "why?\u201cNot\u201d"]) assert.ok(text.includes(s), `${s} in ${text}`);
  assert.ok(!/[\u00a1\u00bf]/.test(text), "no inverted ! or ?");
  const links = (await (await doc.getPage(1)).getAnnotations()).map((a: { url?: string }) => a.url).filter(Boolean);
  assert.ok(links.includes("https://e.com/p?a=1&b=2#f"), links.join(" "));
  await texToPdf(coverLetterTex("Hi.\n\nJane Doe", { ...p, website: "https://e.com/#/p#s" } as Profile), out);
  const doc2 = await getDocumentProxy(new Uint8Array(readFileSync(out)));
  const links2 = (await (await doc2.getPage(1)).getAnnotations()).map((a: { url?: string }) => a.url).filter(Boolean);
  assert.ok(links2.includes("https://e.com/#/p%23s"), links2.join(" "));
});

test("texToPdf refuses a document whose glyphs the font lacks, naming them", { skip: !texEngine() && "no TeX engine on this machine" }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), "oa-tex-")), "letter.pdf");
  await assert.rejects(texToPdf("\\documentclass{article}\\begin{document}ok \u2713\\end{document}", out), /U\+2713/);
});

test("texToPdf builds a one-page Latin Modern letter when a TeX engine is installed", { skip: !texEngine() && "no TeX engine on this machine" }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), "oa-tex-")), "letter.pdf");
  const { pages } = await texToPdf(coverLetterTex("Dear Globex,\n\nShort and true: 40% & $300K.\n\nJane Doe", profile), out);
  assert.equal(pages, 1);
  await assert.rejects(texToPdf("\\documentclass{article}\\begin{document}\\nosuchmacro\\end{document}", out), /failed/);
});

test("texToPdf refuses cleanly when OPENAPPLY_TEX=off", async () => {
  process.env.OPENAPPLY_TEX = "off";
  try {
    assert.equal(texEngine(), undefined);
    await assert.rejects(texToPdf("x", join(tmpdir(), "never.pdf")), /no TeX engine/);
  } finally { delete process.env.OPENAPPLY_TEX; }
});
