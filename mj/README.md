# mj — drive Midjourney from the shell (and hand results to Claude)

Fires Midjourney's Discord `/imagine`, waits for the grid, upscales, downloads
the PNGs locally, optionally reposts them to a Discord channel, and prints the
file paths so Claude can `Read` them straight into context.

## Why a self-bot
A Discord **bot cannot invoke another bot's slash command** — only a *user
account* can. Midjourney is a bot and `/imagine` is its slash command, so
generation requires a **user token** (a self-bot). Self-bots violate Discord
ToS and are bannable; this tool exists at explicit, risk-aware request.
Reposting results uses the **official bot** token, which is allowed.

## Setup (one-time)
```bash
node mj.mjs setup          # prints the full walkthrough
```
1. `DISCORD_USER_TOKEN` — from Discord-in-browser → DevTools → Network → any
   request → `authorization` header. Put it in `~/.claude/.env`. Never commit it.
2. `DISCORD_BOT_TOKEN` (optional) — your official bot, only for `--post-channel`.
3. Discover your Midjourney channel id:
   ```bash
   source ~/.claude/.env
   node mj.mjs guilds
   node mj.mjs channels --guild "<server name>"
   ```
   Set `MJ_CHANNEL_ID` in `~/.claude/.env` to skip `--channel` each time.

## Use
```bash
source ~/.claude/.env
node mj.mjs imagine "a fox in fog --ar 16:9" --channel <id>          # grid + all 4 upscales
node mj.mjs imagine "..." --no-upscale                                # grid only
node mj.mjs imagine "..." --upscale 1,3                               # just U1 & U3
node mj.mjs imagine "..." --post-channel <id>                         # also repost via official bot
node mj.mjs imagine "..." --out ./renders --timeout 300
```
Downloads land in `./out/` as `mj-<msgid>-grid.png` / `-u1.png` … and the paths
are printed as JSON on stdout.

### The art-director loop
`imagine` prints a `gridMessageId`. Look at the grid, pick a tile, then upscale
or branch it — no need to re-generate:
```bash
node mj.mjs upscale --channel <id> --message <gridId> --index 4   # full-res one tile
node mj.mjs vary    --channel <id> --message <gridId> --index 4   # branch → a NEW grid
node mj.mjs commands --channel <id> imagine                       # list commands + owning app
```
`vary` returns a `newGridMessageId`, so you can upscale/vary *that* in turn —
exploring a concept as a branching tree, generate → see → pick → branch.

## How it stays correct
- **Freshness fence:** records the newest message id before firing and only
  accepts Midjourney replies with a strictly-greater snowflake — so an old run
  of the same prompt can't be mistaken for this one.
- **Live command lookup:** re-fetches Midjourney's `/imagine` id+version from the
  guild `application-command-index` each run (ids/versions drift; the per-channel
  search endpoint returns empty for user tokens), filtered by MJ's application_id.
- **Grid fetch:** user tokens can't `GET` a single message (bot-only), so
  `upscale`/`vary` list messages `around` the grid id instead.
- **Zero deps:** plain `fetch`/`FormData` on Node 18+.
