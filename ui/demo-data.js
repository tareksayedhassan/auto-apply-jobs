// Demo mode for the OpenApply dashboard.
// Used when the local server is unreachable or the URL has ?demo=1.
// Everything here is fictional: companies, people and postings are made up.
// The in-memory router below mirrors the HTTP API in ARCHITECTURE.md closely enough
// that every view, filter and action in the dashboard can be exercised offline.

const HOUR = 3600e3;
const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

const PROFILE = {
  firstName: "Jordan",
  lastName: "Reyes",
  email: "jordan.reyes@example.com",
  phone: "(555) 014-2290",
  location: "Brooklyn, NY",
  linkedin: "https://linkedin.example/in/jordan-reyes",
  github: "https://github.example/jreyes",
  website: "https://jordanreyes.example",
  workAuthorizedUS: true,
  needsSponsorship: false,
  willingToRelocate: false,
  pronouns: "they/them",
  eeo: { gender: "Decline to self-identify", race: "Decline to self-identify", veteran: "Decline to self-identify", disability: "Decline to self-identify", hispanic: "Decline to self-identify" },
  targets: {
    titles: ["Senior Product Manager", "Product Lead", "Group Product Manager"],
    keywords: ["platform", "developer tools", "B2B SaaS", "healthcare", "growth"],
    locations: ["New York, NY", "Remote (US)"],
    remoteOk: true,
    excludeCompanies: ["Quillfeather Ads"],
    excludeKeywords: ["crypto", "gambling"],
    minSalary: 175000,
    seniority: ["senior", "lead"],
  },
  savedAnswers: {
    "How did you hear about us?": "Company careers page",
    "Earliest start date": "Two weeks after an accepted offer",
  },
};

const RESUME = {
  name: "Jordan Reyes",
  headline: "Senior Product Manager, platform and developer tools",
  contact: { email: "jordan.reyes@example.com", phone: "(555) 014-2290", location: "Brooklyn, NY", links: ["linkedin.example/in/jordan-reyes", "jordanreyes.example"] },
  summary: "Product manager with eight years shipping B2B platforms. I turn messy internal tooling into products teams adopt on their own, and I like the unglamorous parts: migrations, pricing pages, permission models.",
  experience: [
    { company: "Brinepool Analytics", title: "Senior Product Manager, Data Platform", location: "New York, NY", start: "2022", end: "Present", bullets: [
      "Led the pipeline builder from beta to general availability; 310 customer workspaces adopted it in two quarters.",
      "Rebuilt usage-based pricing with finance and sales, lifting expansion revenue 18% year over year.",
      "Ran a weekly customer council of 12 data leads that set the roadmap for the warehouse connectors.",
    ] },
    { company: "Tinthread", title: "Product Manager, Integrations", location: "Remote", start: "2019", end: "2022", bullets: [
      "Shipped a public integrations API and partner directory used by 40+ third-party apps.",
      "Cut median onboarding time from 9 days to 3 by replacing CSV imports with guided sync.",
    ] },
    { company: "Farrowmere Bank", title: "Associate Product Manager", location: "Chicago, IL", start: "2017", end: "2019", bullets: [
      "Owned the small-business account opening flow; reduced abandonment 22%.",
    ] },
  ],
  projects: [{ name: "Shiplog", description: "Open-source changelog generator", link: "github.com/jreyes-example/shiplog", bullets: ["1.4k GitHub stars; used by a few hundred teams to publish release notes."] }],
  education: [{ school: "University of Michigan", degree: "B.S. Information Science", start: "2013", end: "2017" }],
  skills: ["Product strategy", "Pricing", "SQL", "Experiment design", "API design", "Figma", "Customer research"],
};

// ---- jobs ------------------------------------------------------------------

const J = (o) => ({
  department: undefined, employmentType: "Full-time", salaryCurrency: "USD",
  firstSeen: iso((o.h || 24) + 2), lastSeen: iso(1), open: true, ...o,
  id: `${o.ats}:${o.slug}:${o.nid}`, boardSlug: o.slug, postedAt: iso(o.h || 24),
  applyUrl: o.applyUrl || o.url,
});

const DESC = {
  plumewick: `Plumewick helps research teams run studies with thousands of participants without losing the thread. We are a 90-person company, Series B, with customers in healthcare, consumer and public sector.

About the role
You will own the Platform area: the APIs, permissions model and workspace administration that every other team builds on. You will work with a staff engineer, two product designers and the head of security.

What you will do
- Set the multi-year direction for our public API and admin console.
- Ship enterprise controls (SSO, SCIM, audit logs) that unblock our largest deals.
- Partner with sales engineering on technical evaluations.

What we look for
- 6+ years in product, at least 3 on platform or developer-facing products.
- You can read an OpenAPI spec and argue about pagination.
- Comfort with ambiguity and a habit of writing things down.

Compensation: $185,000 to $215,000 plus equity. Hybrid in New York (two days a week) or remote in the US.`,
  halcyon: `Tindlow Health builds care navigation software used by 140 hospital systems. Patients use Tindlow to find the right appointment; care teams use it to keep them from falling through the cracks.

The role
As Product Lead for Care Navigation you will own the patient-facing scheduling experience and the rules engine behind it. You will lead a pod of eight engineers and two designers.

You might be a fit if
- You have shipped consumer-grade experiences inside a regulated industry.
- You know how to say no to a hospital executive and keep the relationship.
- You have managed a product through a platform migration.

Salary range: $190,000 to $225,000. Remote within the United States.`,
  vantrell: `Vantrell is the analytics workspace for product teams. We are looking for a Senior Product Manager to lead Growth: activation, self-serve monetization and the in-product experiments that drive them.

You will
- Own the free-to-paid funnel end to end.
- Run a high-tempo experimentation program with a dedicated growth engineering team.
- Work closely with marketing on lifecycle messaging and pricing pages.

You have
- 5+ years of product management, 2+ in growth or monetization.
- Strong SQL and a healthy suspicion of dashboards.

$175,000 to $205,000. New York office, three days a week.`,
};

const generic = (company, role, extra) => `${company} is hiring a ${role}. ${extra}

Responsibilities
- Own the roadmap for your area and communicate it clearly.
- Work with engineering and design from discovery through launch.
- Talk to customers every week.

Qualifications
- 5+ years of product management in B2B software.
- Strong written communication.
- Experience with usage-based or seat-based pricing a plus.`;

const JOBS = [
  J({ ats: "greenhouse", slug: "plumewick", nid: "7012345", company: "Plumewick", title: "Senior Product Manager, Platform", location: "New York, NY or Remote (US)", remote: true, salaryMin: 185000, salaryMax: 215000, h: 30, department: "Product", url: "https://plumewick.example/careers/7012345", description: DESC.plumewick }),
  J({ ats: "lever", slug: "tindlowhealth", nid: "b1e6c0a2-55d1", company: "Tindlow Health", title: "Product Lead, Care Navigation", location: "Remote (US)", remote: true, salaryMin: 190000, salaryMax: 225000, h: 52, department: "Product", url: "https://tindlowhealth.example/careers/b1e6c0a2-55d1", applyUrl: "https://tindlowhealth.example/careers/b1e6c0a2-55d1/apply", description: DESC.halcyon }),
  J({ ats: "ashby", slug: "vantrell", nid: "4f0c2d", company: "Vantrell", title: "Senior Product Manager, Growth", location: "New York, NY", remote: false, salaryMin: 175000, salaryMax: 205000, h: 76, department: "Product", url: "https://vantrell.example/careers/4f0c2d", description: DESC.vantrell }),
  J({ ats: "greenhouse", slug: "quorrim", nid: "5530021", company: "Quorrim", title: "Group Product Manager, Developer Experience", location: "Remote (US, Canada)", remote: true, salaryMin: 210000, salaryMax: 245000, h: 9, department: "Product", url: "https://quorrim.example/careers/5530021", description: generic("Quorrim", "Group Product Manager for Developer Experience", "You will lead three PMs across the CLI, SDKs and docs.") }),
  J({ ats: "ashby", slug: "dravellefreight", nid: "a81b9e", company: "Dravelle Freight", title: "Senior Product Manager, Carrier Platform", location: "New York, NY", remote: false, salaryMin: 180000, salaryMax: 200000, h: 20, department: "Product", url: "https://dravellefreight.example/careers/a81b9e", description: generic("Dravelle Freight", "Senior Product Manager for the Carrier Platform", "Our carrier platform moves 8,000 loads a day.") }),
  J({ ats: "lever", slug: "yarrowby", nid: "c22d-91aa", company: "Yarrowby", title: "Senior Product Manager, Billing", location: "Remote (US)", remote: true, salaryMin: 170000, salaryMax: 195000, h: 44, department: "Product", url: "https://yarrowby.example/careers/c22d-91aa", description: generic("Yarrowby", "Senior Product Manager for Billing", "You will rebuild invoicing for 20,000 customers.") }),
  J({ ats: "greenhouse", slug: "hexmoorsecurity", nid: "6120044", company: "Hexmoor Security", title: "Product Manager, Identity", location: "San Francisco, CA or Remote (US)", remote: true, salaryMin: 165000, salaryMax: 190000, h: 100, department: "Product", url: "https://hexmoorsecurity.example/careers/6120044", description: generic("Hexmoor Security", "Product Manager for Identity", "SSO, SCIM and access reviews for mid-market IT teams.") }),
  J({ ats: "workable", slug: "oxbury", nid: "9F21AB", company: "Oxbury & Pell", title: "Lead Product Manager, Data Products", location: "New York, NY", remote: false, salaryMin: 195000, salaryMax: 230000, h: 130, department: "Data", url: "https://oxbury.example/careers/9F21AB", description: generic("Oxbury & Pell", "Lead Product Manager for Data Products", "Our research data feeds power 300 investment teams.") }),
  J({ ats: "ashby", slug: "wrenlowbio", nid: "0c7d11", company: "Wrenlow Bio", title: "Senior Product Manager, Lab Platform", location: "Boston, MA", remote: false, salaryMin: 170000, salaryMax: 190000, h: 160, department: "Product", url: "https://wrenlowbio.example/careers/0c7d11", description: generic("Wrenlow Bio", "Senior Product Manager for the Lab Platform", "Scientists use our platform to run 2 million assays a year.") }),
  J({ ats: "greenhouse", slug: "carrowick", nid: "4401876", company: "Carrowick", title: "Senior Product Manager, Workflow Automation", location: "Remote (US)", remote: true, h: 14, department: "Product", url: "https://carrowick.example/careers/4401876", description: generic("Carrowick", "Senior Product Manager for Workflow Automation", "Help operations teams automate approvals without code.") }),
  J({ ats: "lever", slug: "embrelhq", nid: "77ab-0f31", company: "Embrel", title: "Product Manager, Growth", location: "Austin, TX or Remote (US)", remote: true, salaryMin: 150000, salaryMax: 175000, h: 66, department: "Growth", url: "https://embrelhq.example/careers/77ab-0f31", description: generic("Embrel", "Product Manager for Growth", "We are a 40-person team building scheduling software for clinics.") }),
  J({ ats: "smartrecruiters", slug: "larkhollowlabs", nid: "744000012", company: "Larkhollow Labs", title: "Principal Product Manager, Platform APIs", location: "Seattle, WA", remote: false, salaryMin: 220000, salaryMax: 260000, h: 210, department: "Product", url: "https://larkhollowlabs.example/careers/744000012", description: generic("Larkhollow Labs", "Principal Product Manager for Platform APIs", "Our APIs serve 3 billion requests a day.") }),
  J({ ats: "greenhouse", slug: "dunmorrow", nid: "5009911", company: "Dunmorrow", title: "Senior Product Manager, Payments", location: "New York, NY", remote: false, salaryMin: 185000, salaryMax: 210000, h: 300, department: "Product", url: "https://dunmorrow.example/careers/5009911", description: generic("Dunmorrow", "Senior Product Manager for Payments", "Payroll and payments for hourly workforces.") }),
  J({ ats: "ashby", slug: "brackenfold", nid: "e19a02", company: "Brackenfold", title: "Product Lead, Search", location: "Remote (Americas)", remote: true, salaryMin: 200000, salaryMax: 235000, h: 120, department: "Product", url: "https://brackenfold.example/careers/e19a02", description: generic("Brackenfold", "Product Lead for Search", "Enterprise search across 40 SaaS tools.") }),
  J({ ats: "lever", slug: "tollgrove", nid: "1a2b-3c4d", company: "Tollgrove", title: "Senior Product Manager, Mobile", location: "New York, NY", remote: false, salaryMin: 175000, salaryMax: 200000, h: 400, department: "Product", url: "https://tollgrove.example/careers/1a2b-3c4d", description: generic("Tollgrove", "Senior Product Manager for Mobile", "Our app helps 2 million renters pay and manage their homes.") }),
  J({ ats: "greenhouse", slug: "ohmsteadgrid", nid: "6604410", company: "Ohmstead Grid", title: "Senior Product Manager, Energy Markets", location: "Remote (US)", remote: true, salaryMin: 180000, salaryMax: 205000, h: 34, department: "Product", url: "https://ohmsteadgrid.example/careers/6604410", description: generic("Ohmstead Grid", "Senior Product Manager for Energy Markets", "Software for utilities trading on wholesale power markets.") }),
  J({ ats: "remotive", slug: "remotive", nid: "1938822", company: "Pebblebox", title: "Product Manager, Integrations", location: "Remote (Worldwide)", remote: true, h: 80, department: "Product", url: "https://remote-jobs.example/product/1938822", description: generic("Pebblebox", "Product Manager for Integrations", "Build the connectors that move data between 200 apps.") }),
  J({ ats: "greenhouse", slug: "mirefield", nid: "3301299", company: "Mirefield", title: "Senior Product Manager, Marketplace", location: "Chicago, IL", remote: false, salaryMin: 165000, salaryMax: 185000, h: 520, department: "Product", url: "https://mirefield.example/careers/3301299", description: generic("Mirefield", "Senior Product Manager for the Marketplace", "A marketplace for regenerative farm supply.") }),
  J({ ats: "lever", slug: "pothook", nid: "aa01-77fe", company: "Pothook", title: "Product Manager, Restaurant OS", location: "Denver, CO", remote: false, salaryMin: 140000, salaryMax: 160000, h: 600, department: "Product", url: "https://pothook.example/careers/aa01-77fe", description: generic("Pothook", "Product Manager for Restaurant OS", "Point of sale and back office for independent restaurants.") }),
  J({ ats: "hn", slug: "hn", nid: "41822010", company: "Vellumry", title: "Founding Product Manager", location: "New York, NY (on site)", remote: false, h: 180, department: undefined, url: "https://whoishiring.example/item/41822010", description: generic("Vellumry", "Founding Product Manager", "Seed-stage, 9 people, building AI tooling for accountants.") }),
];

// Applications from before OpenApply (import_history): closed placeholder jobs, as the server makes them.
const day = (hoursAgo) => iso(hoursAgo).slice(0, 10);
const HISTORY = [
  ["Carrowick", "Senior Product Manager, Workflow Automation", "ghosted", 24 * 49],
  ["Quorrim", "Product Manager, CLI", "rejected", 24 * 71],
  ["Larkhollow Labs", "Product Manager, Billing", "submitted", 24 * 20],
  ["Quillonby", "Group Product Manager", "submitted", 24 * 26],
  ["Anvilry", "Senior Product Manager", "interview", 24 * 11],
  ["Sorrelgate Health", "Senior Product Manager, Care Platform", "rejected", 24 * 40],
  ["Glowerfin", "Product Manager, Integrations", "ghosted", 24 * 62],
  ["Dabblesby", "Product Lead, Growth", "withdrawn", 24 * 90],
].map(([company, title, status, h]) => {
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { company, title, status, appliedAt: day(h), id: `history:${key(company).replace(/-/g, "")}:${key(title)}` };
});
JOBS.push(...HISTORY.map((r) => ({
  id: r.id, ats: "other", boardSlug: "history", company: r.company, title: r.title, location: "", remote: false, description: "",
  url: "", applyUrl: "", firstSeen: r.appliedAt, lastSeen: r.appliedAt, open: false,
})));

// What GET /api/jobs/:id finds for a company's site; unknown companies get none.
const WEBSITES = { plumewick: "https://plumewick.example", quorrim: "https://quorrim.example", carrowick: "https://carrowick.example", tindlowhealth: "https://tindlowhealth.example", vantrell: "https://vantrell.example" };

const byId = (id) => JOBS.find((j) => j.id === id);
const jid = (slug) => JOBS.find((j) => j.boardSlug === slug).id;

const MATCHES = [
  ["quorrim", 94, ["Title matches \"Group Product Manager\"", "Remote (US)", "Keywords: developer tools, platform", "$210k to $245k clears your floor"]],
  ["plumewick", 92, ["Title matches \"Senior Product Manager\"", "Keywords: platform, B2B SaaS", "Remote or New York", "Posted 1 day ago"]],
  ["tindlowhealth", 89, ["Title matches \"Product Lead\"", "Keyword: healthcare", "Remote (US)"]],
  ["dravellefreight", 86, ["Title matches \"Senior Product Manager\"", "Keyword: platform", "In New York, NY"]],
  ["vantrell", 84, ["Title matches \"Senior Product Manager\"", "Keyword: growth", "In New York, NY"]],
  ["carrowick", 81, ["Title matches \"Senior Product Manager\"", "Remote (US)", "Keyword: B2B SaaS", "No salary posted"]],
  ["brackenfold", 79, ["Title matches \"Product Lead\"", "Remote (Americas)"]],
  ["ohmsteadgrid", 77, ["Title matches \"Senior Product Manager\"", "Remote (US)"]],
  ["yarrowby", 74, ["Title matches \"Senior Product Manager\"", "Remote (US)", "Max $195k is near your floor"]],
  ["hexmoorsecurity", 71, ["Keyword: platform", "Remote (US)", "Title is one level below your target"]],
  ["oxbury", 69, ["Title close to \"Product Lead\"", "In New York, NY", "Posted 5 days ago"]],
  ["larkhollowlabs", 64, ["Keyword: platform", "Seattle, WA is outside your locations"]],
  ["embrelhq", 61, ["Keywords: growth, healthcare", "Salary below your floor"]],
  ["remotive", 58, ["Remote (Worldwide)", "Title is one level below your target"]],
  ["dunmorrow", 55, ["Title matches \"Senior Product Manager\"", "Posted 12 days ago"]],
  ["wrenlowbio", 52, ["Keyword: platform", "Boston, MA is outside your locations"]],
];

// ---- packs, applications, events --------------------------------------------

function tailored(overrides) {
  const r = structuredClone(RESUME);
  Object.assign(r, overrides.top || {});
  if (overrides.bullets0) r.experience[0].bullets = overrides.bullets0;
  if (overrides.title0) r.experience[0].title = overrides.title0;
  return r;
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Draws a plausible filled ATS form as an SVG data URI, standing in for a Playwright screenshot. */
function formShot({ company, title, accent, fields }) {
  const W = 1000;
  let y = 210;
  const parts = [];
  for (const f of fields) {
    parts.push(`<text x="80" y="${y}" font-size="17" font-weight="600" fill="#222">${xml(f.label)}${f.req ? ' <tspan fill="#c0392b">*</tspan>' : ""}</text>`);
    y += 14;
    if (f.file) {
      parts.push(`<rect x="80" y="${y}" width="840" height="56" rx="6" fill="#f6f8fa" stroke="#d0d7de"/>`);
      parts.push(`<rect x="96" y="${y + 14}" width="22" height="28" rx="3" fill="${accent}" opacity=".85"/>`);
      parts.push(`<text x="132" y="${y + 34}" font-size="16" fill="#222">${xml(f.value)}</text>`);
      parts.push(`<text x="900" y="${y + 34}" font-size="14" fill="#57606a" text-anchor="end">Attached</text>`);
      y += 56 + 40;
    } else if (f.long) {
      const lines = wrap(f.value, 92).slice(0, 5);
      const hgt = 26 + lines.length * 24;
      parts.push(`<rect x="80" y="${y}" width="840" height="${hgt}" rx="6" fill="#fff" stroke="#d0d7de"/>`);
      lines.forEach((ln, i) => parts.push(`<text x="96" y="${y + 30 + i * 24}" font-size="15.5" fill="#222">${xml(ln)}</text>`));
      y += hgt + 40;
    } else if (f.select) {
      parts.push(`<rect x="80" y="${y}" width="840" height="46" rx="6" fill="#fff" stroke="#d0d7de"/>`);
      parts.push(`<text x="96" y="${y + 29}" font-size="16" fill="#222">${xml(f.value)}</text>`);
      parts.push(`<path d="M890 ${y + 19} l8 8 l8 -8" stroke="#57606a" stroke-width="2" fill="none"/>`);
      y += 46 + 40;
    } else {
      parts.push(`<rect x="80" y="${y}" width="840" height="46" rx="6" fill="#fff" stroke="#d0d7de"/>`);
      parts.push(`<text x="96" y="${y + 29}" font-size="16" fill="#222">${xml(f.value)}</text>`);
      y += 46 + 40;
    }
  }
  parts.push(`<rect x="80" y="${y}" width="230" height="52" rx="6" fill="${accent}"/>`);
  parts.push(`<text x="195" y="${y + 33}" font-size="17" font-weight="600" fill="#fff" text-anchor="middle">Submit application</text>`);
  const H = y + 110;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<rect width="${W}" height="6" fill="${accent}"/>
<text x="80" y="88" font-size="30" font-weight="700" fill="#111">${xml(title)}</text>
<text x="80" y="122" font-size="18" fill="#57606a">${xml(company)}</text>
<line x1="80" y1="152" x2="920" y2="152" stroke="#e5e7eb"/>
<text x="80" y="186" font-size="20" font-weight="700" fill="#111">Apply for this job</text>
${parts.join("\n")}
</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const COMMON_FIELDS = [
  { label: "First name", value: "Jordan", req: true },
  { label: "Last name", value: "Reyes", req: true },
  { label: "Email", value: "jordan.reyes@example.com", req: true },
  { label: "Phone", value: "(555) 014-2290" },
  { label: "Resume/CV", value: "Jordan_Reyes_Resume.pdf", file: true, req: true },
  { label: "Cover letter", value: "Jordan_Reyes_Cover_Letter.pdf", file: true },
  { label: "LinkedIn profile", value: "linkedin.example/in/jordan-reyes" },
];

function buildState() {
  const packs = {};
  const apps = {};
  const events = [];
  let eid = 1;
  const ev = (slug, h, kind, detail) => events.push({ id: eid++, jobId: jid(slug), at: iso(h), kind, detail });
  const app = (slug, status, h, extra = {}) => {
    apps[jid(slug)] = { jobId: jid(slug), status, createdAt: iso(h + 30), updatedAt: iso(h), ...extra };
  };
  // A fill's record (job detail `fill`) is the screenshot's fields: a field with no value was skipped.
  const fills = {};
  const forms = {};
  const shot = (slug, opts) => { forms[slug] = opts.fields; return formShot(opts); };
  const fill = (slug, h) => {
    const fields = forms[slug];
    const blanks = fields.filter((f) => !f.value && f.req).map((f) => f.label);
    fills[jid(slug)] = { at: iso(h), filled: fields.filter((f) => f.value).map((f) => ({ key: f.label, label: f.label, value: f.value })), blanks, failed: [] };
  };

  // Plumewick: filled, has truth-guard warnings.
  packs[jid("plumewick")] = {
    jobId: jid("plumewick"),
    resume: tailored({
      top: { headline: "Senior Product Manager, platform and enterprise controls", summary: "Product manager with eight years on B2B platforms: public APIs, permission models and admin consoles that enterprise buyers ask for by name." },
      title0: "Lead Product Manager, Data Platform",
      bullets0: [
        "Led the pipeline builder from beta to general availability; 310 customer workspaces adopted it in two quarters.",
        "Shipped SSO and audit logs that unblocked 40% of enterprise pipeline in 2024.",
        "Ran a weekly customer council of 12 data leads that set the roadmap for the warehouse connectors.",
      ],
    }),
    coverLetter: `Dear Plumewick team,

I have spent the last three years making a data platform feel like a product rather than a pile of settings, and the Platform role reads like the next chapter of that work. At Brinepool Analytics I took our pipeline builder from beta to general availability and rebuilt pricing with finance and sales. Most of what made those launches work was unglamorous: a permission model customers could reason about, and an admin console that answered questions before support had to.

Plumewick's customers in healthcare and the public sector will ask for SSO, SCIM and audit logs early and often. I have shipped integrations APIs and enterprise controls before, and I like the part where you argue about pagination.

I would welcome the chance to talk.

Jordan Reyes`,
    answers: {
      "Are you legally authorized to work in the United States?": "Yes",
      "Will you now or in the future require sponsorship for employment visa status?": "No",
      "Why do you want to work at Plumewick?": "Your customers run research where losing the thread has real costs, and the Platform area is where that reliability starts. I have spent three years making a data platform feel like a product, and I want to do that for a team whose users are researchers.",
      "What is your desired salary?": "$200,000 base, flexible on the mix with equity",
      "Earliest start date": "Two weeks after an accepted offer",
      "How did you hear about us?": "Company careers page",
    },
    resumePdf: "resume.pdf",
    coverLetterPdf: "cover-letter.pdf",
    warnings: [
      "Title \"Lead Product Manager, Data Platform\" at Brinepool Analytics is not in your master resume (master: \"Senior Product Manager, Data Platform\").",
      "Number \"40%\" in a Brinepool Analytics bullet does not appear in your master resume.",
      "Voice: \"I am passionate about leveraging\" reads like AI boilerplate. Say what you did instead.",
      "Voice: \"thrilled to\" in the cover letter is a stock phrase recruiters skim past.",
    ],
    createdAt: iso(5),
    screenshot: shot("plumewick", { company: "Plumewick", title: "Senior Product Manager, Platform", accent: "#2f6f5e", fields: [...COMMON_FIELDS,
      { label: "Are you legally authorized to work in the United States?", value: "Yes", select: true, req: true },
      { label: "Will you now or in the future require sponsorship?", value: "No", select: true, req: true },
      { label: "Why do you want to work at Plumewick?", long: true, req: true, value: "Your customers run research where losing the thread has real costs, and the Platform area is where that reliability starts. I have spent three years making a data platform feel like a product, and I want to do that for a team whose users are researchers." },
      { label: "What is your desired salary?", value: "$200,000 base, flexible on the mix with equity" },
    ] }),
  };
  app("plumewick", "filled", 1.2, { confirmationCode: "FN-48213" });
  fill("plumewick", 1.25);
  ev("plumewick", 6, "status", "saved");
  ev("plumewick", 5, "pack", "Pack saved: resume.pdf, cover-letter.pdf, 6 answers, 2 warnings");
  ev("plumewick", 5, "status", "drafted");
  ev("plumewick", 1.25, "fill", JSON.stringify({ filled: 13, skipped: 0, screenshot: "plumewick-7012345.png" }));
  ev("plumewick", 1.2, "status", "filled");

  // Tindlow: filled, clean.
  packs[jid("tindlowhealth")] = {
    jobId: jid("tindlowhealth"),
    resume: tailored({ top: { headline: "Product leader for regulated, consumer-grade experiences" } }),
    coverLetter: `Hello Tindlow team,

Care navigation is a scheduling problem wrapped around a trust problem, and I have worked on both halves. At Farrowmere Bank I owned an account opening flow inside a heavily regulated process and reduced abandonment 22%. At Brinepool Analytics I led a platform through general availability with 310 customer workspaces.

I would like to bring that mix of patience with compliance and impatience with friction to your patients and care teams.

Jordan Reyes`,
    answers: {
      "Are you authorized to work in the US?": "Yes",
      "Do you require visa sponsorship?": "No",
      "Describe a product you led through a platform migration.": "At Tinthread I replaced CSV imports with a guided sync built on our new integrations API. We migrated every active customer over two quarters with a dual-run period, which cut median onboarding from 9 days to 3.",
      "Location": "Brooklyn, NY",
    },
    resumePdf: "resume.pdf",
    coverLetterPdf: "cover-letter.pdf",
    warnings: [],
    createdAt: iso(9),
    screenshot: shot("tindlowhealth", { company: "Tindlow Health", title: "Product Lead, Care Navigation", accent: "#3b5bdb", fields: [...COMMON_FIELDS,
      { label: "Are you authorized to work in the US?", value: "Yes", select: true, req: true },
      { label: "Do you require visa sponsorship?", value: "No", select: true, req: true },
      { label: "Describe a product you led through a platform migration.", long: true, req: true, value: "At Tinthread I replaced CSV imports with a guided sync built on our new integrations API. We migrated every active customer over two quarters with a dual-run period, which cut median onboarding from 9 days to 3." },
    ] }),
  };
  app("tindlowhealth", "filled", 3, { confirmationCode: "HH-90117" });
  fill("tindlowhealth", 3.1);
  ev("tindlowhealth", 10, "status", "drafted");
  ev("tindlowhealth", 3.1, "fill", JSON.stringify({ filled: 11, skipped: 0, screenshot: "tindlowhealth-b1e6c0a2.png" }));
  ev("tindlowhealth", 3, "status", "filled");

  // Vantrell: filled, one required question the pack never had is blank on the form.
  packs[jid("vantrell")] = {
    jobId: jid("vantrell"),
    resume: tailored({ top: { headline: "Senior Product Manager, growth and monetization" } }),
    coverLetter: `Dear Vantrell hiring team,

I rebuilt usage-based pricing at Brinepool Analytics with finance and sales, and expansion revenue grew 18% year over year. The part I enjoyed most was the experiment design underneath it. I would love to run the free-to-paid funnel at Vantrell.

Jordan Reyes`,
    answers: {
      "Are you able to work from our New York office three days a week?": "Yes",
      "Tell us about an experiment that changed your mind.": "We expected annual-plan discounts to lift conversion. A two-week test showed they mostly shifted existing monthly buyers, so we moved the discount to the expansion step instead.",
      "Will you require sponsorship?": "No",
    },
    resumePdf: "resume.pdf",
    coverLetterPdf: "cover-letter.pdf",
    warnings: [],
    createdAt: iso(26),
    screenshot: shot("vantrell", { company: "Vantrell", title: "Senior Product Manager, Growth", accent: "#6d28d9", fields: [...COMMON_FIELDS,
      { label: "Are you able to work from our New York office three days a week?", value: "Yes", select: true, req: true },
      { label: "Tell us about an experiment that changed your mind.", long: true, req: true, value: "We expected annual-plan discounts to lift conversion. A two-week test showed they mostly shifted existing monthly buyers, so we moved the discount to the expansion step instead." },
      { label: "Will you require sponsorship?", value: "No", select: true, req: true },
      { label: "In 1-2 sentences, what's the most complex thing you've done with SQL, APIs, or scripting?", value: "", req: true },
    ] }),
  };
  app("vantrell", "filled", 20, { confirmationCode: "PX-55620" });
  fill("vantrell", 20.2);
  ev("vantrell", 27, "status", "drafted");
  ev("vantrell", 20.2, "fill", JSON.stringify({ filled: 10, skipped: 1, screenshot: "vantrell-4f0c2d.png" }));
  ev("vantrell", 20, "status", "filled");

  // Other pipeline states.
  packs[jid("dravellefreight")] = { jobId: jid("dravellefreight"), resume: tailored({}), coverLetter: "Dear Dravelle Freight team,\n\nI would like to help carriers spend less time on the phone.\n\nJordan Reyes", answers: { "Are you authorized to work in the US?": "Yes", "Why do you want to work at Dravelle Freight?": "TODO (you): one specific, true reason.", "What is your desired salary?": "TODO (you): a number or a range" }, resumePdf: "resume.pdf", coverLetterPdf: "cover-letter.pdf", warnings: [], createdAt: iso(4) };
  app("dravellefreight", "drafted", 4);
  ev("dravellefreight", 4, "status", "drafted");
  packs[jid("quorrim")] = { jobId: jid("quorrim"), resume: tailored({}), coverLetter: "Hello Quorrim,\n\nDeveloper experience is where I do my best work.\n\nJordan Reyes", answers: { "What is your desired salary?": "TODO (you): a number or a range", "Are you willing to work from our Austin office three days a week?": "" }, resumePdf: "resume.pdf", coverLetterPdf: "cover-letter.pdf", warnings: ["Skill \"Kubernetes\" is not in your master resume.", "Voice: \"a proven track record of driving impact\" sounds generated. Name the result."], createdAt: iso(2) };
  app("quorrim", "drafted", 2);
  ev("quorrim", 2, "status", "drafted");
  app("carrowick", "saved", 7, { notes: "Ask about the automation builder roadmap" });
  ev("carrowick", 7, "status", "saved");
  app("brackenfold", "saved", 50);
  ev("brackenfold", 50, "status", "saved");
  app("yarrowby", "approved", 0.6);
  ev("yarrowby", 0.6, "status", "approved");
  app("hexmoorsecurity", "needs_human", 30, { notes: "hCaptcha on submit. Finish in the open browser window." });
  ev("hexmoorsecurity", 30, "captcha", "hCaptcha detected on submit; browser left open for you");
  ev("hexmoorsecurity", 30, "status", "needs_human");
  app("oxbury", "submitted", 96, { submittedAt: iso(96) });
  ev("oxbury", 96, "status", "submitted");
  app("ohmsteadgrid", "submitted", 28, { submittedAt: iso(28) });
  ev("ohmsteadgrid", 28, "status", "submitted");
  app("dunmorrow", "interview", 70, { notes: "Recruiter screen Thursday 2pm" });
  ev("dunmorrow", 70, "status", "interview");
  app("wrenlowbio", "rejected", 150);
  ev("wrenlowbio", 150, "status", "rejected");
  app("tollgrove", "ghosted", 380);
  ev("tollgrove", 380, "status", "ghosted");
  for (const r of HISTORY) apps[r.id] = { jobId: r.id, status: r.status, submittedAt: r.appliedAt, createdAt: iso(3), updatedAt: iso(3), source: "history" };

  return {
    profile: structuredClone(PROFILE),
    resume: structuredClone(RESUME),
    packs, apps, fills, events, eid,
    sync: { running: false, lastReport: { boards: 2340, ok: 2318, failed: 9, notFound: ["lever:oldco", "greenhouse:defunct"], jobsSeen: 14420, newJobs: 212, closed: 87, feeds: { remoteok: 96, remotive: 41, hn: 310, himalayas: 58 }, ms: 184000 } },
    lastSync: iso(7.5),
    outreach: [
      { id: 1, company: "Plumewick", jobId: jid("plumewick"), person: "Priya Natarajan", role: "hiring manager", channel: "email", contact: "priya@plumewick.example", message: "Short note on your Platform PM role, with a teardown of your admin console.", sentAt: iso(24 * 8), status: "no_reply", followUps: 1, lastTouchAt: iso(24 * 8) },
      { id: 2, company: "Quorrim", jobId: jid("quorrim"), person: "Marcus Bell", role: "recruiter", channel: "linkedin", sentAt: iso(24 * 9), status: "sent", followUps: 0, lastTouchAt: iso(24 * 9) },
      { id: 3, company: "Tindlow Health", jobId: jid("tindlowhealth"), person: "Dana Whitfield", role: "founder", channel: "x", sentAt: iso(24 * 12), status: "replied", followUps: 1, lastTouchAt: iso(24 * 2), notes: "Said to apply and mention her name" },
      { id: 4, company: "Dunmorrow", jobId: jid("dunmorrow"), person: "Leo Martins", role: "hiring manager", channel: "intro", sentAt: iso(24 * 15), status: "meeting", followUps: 2, lastTouchAt: iso(24 * 3), notes: "Screen Thursday 2pm" },
      { id: 5, company: "Carrowick", jobId: jid("carrowick"), person: "Ava Chen", role: "engineer", channel: "email", sentAt: iso(24 * 7.5), status: "sent", followUps: 0, lastTouchAt: iso(24 * 7.5) },
      { id: 6, company: "Dravelle Freight", jobId: jid("dravellefreight"), person: "Sam Ortiz", role: "recruiter", channel: "linkedin", sentAt: iso(24 * 3), status: "sent", followUps: 0, lastTouchAt: iso(24 * 3) },
      { id: 7, company: "Mirefield", person: "Hannah Reiss", role: "recruiter", channel: "email", sentAt: iso(24 * 40), status: "closed", followUps: 3, lastTouchAt: iso(24 * 20), notes: "Role filled internally" },
    ],
  };
}

// ---- router ------------------------------------------------------------------

const STATUSES = ["saved", "drafted", "filled", "approved", "submitted", "needs_human", "interview", "offer", "rejected", "withdrawn", "ghosted"];
// prior.ts in miniature: same role = at least 60% of title words shared, level words and filler ignored.
const SKIP = new Set(["senior", "sr", "staff", "principal", "lead", "junior", "jr", "associate", "intern", "the", "a", "an", "of", "and", "for", "to", "at", "in"]);
const words = (t) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !SKIP.has(w)).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w)));
function similarTitle(a, b) {
  const x = words(a), y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return x.size > 0 && y.size > 0 && shared / (x.size + y.size - shared) >= 0.6;
}
const trunc = (j) => ({ ...j, description: j.description.length > 400 ? j.description.slice(0, 400) + "…" : j.description });
const ageDays = (j) => (Date.now() - Date.parse(j.postedAt || j.firstSeen)) / 864e5;
const textHit = (j, q) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${j.title} ${j.company} ${j.location} ${j.description}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};

export function createDemo() {
  const S = buildState();
  // Which filled forms this (pretend) dashboard still holds open: only those submit on Approve.
  const held = new Set([jid("plumewick")]);
  const runs = {};
  const counts = () => Object.fromEntries(STATUSES.map((s) => [s, Object.values(S.apps).filter((a) => a.status === s).length]));
  const missing = () => {
    const m = [];
    const p = S.profile;
    if (!p.salaryExpectation) m.push("salaryExpectation");
    if (!p.noticePeriod) m.push("noticePeriod");
    if (!p.phone) m.push("phone");
    return m;
  };
  const addEvent = (jobId, kind, detail) => S.events.push({ id: S.eid++, jobId, at: new Date().toISOString(), kind, detail });
  const setStatus = (jobId, status, extra = {}) => {
    const t = new Date().toISOString();
    const prev = S.apps[jobId];
    S.apps[jobId] = { jobId, status: "saved", createdAt: t, ...prev, ...extra, status, updatedAt: t };
    if (!prev || prev.status !== status) addEvent(jobId, "status", status);
    return S.apps[jobId];
  };
  const err = (status, message, data) => { const e = new Error(message); e.status = status; e.data = data; throw e; };
  /** priorApplications + warning, as every job surface carries them. */
  function priorFields(job) {
    const applied = (a) => a.submittedAt || ["submitted", "interview", "offer", "rejected", "ghosted"].includes(a.status);
    const priors = Object.values(S.apps)
      .filter((a) => a.jobId !== job.id && applied(a) && byId(a.jobId).company === job.company)
      .map((a) => { const j = byId(a.jobId); return { jobId: a.jobId, company: j.company, title: j.title, status: a.status, appliedAt: a.submittedAt || a.updatedAt, similarTitle: similarTitle(j.title, job.title), imported: a.source === "history" }; })
      .sort((x, y) => Number(y.similarTitle) - Number(x.similarTitle) || y.appliedAt.localeCompare(x.appliedAt));
    const warning = priors.map((p) => `Already applied to ${p.company} · ${p.title} on ${p.appliedAt.slice(0, 10)}`).join("; ");
    return warning ? { priorApplications: priors, warning } : { priorApplications: priors };
  }

  const days = (t) => Math.floor((Date.now() - Date.parse(t)) / 864e5);
  function followups() {
    return S.outreach
      .filter((o) => (o.status === "sent" || o.status === "no_reply") && days(o.lastTouchAt) >= 7)
      .map((o) => ({ ...o, daysSinceTouch: days(o.lastTouchAt), suggestion: o.followUps === 0
        ? `Send a short nudge to ${o.person.split(" ")[0]} with one new piece of proof, like a teardown or a small prototype.`
        : `Second nudge: reference something ${o.company} shipped this week and ask one specific question.` }))
      .sort((a, b) => b.daysSinceTouch - a.daysSinceTouch);
  }
  function intel(id) {
    const job = byId(id);
    if (!job) err(404, "No job with that id");
    const seed = [...job.company].reduce((n, c) => n + c.charCodeAt(0), 0);
    const open = 8 + (seed % 30);
    return {
      signals: {
        openRoles: open, newLast30d: 3 + (seed % 9), closedLast30d: 1 + (seed % 4),
        byDepartment: { Engineering: Math.round(open * 0.5), Product: 2 + (seed % 3), Design: 1 + (seed % 2), "Go to market": Math.round(open * 0.2), Operations: 1 },
        remoteShare: job.remote ? 0.7 : 0.15,
        seniorityMix: { senior: 0.55, mid: 0.3, lead: 0.15 },
        notes: [`${job.company} opened ${3 + (seed % 9)} roles in the last 30 days, mostly engineering.`, "First product hire in this area in over a year."],
      },
      whyNow: [
        `Engineering hiring is up sharply, so ${job.company} likely needs product leadership to keep a growing team pointed at the right problems.`,
        "The posting mentions enterprise controls, which usually means larger deals are stalling on security review.",
      ],
      proofOfWorkIdeas: [
        `A one-page teardown of ${job.company}'s onboarding with three specific fixes.`,
        "A short Loom walking through how you would sequence the first 90 days.",
        "A mock admin console permission model, one Figma frame.",
      ],
      questionsToAsk: [
        "Which deals are blocked today, and on what?",
        "What would make this hire a clear success after six months?",
        "Who owns the API roadmap now?",
      ],
    };
  }

  // GET /api/scoreboard: a made-up strategy three weeks in, with every date counted from today.
  function scoreboard() {
    const d = (daysAgo) => day(24 * daysAgo);
    const targets = { warmAsks: 4, applications: 5 };
    const wk = (week, startAgo, o) => ({ week, start: d(startAgo), end: d(startAgo - 6), current: false, warmAsks: 0, applications: 0, firstConversations: 0,
      firstConversationsBooked: 0, roundsPassed: 0, possibleRounds: 0, targets, halved: false, slipped: false, ...o });
    const weeks = [
      wk(1, 16, { warmAsks: 4, applications: 5, firstConversations: 1 }),
      wk(2, 9, { warmAsks: 3, applications: 5, firstConversations: 1, slipped: true }),
      wk(3, 2, { current: true, warmAsks: 2, applications: 3, firstConversations: 2, firstConversationsBooked: 1, roundsPassed: 1, slipped: null }),
    ];
    const lead = (slug, o) => { const j = byId(jid(slug)); return { company: j.company, seat: `${j.title}, ${j.location}`, applied: false, inProcess: false, asked: false, ...o }; };
    const milestone = (daysAhead, title, doneMeans, gate = false) => ({ date: d(-daysAhead), title, doneMeans, gate, daysLeft: daysAhead, state: daysAhead < 0 ? "past" : daysAhead === 0 ? "today" : "ahead" });
    return {
      today: d(0), generatedAt: iso(0), timeZone: "America/New_York", leadLane: "Senior product roles at B2B software companies", source: "Demo strategy",
      week: weeks[2], weeks,
      halving: { threshold: 3, submittedByWeek1: 4, decided: true, halved: false },
      personFlags: [
        { jobId: jid("yarrowby"), company: "Yarrowby", title: "Senior Product Manager, Billing", submittedAt: iso(20), hoursElapsed: 20, state: "due", hoursLeft: 28 },
        { jobId: jid("dravellefreight"), company: "Dravelle Freight", title: "Senior Product Manager, Carrier Platform", submittedAt: iso(24 * 4), hoursElapsed: 96, state: "sent_late", sentLate: { person: "Sam Ortiz", sentAt: iso(24 * 1) } },
      ],
      followUpsDue: [
        { id: 2, person: "Marcus Bell", role: "recruiter", company: "Quorrim", channel: "linkedin", daysSinceTouch: 9, followUps: 0, dueSince: d(2), suggestion: "One line: still interested, and one new thing you shipped since the first note." },
      ],
      companies: [
        lead("plumewick", { path: "Priya Natarajan, hiring manager", firstMove: "Send the note with the pricing teardown attached.", applied: true, appliedAt: iso(24 * 6), applicationStatus: "interview", inProcess: true,
          asked: true, personNamed: { id: 1, person: "Priya Natarajan", role: "hiring manager", sent: true, onHold: false }, lastTouch: iso(24 * 2), nextConversation: d(-2), nextAction: `Prepare for the conversation on ${d(-2)}.` }),
        lead("tindlowhealth", { path: "Dana Whitfield, founder", applied: true, appliedAt: iso(24 * 13), applicationStatus: "submitted", asked: true,
          personNamed: { id: 3, person: "Dana Whitfield", role: "founder", sent: true, onHold: false }, lastTouch: iso(24 * 2), nextAction: "Reply to Dana and offer two times." }),
        lead("quorrim", { path: "Marcus Bell, recruiter", applied: true, appliedAt: iso(24 * 10), applicationStatus: "submitted", asked: true,
          personNamed: { id: 2, person: "Marcus Bell", role: "recruiter", sent: true, onHold: false }, lastTouch: iso(24 * 9), nextAction: "Follow up with Marcus Bell (9 days since the first note)." }),
        lead("vantrell", { firstMove: "Apply, then one note to the growth lead.", applicationStatus: "drafted", nextAction: "Finish the pack and apply." }),
        lead("brackenfold", { path: "A former teammate works on Search", firstMove: "Ask for the intro before applying.", nextAction: "Ask for the intro before applying." }),
      ],
      bench: ["Carrowick", "Dunmorrow", "Ohmstead Grid"],
      upcoming: [{ jobId: jid("plumewick"), company: "Plumewick", title: "Senior Product Manager, Platform", date: d(-2), scheduled: true, first: false, round: 2, recorded: d(1) }],
      liveProcesses: [
        { jobId: jid("plumewick"), company: "Plumewick", title: "Senior Product Manager, Platform", status: "interview", lastActivity: iso(24 * 2) },
        { jobId: jid("dunmorrow"), company: "Dunmorrow", title: "Senior Product Manager, Payments", status: "interview", lastActivity: iso(24 * 3) },
      ],
      totals: { warmAsks: 9, applications: 13, firstConversations: 3, pastFirstScreen: 1, possibleRounds: 0 },
      gate: { date: d(-12), daysLeft: 12, reached: false, liveProcesses: 2, threshold: 3, verdict: "widen",
        action: "Widen to adjacent seats and the bench, and keep both live processes moving.",
        progress: { firstConversations: { actual: 3, target: 6 }, pastFirstScreen: { actual: 1, target: 2 }, warmAsks: { actual: 9, target: 16 }, applications: { actual: 13, target: 20 } } },
      milestones: [
        milestone(-9, "Resume and story settled", "Master resume corrected; the two-minute story written down"),
        milestone(-3, "All five applied or asked", "Each lead company has an application or a named person"),
        milestone(2, "Second round at Plumewick", "Case notes ready; three questions for the hiring manager"),
        milestone(12, "Decision gate", "Target: 6 first conversations, 2 processes past the first screen", true),
        milestone(26, "Last working week of the year", "Every live process at a final round or offer"),
      ],
      warnings: [],
    };
  }

  function handle(method, rawPath, body) {
    const u = new URL(rawPath, "http://demo.local");
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams);
    const m = p.match(/^\/api\/jobs\/([^/]+)(?:\/(save|status|approve|pack|draft|fill|refill))?$/);

    if (method === "GET" && p === "/api/scoreboard") return scoreboard();
    if (method === "GET" && p === "/api/stats") {
      return { jobs: { open: 14286, total: 15903, companies: 1912, boards: 2340, lastSync: S.lastSync }, profile: { hasProfile: true, hasResume: true, missing: missing() }, pipeline: counts() };
    }
    if (method === "GET" && p === "/api/jobs") {
      let list = JOBS.filter((j) => j.open);
      if (q.q) list = list.filter((j) => textHit(j, q.q));
      if (q.location) list = list.filter((j) => j.location.toLowerCase().includes(q.location.toLowerCase()));
      if (q.company) list = list.filter((j) => j.company.toLowerCase().includes(q.company.toLowerCase()));
      if (q.remote === "1") list = list.filter((j) => j.remote);
      if (q.days) list = list.filter((j) => ageDays(j) <= Number(q.days));
      list.sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
      const off = Number(q.offset || 0), lim = Number(q.limit || 20);
      return { total: list.length, jobs: list.slice(off, off + lim).map((j) => ({ ...trunc(j), ...priorFields(j) })) };
    }
    if (method === "GET" && p === "/api/matches") {
      let list = MATCHES.map(([slug, score, reasons]) => ({ job: trunc(byId(jid(slug))), score, reasons, ...priorFields(byId(jid(slug))) }));
      if (q.q) list = list.filter((r) => textHit(byId(r.job.id), q.q));
      if (q.days) list = list.filter((r) => ageDays(r.job) <= Number(q.days));
      return list.slice(0, Number(q.limit || 50));
    }
    if (method === "GET" && p === "/api/pipeline") {
      const items = Object.values(S.apps).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((a) => ({ ...a, job: byId(a.jobId), held: held.has(a.jobId), ...priorFields(byId(a.jobId)) }));
      return { counts: counts(), recent: [...S.events].sort((a, b) => b.id - a.id).slice(0, 40), items };
    }
    if (method === "GET" && p === "/api/browser") return { up: true, port: 9333 };
    if (method === "GET" && p === "/api/todos") {
      // mirrors the server: TODO or blank answers in saved and drafted packs, grouped by question text
      const groups = new Map();
      for (const a of Object.values(S.apps).filter((x) => ["saved", "drafted"].includes(x.status))) {
        const pk = S.packs[a.jobId];
        if (!pk) continue;
        const j = byId(a.jobId);
        const todo = Object.entries(pk.answers).filter(([, v]) => /\btodo \([^()\n]{1,30}\)/i.test(v) || !String(v ?? "").trim());
        if (pk.coverLetter && /\btodo \([^()\n]{1,30}\)/i.test(pk.coverLetter)) todo.push(["Cover letter", pk.coverLetter]);
        for (const [q, v] of todo) {
          if (!groups.has(q)) groups.set(q, q === "Cover letter" ? { question: q, cover: true, jobs: [] } : { question: q, jobs: [] });
          groups.get(q).jobs.push({ jobId: a.jobId, company: j.company, title: j.title, current: v });
        }
      }
      return [...groups.values()].sort((x, y) => y.jobs.length - x.jobs.length || x.question.localeCompare(y.question));
    }
    const rm = p.match(/^\/api\/jobs\/([^/]+)\/run$/);
    if (method === "GET" && rm) { const id = decodeURIComponent(rm[1]); return { run: runs[id] ?? null, status: S.apps[id]?.status ?? null }; }
    if (m) {
      const id = decodeURIComponent(m[1]);
      const job = byId(id);
      if (!job) err(404, "No job with that id");
      if (method === "GET" && !m[2]) {
        // mirrors track.currentFill: only the fill awaiting approval
        const fill = ["filled", "approved"].includes(S.apps[id]?.status) ? S.fills[id] : undefined;
        return { job, application: S.apps[id], pack: S.packs[id], fill, held: held.has(id), events: S.events.filter((e) => e.jobId === id).sort((a, b) => b.id - a.id), website: WEBSITES[job.boardSlug], ...priorFields(job) };
      }
      if (method === "POST" && (m[2] === "draft" || m[2] === "fill")) {
        // mirrors prior.assertNotDuplicate: the same role already went in under another job id
        const dupes = priorFields(job).priorApplications.filter((x) => x.similarTitle);
        if (dupes.length && body?.force !== true) err(409, `${dupes.map((x) => `Already applied to ${x.company} · ${x.title} on ${x.appliedAt}`).join("; ")}. Pass force:true to apply anyway.`, { priorApplications: dupes });
        err(400, "The demo does not draft or fill. Start OpenApply to run it for real.");
      }
      if (method === "POST" && m[2] === "refill") {
        // mirrors the server: only a filled or approved form is voided; a submitted one never goes back to drafted
        const st = S.apps[id]?.status;
        if (st !== "filled" && st !== "approved") err(409, `Cannot re-fill ${id}: status is ${st ? `"${st}"` : "none"}, expected "filled" or "approved".`);
        delete S.apps[id].confirmationCode; delete S.fills[id];
        return setStatus(id, "drafted");
      }
      if (method === "POST" && m[2] === "save") return setStatus(id, S.apps[id]?.status || "saved", body?.notes ? { notes: body.notes } : {});
      if (method === "POST" && m[2] === "status") {
        if (!STATUSES.includes(body?.status)) err(400, "Unknown status");
        if (body.note) addEvent(id, "note", body.note);
        return setStatus(id, body.status, body.status === "submitted" ? { submittedAt: new Date().toISOString() } : {});
      }
      if (method === "PUT" && m[2] === "pack") {
        const pk = S.packs[id];
        if (!pk) err(400, `No pack for ${id}`);
        // mirrors tailor.updatePack: no edits once submitted, a filled form is voided, only the pack's own questions
        const st = S.apps[id]?.status;
        if (st && !["saved", "drafted", "filled", "approved"].includes(st)) err(400, `Cannot edit ${id}: already ${st}`);
        const unknown = Object.keys(body?.answers || {}).filter((q) => !Object.hasOwn(pk.answers, q));
        if (unknown.length) err(400, `Cannot edit ${id}: not a question in this pack: ${unknown.join(", ")}`);
        if (st === "filled" || st === "approved") { delete S.apps[id].confirmationCode; delete S.fills[id]; setStatus(id, "drafted"); }
        Object.assign(pk.answers, body?.answers || {});
        if (typeof body?.coverLetter === "string") {
          const letter = body.coverLetter.trim();
          if (letter) pk.coverLetter = letter;
          else { delete pk.coverLetter; delete pk.coverLetterPdf; }
        }
        pk.updatedAt = new Date().toISOString();
        addEvent(id, "pack", "Edited in dashboard");
        const unfinished = (a) => /\btodo \([^()\n]{1,30}\)/i.test(a) || !String(a ?? "").trim();
        const todos = Object.entries(pk.answers).filter(([, a]) => unfinished(a)).map(([k]) => k);
        if (pk.coverLetter && /\btodo \([^()\n]{1,30}\)/i.test(pk.coverLetter)) todos.push("Cover letter");
        return { pack: pk, todos, status: S.apps[id]?.status ?? null };
      }
      if (method === "POST" && m[2] === "approve") {
        const cur = S.apps[id]?.status;
        if (cur !== "filled") err(409, `Can only approve a filled application (this one is ${cur || "not started"}).`);
        const blanks = S.fills[id]?.blanks || [];
        if (blanks.length) err(400, `Cannot approve ${id}: required fields are blank on the form: ${blanks.join(", ")}`);
        const app = setStatus(id, "approved");
        if (!held.has(id)) return { ...app, held: false };
        // the held form: the dashboard presses Submit and the run settles a moment later
        const t = new Date().toISOString();
        runs[id] = { kind: "submit", state: "running", startedAt: t };
        setTimeout(() => { held.delete(id); setStatus(id, "submitted", { submittedAt: new Date().toISOString() }); runs[id] = { ...runs[id], state: "done", endedAt: new Date().toISOString() }; }, 1800);
        return { ...app, held: true, run: runs[id] };
      }
    }
    if (method === "GET" && p === "/api/outreach") return [...S.outreach].sort((a, b) => b.lastTouchAt.localeCompare(a.lastTouchAt));
    if (method === "GET" && p === "/api/followups") return followups();
    const om = p.match(/^\/api\/outreach\/(\d+)$/);
    if (method === "POST" && om) {
      const o = S.outreach.find((x) => x.id === Number(om[1]));
      if (!o) err(404, "No outreach with that id");
      const t = new Date().toISOString();
      if (body?.status) o.status = body.status;
      if (body?.followedUp) { o.followUps += 1; o.lastTouchAt = t; }
      if (body?.notes) o.notes = body.notes;
      return o;
    }
    const im = p.match(/^\/api\/intel\/([^/]+)$/);
    if (method === "GET" && im) return intel(decodeURIComponent(im[1]));
    if (method === "GET" && p === "/api/profile") return { profile: S.profile, resume: S.resume, status: { hasProfile: true, hasResume: true, missing: missing() } };
    if (method === "PUT" && p === "/api/profile") {
      const b = body || {};
      S.profile = { ...S.profile, ...b, targets: { ...S.profile.targets, ...(b.targets || {}) }, eeo: { ...S.profile.eeo, ...(b.eeo || {}) }, savedAnswers: { ...S.profile.savedAnswers, ...(b.savedAnswers || {}) } };
      return S.profile;
    }
    if (p === "/api/sync") {
      if (method === "POST") {
        if (!S.sync.running) {
          S.sync.running = true;
          setTimeout(() => {
            S.sync.running = false;
            S.lastSync = new Date().toISOString();
            S.sync.lastReport = { ...S.sync.lastReport, newJobs: 37, closed: 12, ms: 2600 };
          }, 2600);
        }
        return { started: true };
      }
      return { running: S.sync.running, lastReport: S.sync.lastReport };
    }
    err(404, `Demo has no route for ${method} ${p}`);
  }

  return {
    async request(method, path, body) {
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
      return structuredClone(handle(method, path, body));
    },
  };
}
