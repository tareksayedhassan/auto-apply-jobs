export const USER_AGENT = "OpenApply/0.1 (+https://github.com/nturl/openapply)";

export class NotFoundError extends Error {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** GET JSON with a timeout, retries with backoff on 429/5xx/network errors, and NotFoundError on 404. */
export async function getJson<T>(
  url: string,
  opts: { timeoutMs?: number; retries?: number; headers?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const { timeoutMs = 20_000, retries = 2, headers = {}, body } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let wait = 500 * 2 ** attempt;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) throw new NotFoundError(`404 ${url}`);
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        if (ra > 0) wait = Math.min(ra * 1000, 10_000);
        lastErr = new Error(`HTTP ${res.status} ${url}`);
      } else if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} ${url}`, res.status);
      } else {
        return (await res.json()) as T;
      }
    } catch (e) {
      if (e instanceof NotFoundError || e instanceof HttpError) throw e;
      lastErr = e;
    }
    if (attempt < retries) await sleep(wait);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** A non-retryable HTTP failure (4xx other than 404/429). */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** The array a board API must return; anything else is a broken response, not an empty board. */
export function expectArray<T = any>(v: unknown): T[] {
  if (!Array.isArray(v)) throw new Error("unexpected response shape");
  return v as T[];
}

/** Flag a fetched list as cut short (non-enumerable, so it never leaks into JSON); sync then skips closing jobs. */
export function markTruncated<T extends unknown[]>(list: T): T {
  Object.defineProperty(list, "truncated", { value: true, enumerable: false });
  return list;
}

export const isTruncated = (list: unknown[]): boolean => (list as { truncated?: boolean }).truncated === true;

/** Map items, skipping any that throw or return undefined, so one bad posting never sinks a board. */
export function mapSafe<I, O>(items: unknown, fn: (item: I) => O | undefined): O[] {
  if (!Array.isArray(items)) return [];
  const out: O[] = [];
  for (const it of items as I[]) {
    try { const v = fn(it); if (v !== undefined) out.push(v); } catch { /* garbage posting: skip */ }
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
