import { makeAdapter } from "./common.js";

/** Any other form: label[for] / aria-label / placeholder discovery on the biggest form. Best effort. */
export const generic = makeAdapter({
  name: "generic",
  matches: () => true,
  scan: {
    root: "form",
    container: "fieldset, .form-group, .field, .form-field, li",
    labelSel: "",
  },
  submitSel: 'form button[type="submit"], form input[type="submit"], button:has-text("Submit")',
});
