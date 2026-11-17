/** Import first in tests that touch jobs: only loopback fetches go out, real job boards fail like a dropped network. */
const real = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  return /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url) ? real(input, init) : Promise.reject(new TypeError(`fetch failed (offline in tests): ${url}`));
}) as typeof fetch;
