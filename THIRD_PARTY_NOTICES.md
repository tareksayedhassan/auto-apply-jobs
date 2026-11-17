# Third-party notices

OpenApply is MIT licensed (see LICENSE). It includes or derives from the following third-party material.

## sb2nov/resume

`templates/cover-letter.tex` reuses the LaTeX preamble, margins and name header of Sourabh Bajaj's resume template, so a letter made here matches a resume built on that template.

- Source: https://github.com/sb2nov/resume
- License: MIT

    The MIT License (MIT)

    Copyright (c) 2026 Sourabh Bajaj

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## Feashliaa/job-board-aggregator

`scripts/seed-candidates/public-slug-lists.json` is the set of company board slugs (Greenhouse, Lever, Ashby and others) published by this project. They are candidates only: `scripts/seed-boards.ts` probes each one against the ATS's public API and `data/boards.json` keeps the ones that answered with open roles.

- Source: https://github.com/Feashliaa/job-board-aggregator
- License: MIT

    MIT License

    Copyright (c) 2026 Riley Dorrington

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## Other seed lists (names and facts, no license claimed)

These files feed `scripts/seed-boards.ts` as candidate company names. They hold only company names and public websites, and the bundled `data/boards.json` is built from the public API answers, not from these lists.

- `scripts/seed-candidates/yc.json`: names and websites of Y Combinator companies, from YC's public company directory (https://www.ycombinator.com/companies).
- `scripts/seed-candidates/portfolios-and-lists.txt`: company names written by hand from public lists (Forbes AI 50, venture firm portfolio pages, Built In and Inc rankings).
- `scripts/seed-candidates/wellknown.txt`: well-known company names written by hand.

## Public API samples

`test/fixtures/sources/*` holds trimmed responses captured from public job-board APIs and feeds, kept as offline test fixtures. Company names and job text in them belong to their respective owners. The HTML forms in `test/fixtures/ats/` are hand-built stand-ins that mirror the layout of the real application pages.
