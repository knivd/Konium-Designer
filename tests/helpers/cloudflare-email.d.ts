/**
 * The Workers runtime's email module, as far as Konium's report Worker uses it: declared here so
 * the tests that load the Worker (with the module stood in for) type-check outside that runtime.
 */
declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
    readonly from: string;
    readonly to: string;
  }
}
