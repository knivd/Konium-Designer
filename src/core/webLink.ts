/**
 * A web address to make a link of: http or https only ('' for anything else). An address read
 * from a file or sent by a service is shown as a link only when following it can do nothing but
 * open a web page.
 */
export const webLink = (url: string | null | undefined): string => (typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim()) ? url.trim() : '');
