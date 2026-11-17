/** Shared escaping and base CSS so the resume and cover letter look like one set. */
export const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const href = (link: string): string => (/^(https?:|mailto:)/i.test(link) ? link : `https://${link}`);

export const BASE_CSS = `
@page { size: Letter; margin: 0.45in; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 10pt/1.3 "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; color: #1a1a1a; }
a { color: inherit; text-decoration: none; }
h1 { margin: 0; font-size: 21pt; font-weight: 600; letter-spacing: -0.01em; line-height: 1.1; }
.headline { margin: 3pt 0 0; font-size: 10.5pt; color: #444; }
.contact { margin: 5pt 0 0; font-size: 9pt; color: #555; }
.contact span + span::before { content: "\\00B7"; margin: 0 6pt; color: #999; }
header { padding-bottom: 7pt; border-bottom: 1.2pt solid #1a1a1a; }
`;
