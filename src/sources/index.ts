import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ats, Board, NormalizedJob } from "../types.js";
import { paths, pkgRoot } from "../paths.js";
import * as greenhouse from "./greenhouse.js";
import * as lever from "./lever.js";
import * as ashby from "./ashby.js";
import * as workable from "./workable.js";
import * as smartrecruiters from "./smartrecruiters.js";
import * as recruitee from "./recruitee.js";
import * as workday from "./workday.js";
import * as remoteok from "./remoteok.js";
import * as remotive from "./remotive.js";
import * as arbeitnow from "./arbeitnow.js";
import * as hn from "./hn.js";
import * as himalayas from "./himalayas.js";
import * as jobicy from "./jobicy.js";

export const BOARD_SOURCES: Partial<Record<Ats, (slug: string) => Promise<NormalizedJob[]>>> = {
  greenhouse: greenhouse.fetchBoard, lever: lever.fetchBoard, ashby: ashby.fetchBoard,
  workable: workable.fetchBoard, smartrecruiters: smartrecruiters.fetchBoard, recruitee: recruitee.fetchBoard,
  workday: workday.fetchBoard,
};

export const FEED_SOURCES: Partial<Record<Ats, () => Promise<NormalizedJob[]>>> = {
  remoteok: remoteok.fetchFeed, remotive: remotive.fetchFeed, arbeitnow: arbeitnow.fetchFeed,
  hn: hn.fetchFeed, himalayas: himalayas.fetchFeed, jobicy: jobicy.fetchFeed,
};

/** boards.json shape: { "greenhouse": ["stripe", { "slug": "x", "company": "X" }], "lever": [...] } */
export type BoardsFile = Partial<Record<Ats, Array<string | { slug: string; company?: string }>>>;

function readBoardsFile(file: string): Board[] {
  if (!existsSync(file)) return [];
  let data: BoardsFile;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
  const out: Board[] = [];
  for (const [ats, list] of Object.entries(data ?? {})) {
    if (!(ats in BOARD_SOURCES) || !Array.isArray(list)) continue;
    for (const e of list) {
      const slug = typeof e === "string" ? e : e?.slug;
      if (typeof slug === "string" && slug) out.push({ ats: ats as Ats, slug, company: typeof e === "string" ? undefined : e.company });
    }
  }
  return out;
}

/** Bundled data/boards.json merged with the user's own; deduped by ats+slug, the user's company name wins. */
export function loadBoards(): Board[] {
  const merged = new Map<string, Board>();
  for (const b of [...readBoardsFile(join(pkgRoot, "data", "boards.json")), ...readBoardsFile(paths.userBoards)]) {
    const key = `${b.ats}:${b.slug}`;
    merged.set(key, { ...merged.get(key), ...b, company: b.company ?? merged.get(key)?.company });
  }
  return [...merged.values()];
}
