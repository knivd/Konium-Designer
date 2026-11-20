# Konium version control (Cloudflare Worker)

(The commands are written for Windows, where `npx.cmd` is needed in PowerShell; elsewhere it is `npx`.)

Two jobs, one Worker:

- **`konium.app/api/vcs/*`: Konium's store.** Teams keep their projects here when they don't use
  a Git server of their own. A team is known only by the token its key gives; the key itself
  stays in the designers' browsers, and everything arrives sealed with it (AES-GCM), so this
  Worker and the bucket hold nothing anyone here can read. Each project is a few blobs: its
  branch head and the Git pack files each push made. Writes are conditional (new only, or only
  if unchanged since read), so two pushes at once can't overwrite each other.
- **`konium.app/api/git/*`: a relay** for teams' own Git servers (GitHub, GitLab, Bitbucket,
  Gitea…), which don't let pages reach them directly. Only Git's own requests are passed on, over
  HTTPS, with the sign-in as it came; nothing is kept or logged. A self-hosted server that allows
  pages (CORS) needn't use it: Preferences › Data Management › Version Control › Reached through.

## Set-up (once)

1. **R2.** Dashboard › R2 › enable it on the account (Cloudflare may ask for a payment method even
   within the free allowance), then create the bucket:
   ```
   npx.cmd wrangler login
   npx.cmd wrangler r2 bucket create konium-vcs
   ```
2. **The salt** (any long random text, kept secret; it names each team's folder in the bucket
   from its token):
   ```
   npx.cmd wrangler secret put SALT
   ```
3. **Deploy** (from this folder):
   ```
   npx.cmd wrangler deploy
   ```
   It creates the routes `konium.app/api/vcs/*` and `konium.app/api/git/*`, and the store's ledger
   (a Durable Object with SQLite; the migration in `wrangler.toml` makes it on the first deploy that
   has it, with nothing to do by hand). A team that kept projects before the ledger existed is
   entered at what it keeps the next time it writes.

## Limits (`wrangler.toml`)

| Setting | Default | What it limits |
|---|---|---|
| `MAX_TEAM_MB` | 1024 | A team's store, all its projects and their history |
| `MAX_BLOB_MB` | 95 | One push (Workers take requests up to 100 MB) |
| `MAX_STORE_GB` | 50 | The whole store: what the bucket may come to cost |
| `USER_MB_PER_DAY` | 1024 | What one user (by IP address) may write in a day |
| `NEW_TEAMS_PER_USER` | 3 | New teams one user may start in a day |
| `NEW_TEAMS_PER_DAY` | 200 | New teams a day for the whole service |
| `LIMITER` | 300 a minute | Requests from one IP address (an IPv6 address counts by its /64, the subscriber's network) |

Teams are anonymous (a team is whoever holds its key), so anyone can start one; the ledger is what
keeps strangers from filling the bucket. Room is taken in the ledger in the same step that checks
it, so pushes sent together cannot each see room that only one of them has; a write that fails
gives its room back. A write must say its size (`Content-Length`): one that does not is refused
(411) without being read. A full team is told so (507) and can move its projects to a Git server
of its own: the history goes with them. A full store answers 507 to everyone until `MAX_STORE_GB`
is raised.

## The relay

Only Git's own requests are passed on (`info/refs`, `git-upload-pack`, `git-receive-pack`), over
HTTPS, never to konium.app. The relay follows a Git server's redirect (a repository renamed, a
`.git` added) only to another address it would pass a request to; the sign-in goes on only to the
same host. So a server can't have the relay fetch anything else.

What comes back is Git's and nothing else: only Git's content types pass, none of the server's
other headers do, and the answer is marked a download that is not to be sniffed, framed or run
(`X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, a sandboxing
`Content-Security-Policy`). A browser that asks for a relay address as a page, a frame, a script
or a worker is refused. So a link through the relay can never show or run a stranger's page as
konium.app's.

## Changing the salt

Every team's folder is named from it: a new salt loses every team's projects in the store (the
copies in the designers' project folders stay). Don't.
