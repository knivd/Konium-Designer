# Konium AI service (Cloudflare Worker)

(The commands are written for Windows, where `npx.cmd` is needed in PowerShell; elsewhere it is `npx`.)

Preferences › System › AI › **Konium service** sends Konium's AI jobs (reading a datasheet's
packages and their drawings, its pin tables, a design for the Design Adviser to review, part numbers
for a BOM's lines, and a specification to split into requirements) to
`https://konium.app/api/ai`. This Worker runs them on the models offered through OpenRouter, with
the author's key, for anyone using Konium. A design or board sent for review (as text), or a
specification sent to be split, is passed to the model and nothing of it is kept. For the adviser's in-depth checks the Worker
also finds a part's datasheet on the web (OpenRouter's web plugin, about $0.007 a search; the
address a designer's check used is shared, so each part number is searched for once) and fetches
datasheets for the app (`GET /api/ai/fetch?url=…`: PDFs only, up to 30 MB, a product page's own PDF
link one step on, a hundred a day for each user). A datasheet is fetched only from a named host on
the web's own ports (no address in numbers, no name of a private network, not konium.app), every
redirect is held to the same rule and followed by hand (five at most), the answer is read no
further than 30 MB whatever it says of its length, and it is handed on as a file (not to be
sniffed, shown or run as a page of konium.app's).

What keeps the bill in hand:

| Guard | Where | Default |
|---|---|---|
| Only Konium's jobs (the Worker writes the prompts; answers capped in length) | `src/handler.ts`, `src/ai/jobs.ts` | — |
| Job tokens a day per user (salted hash of the IP address; an IPv6 address by its /64, the subscriber's network): a job — a survey, a footprint, a symbol, a design's or a board's review, a BOM's part numbers — takes one on the cheapest model offered, and a dearer model's job its weight, its typical job's cost over the cheapest's (26.099); finding a drawing's place on its page (a small job before each reading) and checking the footprint made (a round or more after it) three times that each | `JOBS_PER_DAY` | 25 |
| A design check's details — finding each part's datasheet, checking each part against it, questions | five times `JOBS_PER_DAY` | 125 |
| Datasheets fetched for a user a day | `FETCHES_PER_DAY` in `src/handler.ts` | 100 |
| The service's spend a day: a job's likely cost is set aside before the model is asked and settled to what it did cost after, so jobs started together cannot run past it | `DAILY_BUDGET_USD` | $1.00 |
| The month | OpenRouter's **credit limit on the key** | set it (step 2) |
| Model price ceiling (automatic choice) | `MAX_PRICE_IN` / `MAX_PRICE_OUT` ($ per M tokens) | 10 / 50 |
| Providers that train on the data | excluded (`data_collection: deny`) | — |

When a limit is reached, users are told to come back tomorrow or use their own key or a local model.

## Set-up (once)

1. **OpenRouter account.** Sign up at openrouter.ai and add credit (Settings › Credits). OpenRouter
   adds a small fee on credit bought.
2. **A key with a limit.** openrouter.ai › Keys › *Create Key*: name it `konium-service`, set
   **Credit limit** to the month's budget (e.g. 25). Copy the key (`sk-or-…`): it's shown once.
   Put a reminder in your calendar to raise or reset the limit as you like each month.
3. **Privacy.** openrouter.ai › Settings › Privacy: switch off *Enable training and logging* for
   paid models (the Worker also asks for providers that don't train).
4. **Deploy** (Node.js installed; from this folder):
   ```
   npx.cmd wrangler login
   npx.cmd wrangler secret put OPENROUTER_KEY    # paste the key
   npx.cmd wrangler secret put SALT              # type any long random text
   npx.cmd wrangler deploy
   ```
   `wrangler deploy` creates the route `konium.app/api/ai/*` and the Durable Object (SQLite, on
   the Workers Free plan too).
5. **Try it.** In Konium: Preferences › System › AI › *Konium service* › **Test**. Then
   Tools › Component Builder in a library with any datasheet.

## Updating

The Worker runs the jobs in `src/ai/jobs.ts` as they were when it was deployed (it takes them from
the Konium source around this folder, so deploy from the build's own source, not an older copy).
When a Konium build adds or changes a job (its notes say so), deploy again from this folder:

```
npx.cmd wrangler deploy
```

The secrets, the allowance and the shared cache stay as they are; answers kept for an older
version of a job are no longer served. To see what a deployment runs: `GET /api/ai/config` lists
its `jobs`.

## Models

One model does every job — the datasheet's survey, finding the drawings, reading them, checking
the footprint made, reading the pin table for the symbol — so what one model understood carries through. Left empty, `MODELS` means the
automatic choice: from OpenRouter's live list, the "latest" aliases (`~anthropic/claude-opus-latest`,
`~google/gemini-flash-latest` …: each always its family's newest, so nothing offered ever retires)
of the families in `FAMILIES` — Claude Opus, GPT Sol, Gemini Pro and Gemini Flash: on a hard
datasheet only Claude Opus and GPT Astra made a usable footprint, Gemini Pro, Gemini Flash, Claude
Fable and GPT Sol came close, the rest fell short, and Fable and Astra cost too much for every day
— that take pictures, priced under `MAX_PRICE_IN` / `MAX_PRICE_OUT`, the cheapest first. Users see
them named without the `~`. `DEFAULT_MODEL` is the default (Gemini Flash, for its price; any alias
that takes pictures, whatever its family and price; a model's id stands for its family's alias;
empty: the first, the cheapest); users can choose any of them in Preferences › System › AI or in the builder.
To try another family, add it to `FAMILIES` (the alias without `~` and `-latest`:
`anthropic/claude-fable`); to try a model with no alias (a newest Gemini, Qwen, Meta, MiMo), set
`MODELS` in `wrangler.toml` to OpenRouter model ids (openrouter.ai/models):

```toml
MODELS = '[{"id": "anthropic/claude-opus-5.5", "label": "Claude Opus 5.5", "roles": ["text", "vision"]}]'
```

Plain text work a cheap model does as well (a specification split into requirements) runs on
`CHEAP_MODEL` whatever a user chose (empty: `qwen/qwen3.8-flash`, about a fifth of Gemini Flash's
price for what it reads and an eighth for what it writes), one job token each; when OpenRouter
stops listing it, the newest of its family (`qwen/qwen#-flash`, not the omni ones) takes its
place, and should the job fail there (no endpoint for the data policy, say) it runs on the model
chosen.

`DEFAULT_MODEL` and the other variables can also be changed in the Cloudflare dashboard (Workers ›
konium-ai › Settings › Variables) without deploying again — but a deploy puts back what
`wrangler.toml` says.

Models are retired and replaced on OpenRouter all the time; the aliases follow by themselves. A
model named in `MODELS` or `DEFAULT_MODEL`, or one a user chose (before 26.080, a version), that
isn't offered is replaced by the newest of its family (the id without its version numbers:
`google/gemini-#-pro`, `anthropic/claude-opus-#`) or its family's alias (`anthropic/claude-opus-5.5`
→ `~anthropic/claude-opus-latest`) — nothing to change when it happens.

## Shared cache

Answers designers accepted (a datasheet's variants, its packages and its pin tables) are kept by the
datasheet's fingerprint, so the next person reading the same datasheet gets them at once, with no
model asked and nothing from their allowance. Each user counts once per datasheet; the answer most
users accepted is served. An answer is taken into the cache only with the pass the Worker gave
with that very answer (signed with `SALT`, good for a day, for that job, that datasheet and that
answer): nobody can put a reading of their own making there. The cache has an end
(`MAX_ANSWERS` in `src/store.ts`, 20,000); past it the answers longest untouched go. Nothing of anyone's design is kept — only what was read from a public
datasheet. Users can switch sharing off in Preferences › System › AI.

## Costs (indicative, November 2026)

The models offered cost $0.03–10 per million tokens in and $0.09–50 out (the frontier ones $2–10 in,
$6–50 out). A survey of a 50-page datasheet (about 40k tokens in, 2k out) costs about $0.10 on Gemini
Pro or GPT Sol and $0.50 on Claude Fable or GPT Astra; a footprint (finding the drawings, then reading
them with some thinking) $0.05–0.60, and each round of checking it about as much again.
`DAILY_BUDGET_USD` stops the service for the day when reached: set it (and the key's monthly limit)
to what you're willing to spend — $1 lasts a handful of jobs.
