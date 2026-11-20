/**
 * Every page Konium Designer writes (a report, a print) is a page of text and pictures, and this
 * tells the browser so: nothing in it may run as a script, and nothing may be fetched from
 * outside it. Such a page is opened by the program and so has the program's own standing in the
 * browser; whatever a file's own words turn out to hold, they stay words.
 */
export const NO_SCRIPT = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A report as an HTML page: its title, then the text as it is (Preferences › PCB Editor › Reports › Format: HTML). */
export const reportHtml = (title: string, text: string): string =>
  `<!doctype html>\n<html lang="en-GB"><head><meta charset="utf-8">${NO_SCRIPT}<title>${esc(title)}</title></head><body>\n<h1>${esc(title)}</h1>\n<pre>${esc(text)}</pre>\n</body></html>\n`;
