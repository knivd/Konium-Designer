# Konium world parts library (Cloudflare Worker)

(The commands are written for Windows, where `npx.cmd` is needed in PowerShell; elsewhere it is `npx`.)

**Not in service yet.** The Worker and its tests are here, and from 26.201 the program's side too
(Tools › Parts with the parts library switched on: looking a part up, signing in, publishing).
Until this is deployed the program says that the library isn't there. Before the parts library is
released, the list of connections in the program must name the mail provider chosen below.

Parts made in Konium Designer (a symbol, a footprint and what is known of the part) can be
published to one library for everyone and fetched by anyone who types the same part number. The
library is a public Git repository at GitHub; this Worker stands between it and the program at
`https://konium.app/api/library`.

- **Fetching needs no sign-in.** A part is found by its key (its part number in upper case, letters
  and digits only) and its files are passed on from the repository as they are, at the commit the
  library's own index names.
- **Publishing needs a sign-in**: a link mailed to an address, confirmed by a press on the page the
  link opens (so a mail scanner that follows links signs nobody in). The address is kept in this
  Worker's own store and is never published: a part carries a contributor number made from the
  address with the Worker's secret (`k-` and eight characters), and the name the contributor chose
  to show, if any.
- **Everything published is given to the public domain** (CC0 1.0). The program asks for that
  agreement with every part, and the Worker refuses a part sent without it.
- A part is four files in one commit: `parts/<first two of the key>/<key>/part.json`,
  `library.json`, `symbol.SchLib` and `footprint.PcbLib`. A part already in the library can be
  published again only by whoever published it, and only while nobody has confirmed it.

## What a sender cannot do

| Guard | How |
|---|---|
| Choose where a file goes, or write any other file | Paths are made here from the part's key alone; the key's form is checked |
| Carry anything in beside a library file | The two libraries come as GitHub's own blob request and are passed on only if they are that request to the letter (its opening, its closing, nothing between but base64); each gets a pass signed for that sender, that kind and that blob |
| Write a commit message of their own | The message and its author line are made here; a part's own words go into them on one line, without `@` or `#` as GitHub reads them |
| Put live text into the record | The record is checked as text against its form and rewritten field by field, each on one line and within its length |
| Send without end | Every body is read no further than it may be long, whatever it says of its length |
| Fill someone's inbox, or the mail allowance | Three links an hour to one address (and three more for whoever asks from where that address last signed in, so strangers cannot keep a contributor out); 60 an hour and 400 a day for the whole service |

Per user (a salted stand-in for the IP address; an IPv6 address by its /64): `FETCH_PER_DAY` 500,
`SIGNIN_PER_HOUR` 5, `PUBLISH_PER_DAY` 20; per contributor, `CHECK_PER_DAY` 40 (`wrangler.toml`).

## Approval (26.203)

`POST /api/library/check` (signed in) takes a contributor's word about one revision of a part:
`{ key, revision, verdict, note? }`, the verdict one of `confirm` (compared with the datasheet and
found right), `built` (a board made with it works) and `problem` (something is wrong, said in a
line of 10 to 200 characters). The word goes into the part's `library.json` (`checked`, `built`,
`problems`: who, the name they show, when, the line) as a commit of that one file, and the part's
standing follows from the lists:

| Standing | When |
|---|---|
| Unverified | As published; or two contributors have found something wrong with it, whatever it was before |
| Confirmed | Two contributors other than its author have found it right |
| Proven | Confirmed, and somebody (its author too) has built a board with it that works |

A part's author can neither confirm it nor report a problem with it: a fault is put right by
publishing the next revision, which is possible while the part is Unverified and starts the lists
again. One word of each kind from each contributor; whoever finds a part right no longer finds it
wrong, and the other way round. A word about a revision the library has moved on from is refused
with the note as it is now.

What this does not stop: one person with three addresses confirming their own part. An address
costs little, so Confirmed means "three sign-ins agree", no more; the repository's history shows
who said what, and a part can be put right or taken out there by its keeper.

## Set-up (once, when the library opens)

1. **The repository.** A public repository at GitHub with a first commit holding a README and the
   CC0 1.0 text as its licence (the Worker adds to a branch that exists; it does not make one).
   Put its name in `LIBRARY_REPO` in `wrangler.toml` (`owner/name`).
2. **A token for that repository alone.** GitHub › Settings › Developer settings › Fine-grained
   tokens: only that repository, **Contents: Read and write**, nothing else.
3. **The mail.** Either Cloudflare's Email Service (Workers Paid; set the domain up for sending,
   then take the comment marks off `[[send_email]]` in `wrangler.toml`), or Resend (verify the
   domain there and make an API key that may only send).
4. **Deploy**, from this folder (`cloudflare/library`):
   ```
   npx.cmd wrangler deploy
   npx.cmd wrangler secret put GITHUB_TOKEN
   npx.cmd wrangler secret put LIBRARY_SECRET
   npx.cmd wrangler secret put RESEND_KEY
   ```
   `LIBRARY_SECRET`: any long random text (in PowerShell: `-join ((1..64) | % { '{0:x}' -f (Get-Random -Max 16) })`).
   It signs the sessions and the passes and makes the contributor numbers. `RESEND_KEY` only when
   the mail goes by Resend.
5. **Check:** `https://konium.app/api/library/config` answers `"ready": true` and, once the mail is
   set up, `"signIn": true`.

## Changing the secret

Every session ends and every contributor gets a new number, so nobody could publish their own
parts again. Don't.

## What is kept

In the Worker's store (a Durable Object's SQLite): the day's and the hour's counts, the sign-ins
under way (a quarter of an hour each), each contributor's address, shown name and the stand-in for
where they last signed in, and the index of the parts (key, status, contributor number, commit).
Nothing of anyone's design. The addresses are used for the sign-in link and nothing else.
