import { resolve } from "node:path";
import { packPath } from "./paths.js";
import { loadProfile } from "./profile.js";
import { loadPack } from "./tailor.js";
import type { Job, Profile } from "./types.js";

/** Which of the user's own base resumes a job is drafted with, and why. */
export interface ResumePick { track: string; pdf: string; reason: string }

/** Where a keyword hit counts most: a title names the role, a company name its world, a description only mentions. */
const FIELDS = ["title", "company", "description"] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Whole-word, case-insensitive: "crypto" matches "Crypto, DeFi" but not "cryptography" or "encryption". Spaces and
 * hyphens inside a keyword match either, so "forward deployed" matches "Forward-Deployed" and "Forward  Deployed".
 */
const wordRe = (kw: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(kw.trim()).replace(/\s+|-/g, "[\\s\\-]+")}(?![\\p{L}\\p{N}])`, "iu");

/**
 * Pick the base resume for a job. The track whose useFor keyword appears in the strongest field wins (title, then
 * company, then description; ties go to the track listed first). A description only mentions: with a defaultResume
 * set, it picks a track only when two or more of that track's keywords appear in it ("customers include banks,
 * gaming, crypto" stays on the default). With no hit: defaultResume, then profile.resumePdf, so a profile without
 * resumes behaves as before. Undefined when the profile names no resume PDF at all.
 */
export function pickResume(profile: Profile | undefined, job: Pick<Job, "title" | "company" | "description">): ResumePick | undefined {
  const tracks = profile?.resumes ?? {};
  const def = profile?.defaultResume && tracks[profile.defaultResume] ? profile.defaultResume : undefined;
  let best: (ResumePick & { rank: number }) | undefined;
  for (const [track, t] of Object.entries(tracks)) {
    const kws = (t.useFor ?? []).map(k => k.trim()).filter(Boolean);
    const inDesc = new Set(kws.filter(kw => wordRe(kw).test(job.description ?? "")).map(k => k.toLowerCase()));
    for (const kw of kws) {
      let rank = FIELDS.findIndex(f => wordRe(kw).test(job[f] ?? ""));
      if (rank === 2 && def && inDesc.size < 2) rank = -1;
      if (rank >= 0 && (!best || rank < best.rank)) best = { track, pdf: t.pdf, reason: `${FIELDS[rank]} matches "${kw}"`, rank };
    }
  }
  if (best) return { track: best.track, pdf: best.pdf, reason: best.reason };
  if (def) return { track: def, pdf: tracks[def].pdf, reason: "no keyword matched; defaultResume" };
  if (profile?.resumePdf) {
    const why = Object.keys(tracks).length ? "no keyword matched and no defaultResume; profile.resumePdf" : "no resume tracks set; profile.resumePdf";
    return { track: "base", pdf: profile.resumePdf, reason: why };
  }
  return undefined;
}

/**
 * The user keeps their own resume PDFs (profile.resumePdf or resume tracks): a pack that would upload OpenApply's
 * rendered <packDir>/resume.pdf instead is refused. With neither set, the rendered resume is the user's resume.
 */
export function assertOwnResume(jobId: string): void {
  const p = loadProfile();
  const own = !!p?.resumePdf || Object.keys(p?.resumes ?? {}).length > 0;
  const packPdf = loadPack(jobId)?.resumePdf;
  if (own && packPdf && resolve(packPdf) === resolve(packPath(jobId), "resume.pdf")) {
    throw new Error("Fill refused: this pack uses OpenApply's rendered resume; save the pack with resume_pdf (your own PDF)");
  }
}
