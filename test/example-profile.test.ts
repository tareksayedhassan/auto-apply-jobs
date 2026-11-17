import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENAPPLY_HOME = mkdtempSync(join(tmpdir(), "oa-example-profile-"));
const profile = await import("../src/profile.js");
const example = JSON.parse(readFileSync(fileURLToPath(new URL("../examples/profile.example.json", import.meta.url)), "utf8"));

test("examples/profile.example.json loads through the real save/load path and uses every Profile field", () => {
  const saved = profile.saveProfile(example);
  assert.deepEqual(profile.loadProfile(), saved);
  assert.deepEqual(saved, example, "nothing is dropped or rewritten");
  for (const k of ["firstName", "lastName", "email", "phone", "location", "linkedin", "github", "website", "workAuthorizedUS", "needsSponsorship",
    "willingToRelocate", "salaryExpectation", "noticePeriod", "pronouns", "eeo", "targets", "savedAnswers", "education", "resumePdf", "voiceSamples", "story"]) {
    assert.notEqual((saved as any)[k], undefined, `${k} is in the example`);
  }
  assert.deepEqual(Object.keys(saved.targets!).sort(), ["excludeCompanies", "excludeKeywords", "keywords", "locations", "minSalary", "remoteOk", "seniority", "titles"]);
  assert.deepEqual(Object.keys(saved.eeo!).sort(), ["disability", "gender", "hispanic", "orientation", "race", "transgender", "veteran"]);
  assert.deepEqual(profile.profileStatus().missing, ["resume"], "only the resume is left to import");
});
