/**
 * One task per job at a time, in call order: form inspect/fill/submit and pack writes on the same job
 * never interleave, so a re-fill can't race a submit and two pack edits can't overwrite each other.
 */
const locks = new Map<string, Promise<unknown>>();
export function exclusive<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(jobId) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(jobId, run);
  return run;
}
