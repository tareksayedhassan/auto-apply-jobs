/** Shared contracts. Every module imports from here; change with care. */

export type Ats =
  | "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters" | "recruitee" | "workday"
  /** Aggregated feeds: the apply URL usually points elsewhere. */
  | "remoteok" | "remotive" | "arbeitnow" | "hn" | "himalayas" | "jobicy" | "other";

export interface Board {
  ats: Ats;
  /** Company's slug on that ATS, e.g. greenhouse "stripe", lever "plaid". */
  slug: string;
  company?: string;
}

/** A posting as produced by a source fetcher, before it reaches the DB. */
export interface NormalizedJob {
  /** Stable, globally unique: `${ats}:${slug}:${nativeId}`. */
  id: string;
  ats: Ats;
  boardSlug: string;
  company: string;
  title: string;
  /** Free-text location as posted ("New York, NY", "Remote - US"). */
  location: string;
  remote: boolean;
  /** Plain text (HTML stripped, whitespace collapsed). Can be long. */
  description: string;
  /**
   * Set false by a source whose description is a stub or was cut short (even if it is below the snippet
   * length). Default: complete when the text fits the stored snippet length.
   */
  descriptionComplete?: boolean;
  /** Human-facing posting page. */
  url: string;
  /** Direct application form URL when known (else same as url). */
  applyUrl: string;
  department?: string;
  employmentType?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  /** ISO 8601. */
  postedAt?: string;
}

export interface Job extends NormalizedJob {
  /** False while `description` is only the stored snippet; getJobFull() fetches the whole posting on demand. */
  descriptionComplete: boolean;
  firstSeen: string;
  lastSeen: string;
  /** False once a sync no longer sees it on its board. */
  open: boolean;
}

export interface JobFilters {
  /** Full-text query over title/company/description (FTS5 syntax tolerated, sanitized). */
  query?: string;
  company?: string;
  /** Substring match on location, case-insensitive. */
  location?: string;
  remote?: boolean;
  ats?: Ats;
  postedWithinDays?: number;
  minSalary?: number;
  includeClosed?: boolean;
  limit?: number;
  offset?: number;
}

/** One school entry for application forms that ask for it (Greenhouse's Education block; the first entry is used). */
export interface Education { school: string; degree?: string; discipline?: string; startYear?: number; endYear?: number }

export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  /** City, region, country as the user wants it written. */
  location?: string;
  linkedin?: string;
  github?: string;
  website?: string;
  /** Answers reused across every form. */
  workAuthorizedUS?: boolean;
  needsSponsorship?: boolean;
  willingToRelocate?: boolean;
  salaryExpectation?: string;
  noticePeriod?: string;
  pronouns?: string;
  /** EEO/self-ID: default is to decline, never guess. A value may list alternates for different form wordings: "Man|Male". */
  eeo?: { gender?: string; race?: string; veteran?: string; disability?: string; hispanic?: string; transgender?: string; orientation?: string };
  /** What the user is looking for; drives matching. */
  targets?: {
    titles?: string[];
    keywords?: string[];
    locations?: string[];
    remoteOk?: boolean;
    excludeCompanies?: string[];
    excludeKeywords?: string[];
    minSalary?: number;
    seniority?: string[];
  };
  /** Free-form Q&A the user has already answered once; reused on future forms. */
  savedAnswers?: Record<string, string>;
  /** Schools as the form should read them, most relevant first. Degree and discipline are matched to the form's own lists. */
  education?: Education[];
  /** Path to a ready-made resume PDF, used when a job has no tailored pack. */
  resumePdf?: string;
  /**
   * Named base resumes ("product", "crypto"), each the user's own PDF. A job whose title, company or description
   * names one of a track's useFor keywords (whole words) is drafted with that PDF; see resume-track.ts.
   */
  resumes?: Record<string, ResumeTrack>;
  /** The track (a key of resumes) used when no keyword matches. Without it, resumePdf is the fallback. */
  defaultResume?: string;
  /** Things the user wrote themselves (emails, posts, past answers). Tailoring mirrors this voice. */
  voiceSamples?: string[];
  /** Personal "why" material: what they care about, proud-of projects outside work. Never invented. */
  story?: string;
  /** True things the user has done that are not on the resume (one per line). Why-us drafts may cite them. */
  proofPoints?: string[];
  /** Figures or phrases the user's own records do not back (an audit dropped them): why-us drafts must never use them. */
  avoidClaims?: string[];
}

/** One base resume: the user's own finished PDF and the job keywords that pick it. */
export interface ResumeTrack { pdf: string; useFor?: string[] }

/** Structured resume. The master copy is the source of truth for the truth guard. */
export interface Resume {
  name: string;
  headline?: string;
  contact: { email?: string; phone?: string; location?: string; links?: string[] };
  summary?: string;
  experience: Array<{
    company: string; title: string; location?: string;
    start?: string; end?: string; bullets: string[];
  }>;
  projects?: Array<{ name: string; description?: string; link?: string; bullets: string[] }>;
  education: Array<{ school: string; degree?: string; location?: string; start?: string; end?: string; details?: string[] }>;
  skills?: string[];
  extras?: Array<{ heading: string; items: string[] }>;
}

export interface ApplicationPack {
  jobId: string;
  resume: Resume;
  coverLetter?: string;
  /** Question text (as it appears on the form) -> answer. */
  answers: Record<string, string>;
  resumePdf?: string;
  coverLetterPdf?: string;
  /** Truth-guard findings; empty = clean. */
  warnings: string[];
  createdAt: string;
  /** Last edit made in the dashboard (answers or cover letter). */
  updatedAt?: string;
  /** Drafted from the dashboard with the base resume: a tailored resume cut may still be worth making. */
  needsTailoredCut?: boolean;
  /**
   * Answers OpenApply drafted (why-us) that the user has not reviewed yet, by question. Each counts as unfinished
   * until the user edits it or keeps it; a no-honest-link draft can only be edited.
   */
  drafted?: Record<string, DraftedAnswer>;
}

/** A drafted answer awaiting the user's review. */
export interface DraftedAnswer {
  at: string;
  /** No honest link between the company and the user's work was found: the text is a short stub to rewrite. */
  noLink?: boolean;
  /** One line: the company fact and the user's proof the draft ties together. */
  link?: string;
}

export type ApplicationStatus =
  | "saved"        // user bookmarked the job
  | "drafted"      // pack written
  | "filled"       // form filled in the browser, awaiting approval
  | "approved"     // user said yes; submit allowed
  | "submitted"
  | "needs_human"  // captcha / login / unknown field: user must finish in the open browser
  | "interview" | "offer" | "rejected" | "withdrawn" | "ghosted";

export interface Application {
  jobId: string;
  status: ApplicationStatus;
  /** One-time code returned by fill; submit must echo it (or status must be approved). */
  confirmationCode?: string;
  submittedAt?: string;
  notes?: string;
  /** "history" when the row came from import_history (an application made before OpenApply). */
  source?: "history";
  updatedAt: string;
  createdAt: string;
}

export interface ApplicationEvent {
  id: number;
  jobId: string;
  at: string;
  kind: string;
  detail?: string;
}

/** A field discovered on a live application form. */
export interface FormField {
  /** Stable key the engine uses to target it (selector or adapter-specific id). */
  key: string;
  label: string;
  type: "text" | "email" | "tel" | "url" | "textarea" | "select" | "radio" | "checkbox" | "file" | "date" | "number" | "combobox" | "unknown";
  required: boolean;
  options?: string[];
  /** What the engine would put here from profile/pack, if it knows. */
  suggested?: string;
  /** Where the suggestion came from: profile | pack | savedAnswer | default. */
  source?: string;
}

export interface FormInspection {
  jobId: string;
  adapter: string;
  url: string;
  fields: FormField[];
  /** Required fields with no suggestion: the agent must answer these. */
  missing: string[];
  captchaDetected: boolean;
}

export interface FillResult {
  jobId: string;
  filled: Array<{ key: string; label: string; value: string }>;
  skipped: Array<{ key: string; label: string; reason: string }>;
  /** Required fields with no answer or no file. Approve and submit refuse while any remain. */
  blanks: string[];
  /** Required fields that have an answer the filler could not enter: the user finishes them in the open window. */
  failed: string[];
  screenshot?: string;
  confirmationCode: string;
  captchaDetected: boolean;
}

/** What one fill put on the form, kept (kv `fill:<jobId>`) for the approval view, approve and submit. */
export type StoredFill = Pick<FillResult, "filled" | "blanks" | "failed"> & {
  at: string;
  /** The fill's confirmation code: the record is current only while the application still carries it. */
  code: string;
};

export interface SubmitResult {
  jobId: string;
  /** verification_failed: the ATS refused the submission (Lever's verification banner); finish in the user's own browser. */
  outcome: "submitted" | "needs_human" | "failed" | "verification_failed";
  detail: string;
  screenshot?: string;
  /** With verification_failed (and a Lever CAPTCHA): the form to open in the user's own browser and the resume to attach. */
  applyUrl?: string;
  resume?: string;
}

export interface MatchResult {
  job: Job;
  score: number;
  reasons: string[];
}

/** A human touch: cold email, DM, intro request, follow-up. Recruiters weigh these over inbound applications. */
export interface Outreach {
  id: number;
  company: string;
  jobId?: string;
  person: string;
  role?: string;            // recruiter, hiring manager, founder, engineer, referrer
  channel: string;          // email, linkedin, x, text, intro, event
  contact?: string;         // address or profile URL the user supplied
  message?: string;
  sentAt: string;
  status: "draft" | "sent" | "replied" | "meeting" | "no_reply" | "closed";
  followUps: number;
  lastTouchAt: string;
  notes?: string;
}
