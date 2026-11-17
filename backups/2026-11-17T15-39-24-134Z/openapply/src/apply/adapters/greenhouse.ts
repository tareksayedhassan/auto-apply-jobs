import type { Job } from "../../types.js";
import { isGreenhouse, refineForPage } from "../detect.js";
import { makeAdapter } from "./common.js";

/**
 * Greenhouse. New boards (job-boards.greenhouse.io): .field-wrapper questions, react-select
 * comboboxes, visually hidden file inputs behind "Attach". Legacy boards: #application_form .field.
 */
export const greenhouse = makeAdapter({
  name: "greenhouse",
  matches: isGreenhouse,
  applyUrl(job: Job) {
    const native = job.id.split(":").pop();
    if (job.ats === "greenhouse" && job.boardSlug && native && /^\d+$/.test(native)) {
      return `https://job-boards.greenhouse.io/${job.boardSlug}/jobs/${native}`;
    }
    return job.applyUrl || job.url;
  },
  async prepare(page) {
    if (!isGreenhouse(page.url())) await refineForPage(page, "generic");
  },
  scan: {
    root: "#application-form, #application_form, form",
    container: ".field-wrapper, .eeoc__question__wrapper, .phone-input__country, .phone-input__phone, .file-upload, #application_form .field, fieldset",
    labelSel: ".upload-label, label.label, label.select__label, legend:not(.visually-hidden)",
    skip: ".iti__dropdown-content, .iti__search-input",
  },
  searchLabel: /^school$/i,
  submitSel: '#application-form button[type="submit"], #application_form #submit_app, button[type="submit"]',
  successSel: ".application--confirmation, #application_confirmation, [data-testid='confirmation']",
  successUrl: /\/confirmation\b|\/thank[-_]?you/i,
});
