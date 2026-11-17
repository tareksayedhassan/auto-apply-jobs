/** Evidence-based screening, not a determination of immigration eligibility. */
export type Decision = 'CONFIRMED_ELIGIBLE' | 'POTENTIALLY_ELIGIBLE' | 'NEEDS_VERIFICATION' | 'INELIGIBLE';
export type Finding = 'met' | 'unknown' | 'not_met';
export interface Evidence { dimension: 'technical' | 'education' | 'experience' | 'language' | 'authorization' | 'visa' | 'relocation' | 'nationality'; finding: Finding; quote: string; url: string; checkedAt: string; }
export interface AssessmentInput { country: string; evidence: Evidence[]; }
export interface Assessment { state: Decision; reasons: string[]; evidence: Evidence[]; assessedAt: string; }
export function assess(input: AssessmentInput): Assessment {
  const required = ['technical', 'education', 'experience', 'language', 'authorization', 'visa', 'relocation', 'nationality'] as const;
  for (const e of input.evidence) {
    if (!e.quote.trim() || !e.checkedAt || !Number.isFinite(Date.parse(e.checkedAt)) || Date.parse(e.checkedAt)>Date.now()+60000 || Date.now()-Date.parse(e.checkedAt)>30*86400000 || new URL(e.url).protocol !== 'https:') throw new Error('Evidence requires a quotation, HTTPS source and timestamp within the last 30 days');
  }
  const unmet = input.evidence.filter(e => e.finding === 'not_met');
  const unknown = required.filter(d => !input.evidence.some(e => e.dimension === d && e.finding === 'met') || input.evidence.some(e => e.dimension === d && e.finding === 'unknown'));
  const state: Decision = unmet.length ? 'INELIGIBLE' : !input.country.trim() ? 'NEEDS_VERIFICATION' : unknown.length === 0 ? 'CONFIRMED_ELIGIBLE' : input.evidence.some(e => e.dimension === 'visa' && e.finding === 'met') ? 'POTENTIALLY_ELIGIBLE' : 'NEEDS_VERIFICATION';
  return { state, reasons: [...unmet.map(e => `${e.dimension}: ${e.quote}`), ...unknown.map(d => `${d}: needs verified evidence`)], evidence: input.evidence, assessedAt: new Date().toISOString() };
}
