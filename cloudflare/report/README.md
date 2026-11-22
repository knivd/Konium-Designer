# Konium bug reports (Cloudflare Worker)

(The commands are written for Windows, where `npx.cmd` is needed in PowerShell; elsewhere it is `npx`.)

Help › Report a Bug (and the Home page) posts each report to `https://konium.app/api/report`.
This Worker turns it into an email with the attachments and sends it with Cloudflare Email
Routing to one verified address, kept as a secret: the address is in neither Konium nor this code.

## Set-up (once)

1. **Domain on Cloudflare.** konium.app's DNS must be on Cloudflare (the route below and Email
   Routing need it).
2. **Email Routing.** Dashboard › konium.app › Email › Email Routing › *Enable Email Routing*
   (it adds the MX and SPF records; accept them).
3. **Destination address.** Email Routing › *Destination addresses* › *Add destination address*:
   the Gmail address the reports should reach. Gmail gets a verification email: click the link.
   The status must say *Verified*.
4. **Deploy the Worker** (Node.js installed; from this folder):
   ```
   npx.cmd wrangler login
   npx.cmd wrangler secret put REPORT_TO      # type the verified destination address
   npx.cmd wrangler deploy
   ```
   `wrangler deploy` creates the route `konium.app/api/report`. The sender is
   `reports@konium.app` (`REPORT_FROM` in `wrangler.toml`); it doesn't need to be a mailbox.
5. **Try it.** In Konium: Help › Report a Bug, send a test. It arrives from "Konium bug report",
   with Reply-To set to the reporter's address when they gave one.

6. **Reports to the AI assistant too (optional).** Each report can also be filed in a private
   GitHub repository — its text and attachments committed under `reports/<date>/<id>/`, an issue
   opened for it — where the author's AI assistant (Claude) reads and works on them.
   1. Create a **private** repository for the reports, e.g. `konium-reports` (an empty README is enough).
   2. GitHub › Settings › Developer settings › *Fine-grained tokens* › *Generate new token*:
      *Only select repositories* → the reports repository; *Repository permissions* →
      **Contents: Read and write**, **Issues: Read and write** (Metadata: read is added for you).
      Pick an expiry and put a reminder in your calendar to renew it.
   3. Set the repository in `wrangler.toml` (`REPORTS_REPO = "<you>/konium-reports"`), then:
      ```
      npx.cmd wrangler secret put GITHUB_TOKEN   # paste the token
      npx.cmd wrangler deploy
      ```
   4. Send a test report: an issue appears in the repository. The email still goes as before; a
      report is accepted when either the email or the repository takes it.
   To let the assistant read them, add the reports repository to its GitHub access (the same
   GitHub app or connector that reaches the code repository).

If the site isn't on Cloudflare, deploy without the `routes` line: the Worker gets an address
like `https://konium-report.<account>.workers.dev`; Konium's `REPORT_URL`
(`src/platform/report.ts`) must then point there.

## Limits

| What | Limit |
|---|---|
| Attachments | 10 MB together (Gmail takes 25 MB with the base64 overhead); the app sends up to 8 MB this way |
| Large attachments | over 8 MB together the app zips them: 40 MB zipped at most, sent after the report in parts of 6 MB, to the repository only (the email names the zip) |
| Description | 20 000 characters |
| Rate | 5 reports a minute from one IP address, an IPv6 one by its /64 (`LIMITER`); 30 parts of large attachments a minute (`PART_LIMITER`) |
| Bots | a hidden field people never fill in; filled, the report is dropped |
| Repository | one commit per file (GitHub's Contents API), 10 MB of attachments as for the email |

Sending to a verified destination address is free on the Workers Free plan.

## Large attachments

Board files are often tens of megabytes. Over 8 MB together, the app zips the attachments
(board files come to a quarter of their size or less) and names the zip in the report's form
(`bulk`: its size, parts and what it holds). The report is filed without it, and the answer
carries a pass (signed with `GITHUB_TOKEN`, good for half an hour, for that report and that
many parts). The app then posts each part to the same address
(`/api/report?part=k&id=…&d=…&t=…`), and the Worker commits it beside the report as
`attachments.zip.001`, `.002` and so on. To read them:

```
cat attachments.zip.* > attachments.zip
```

A part arrives as the Contents API's own request (the commit message and the part in base64,
made by the app) and is passed on as it came, so a part costs the Worker next to no memory or
processor time whatever the plan. Before it is passed on the Worker checks that it is that
request to the letter: the opening it expects for that report and that part number, the closing,
and nothing between them but the part itself (no quotation mark, no backslash). So a sender
chooses neither the commit's message, its author or its branch, nor whether a file is replaced:
a part that is there already is never written again. Where a part goes is decided by the Worker
alone. Parts need a pass (a report gives one), are read no further than a part may be long, and
have a rate limit of their own (`PART_LIMITER`: 30 a minute from one IP address). Without the
reports repository there are no large attachments: the app says they were left out.

A report's text reaches the repository and the issue inside a code fence longer than any run of
back-ticks in it, and its file names on one line with Markdown's marks escaped, so nothing a
sender writes is live Markdown there (no mentions, no links, no closing of other issues).

The repository grows with them: GitHub asks for repositories to stay under about 1 GB, so old
reports' zips want deleting from time to time (with their history, if space matters).

## Logs

`npx.cmd wrangler tail` shows each request live.
