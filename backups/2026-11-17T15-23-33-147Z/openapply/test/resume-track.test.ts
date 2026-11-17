import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-tracks-"));
const { pickResume } = await import("../src/resume-track.js");
const profile = await import("../src/profile.js");
import type { Profile } from "../src/types.js";

const base: Profile = { firstName: "A", lastName: "B", email: "a@b.c" };
const tracks: Profile = {
  ...base,
  resumePdf: "/r/default.pdf",
  defaultResume: "product",
  resumes: {
    product: { pdf: "/r/product.pdf", useFor: ["forward deployed", "fde", "product engineer"] },
    crypto: { pdf: "/r/crypto.pdf", useFor: ["crypto", "web3", "defi", "blockchain"] },
  },
};
const job = (title: string, description = "", company = "Acme") => ({ title, description, company });

test("pickResume: a DeFi protocol role takes the crypto track", () => {
  const r = pickResume(tracks, job("Protocol Engineer, DeFi", "Build lending markets."))!;
  assert.equal(r.track, "crypto");
  assert.equal(r.pdf, "/r/crypto.pdf");
  assert.match(r.reason, /title.*defi/i);
});

test("pickResume: an FDE role takes the product track", () => {
  const r = pickResume(tracks, job("Forward Deployed Engineer", "Work with customers to ship AI agents."))!;
  assert.equal(r.track, "product");
  assert.equal(r.pdf, "/r/product.pdf");
});

test("pickResume: a keyword in the description or company counts; a title hit outranks a description hit", () => {
  const noDefault = { ...tracks, defaultResume: undefined };
  assert.equal(pickResume(noDefault, job("Solutions Engineer", "Our blockchain settles payments."))!.track, "crypto", "no default: one mention picks");
  assert.equal(pickResume(tracks, job("Solutions Engineer", "Our blockchain settles payments."))!.track, "product", "with a default: one mention does not");
  assert.equal(pickResume(tracks, job("Solutions Engineer", "Our DeFi protocol runs on a public blockchain."))!.track, "crypto", "two keywords do");
  assert.equal(pickResume(tracks, job("Solutions Engineer", "Crypto, crypto and more crypto."))!.track, "product", "the same keyword twice is one");
  assert.equal(pickResume(tracks, job("Solutions Engineer", "", "Web3 Labs"))!.track, "crypto");
  // the product title wins over a passing crypto mention in the description
  assert.equal(pickResume(tracks, job("Forward Deployed Engineer", "Customers include crypto exchanges."))!.track, "product");
});

test("pickResume: word boundaries, so encryption and cryptography never pick crypto", () => {
  const r = pickResume(tracks, job("Security Engineer", "End-to-end encryption and applied cryptography.", "Cryptomator"))!;
  assert.equal(r.track, "product", "falls to the default track");
  assert.match(r.reason, /default/i);
});

test("pickResume: no tracks falls back to profile.resumePdf, unchanged behaviour", () => {
  const r = pickResume({ ...base, resumePdf: "/r/default.pdf" }, job("Protocol Engineer, DeFi"))!;
  assert.equal(r.pdf, "/r/default.pdf");
  assert.equal(r.track, "base");
  assert.match(r.reason, /resumePdf/);
  // tracks without a default and no hit: still profile.resumePdf
  const noDefault = { ...tracks, defaultResume: undefined };
  assert.equal(pickResume(noDefault, job("Account Executive"))!.pdf, "/r/default.pdf");
  assert.equal(pickResume(base, job("Anything")), undefined, "nothing set: no pick");
});

test("saveProfile: resumes are normalized, non-PDF paths and unknown defaults are refused", () => {
  const p = profile.saveProfile({
    resumes: { " crypto ": { pdf: " /r/crypto.PDF ", useFor: "crypto, web3, ,defi" as any }, product: { pdf: "/r/product.pdf" } },
    defaultResume: "product",
  });
  assert.deepEqual(p.resumes, { crypto: { pdf: "/r/crypto.PDF", useFor: ["crypto", "web3", "defi"] }, product: { pdf: "/r/product.pdf" } });
  assert.equal(p.defaultResume, "product");
  assert.throws(() => profile.saveProfile({ resumes: { product: { pdf: "/r/product.docx" } } }), /\.pdf/);
  assert.throws(() => profile.saveProfile({ resumes: { product: {} as any } }), /\.pdf/);
  assert.throws(() => profile.saveProfile({ defaultResume: "design" }), /defaultResume/);
  assert.deepEqual(profile.loadProfile()!.resumes!.product, { pdf: "/r/product.pdf" }, "a refused save writes nothing");
});

test("pickResume: a customer list naming crypto keeps the default track", () => {
  const r = pickResume(tracks, job("Solutions Engineer", "Our customers include banks, gaming, crypto and marketplaces."))!;
  assert.equal(r.track, "product");
  assert.match(r.reason, /defaultResume/);
});

test("pickResume: spaces and hyphens in a keyword match either form", () => {
  assert.equal(pickResume(tracks, job("Forward-Deployed Engineer", "Customers include crypto exchanges."))!.reason, 'title matches "forward deployed"');
  assert.equal(pickResume(tracks, job("Forward  Deployed Engineer"))!.reason, 'title matches "forward deployed"');
  const hy = { ...base, resumes: { product: { pdf: "/r/p.pdf", useFor: ["go-to-market"] } } };
  assert.equal(pickResume(hy, job("Go To Market Engineer"))!.track, "product");
});
