import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of user state. Override with OPENAPPLY_HOME (tests use a temp dir). */
export function home(): string {
  return process.env.OPENAPPLY_HOME || join(homedir(), ".openapply");
}

export const paths = {
  get db() { return process.env.OPENAPPLY_DB || join(home(), "openapply.db"); },
  get profile() { return join(home(), "profile.json"); },
  /** Master resume, structured (see types.Resume). */
  get resume() { return join(home(), "resume.json"); },
  /** Raw text of whatever file the user imported, kept for the truth guard. */
  get resumeSource() { return join(home(), "resume-source.txt"); },
  /** One folder per job: packs/<jobId>/resume.pdf, cover-letter.pdf, pack.json */
  get packs() { return join(home(), "packs"); },
  get screenshots() { return join(home(), "screenshots"); },
  /** Persistent Chromium profile so ATS logins/cookies survive between runs. */
  get browserProfile() { return join(home(), "browser-profile"); },
  /** User-added boards, merged over the bundled data/boards.json. */
  get userBoards() { return join(home(), "boards.json"); },
};

export function ensureHome(): void {
  for (const d of [home(), paths.packs, paths.screenshots, paths.browserProfile]) {
    mkdirSync(d, { recursive: true });
  }
}

/** A job's pack folder, without creating it (for reads). */
export function packPath(jobId: string): string {
  return join(paths.packs, jobId.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

/** A job's pack folder, created if missing (for writes). */
export function packDir(jobId: string): string {
  const d = packPath(jobId);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Package root (where data/ and ui/ live), resolved from src/ or dist/. */
export const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
