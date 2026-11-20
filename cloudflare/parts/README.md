# Konium parts service (Cloudflare Worker)

(The commands are written for Windows, where `npx.cmd` is needed in PowerShell; elsewhere it is `npx`.)

A BOM document's searches at **Digi-Key** and **Mouser** go to `https://konium.app/api/parts`. This
Worker makes them with the developer's own API keys (Worker secrets) and answers with the parts found
in one form (`src/model/suppliers.ts`): the distributor's part number, the manufacturer and its part
number, the description, stock, price breaks and currency, lifecycle status, packaging, minimum order
and the product page. Only what is searched for is sent: a part number or a few words, nothing of the
design. JLCPCB's parts are looked up by the app itself (jlcsearch.tscircuit.com), not here.

What keeps within the distributors' limits:

| Guard | Setting | Default |
|---|---|---|
| An answer kept and given again (not counted, not asked again) | `CACHE_HOURS` | 24 |
| New searches a day for each user (salted hash of the IP address; an IPv6 address by its /64) | `LOOKUPS_PER_USER` | 100 |
| Digi-Key calls a day / a minute (Digi-Key allows 1,000 / 120) | `DIGIKEY_PER_DAY` / `DIGIKEY_PER_MINUTE` | 950 / 100 |
| Mouser calls a day / a minute (Mouser allows 1,000 / 30) | `MOUSER_PER_DAY` / `MOUSER_PER_MINUTE` | 950 / 28 |

Digi-Key answers for its UK site in pounds (`DIGIKEY_SITE`, `DIGIKEY_LANGUAGE`, `DIGIKEY_CURRENCY`).
Mouser's prices come in the currency Mouser gives them in, as each price break says [est: likely the key's account's currency; confirm on the first live search].

## Set-up (once)

1. **Keys.** Digi-Key: a production app with **Product Information V4** (developer.digikey.com) gives
   a Client ID and a Client Secret. Mouser: My Mouser › APIs › **Search API** key.
2. **Deploy**, from this folder (`cloudflare/parts`):
   ```
   npx.cmd wrangler deploy
   npx.cmd wrangler secret put DIGIKEY_CLIENT_ID
   npx.cmd wrangler secret put DIGIKEY_CLIENT_SECRET
   npx.cmd wrangler secret put MOUSER_KEY
   npx.cmd wrangler secret put SALT
   ```
   `SALT`: any long random text (in PowerShell: `-join ((1..64) | % { '{0:x}' -f (Get-Random -Max 16) })`); it makes the stand-in for a
   user's IP address impossible to reverse. A distributor whose secrets aren't set is shown as not set
   up in the app; the other still works.
3. **Check:** `https://konium.app/api/parts/config` lists both distributors with `"ready": true`.

The keys never reach the app or the browser. To stop a distributor, delete its secret
(`npx.cmd wrangler secret delete MOUSER_KEY`).
