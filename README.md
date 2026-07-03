# cli-tools

A personal toolkit of small, single-file command-line tools that let an AI agent
(or you) drive everyday services — messaging apps, Google, Blender, kanban,
wikis — from the terminal. Each tool is one self-contained script with a
`--help`. No framework, minimal dependencies.

> Built as the "hands" for an autonomous Claude Code setup: the agent reaches for
> a CLI instead of asking a human to click. They work equally well run by hand.

---

## ⚠️ Read this first — safety & terms of service

Several of these tools drive **consumer messaging apps via unofficial protocols
or browser automation**, acting as *your own account*. That is powerful and also
carries real risk:

- **Terms of Service.** WhatsApp (Baileys), Messenger (ws3-fca), Instagram, and
  Telegram-as-a-user all technically violate the platform's ToS. Enforcement
  against personal-volume use is rare but **not zero — your account could be
  banned.** Keep volume human-paced. Discord uses the *official* bot API and is
  the safe exception.
- **Credentials never live in this repo.** Every tool reads secrets from
  environment variables or stores a session under a local, git-ignored
  `.tokens/` directory. **Nothing in this repo contains a token, password, or
  cookie** — `.gitignore` blocks all of it, and so should yours.
- **Respect other people.** Tools that read or auto-reply to messages touch
  *other people's* words. Only automate conversations with people who know and
  consent. The `imessage-responder` ships **without** its system prompt,
  contact, or message history — you must supply your own.
- **No financial actions.** `commbank` is **read-only by design** — it scrapes,
  it never moves money.

You are responsible for how you use these. Start read-only, keep volume low.

---

## Install

Most tools are Node ESM (`.mjs`); a couple are Python. Per-tool dependencies
live in that tool's folder.

```bash
git clone https://github.com/nickmeinhold/cli-tools.git
cd cli-tools

# Node tools: install deps in the folders you want
cd whatsapp && npm install && cd ..
cd google   && npm install && cd ..
# ...etc

# Run any tool's help
node whatsapp/whatsapp.mjs --help
```

Requirements: Node 18+ for the `.mjs` tools, Python 3.10+ for the Python ones,
and a `claude` CLI on PATH for the AI-backed tools (`imessage-responder`).

---

## The tools

| Tool | What it does | Mechanism | ToS risk |
|---|---|---|---|
| [`whatsapp`](#whatsapp) | Send/read WhatsApp DMs & groups as you | Baileys (WhatsApp Web) | ⚠️ unofficial |
| [`telegram`](#telegram) | Read/send Telegram as your user account | GramJS / MTProto | ⚠️ unofficial |
| [`discord`](#discord) | Message via an official bot | Discord REST v10 | ✅ official |
| [`signal`](#signal) | Read (local DB) + send Signal | Signal Desktop DB + signal-cli | personal |
| [`messenger`](#messenger) | Read/send Facebook Messenger DMs | ws3-fca + Playwright | ⚠️ unofficial |
| [`instagram`](#instagram) | Read/send Instagram DMs | Playwright (web) | ⚠️ unofficial |
| [`linkedin`](#linkedin) | Read/send LinkedIn DMs | Playwright (web) | ⚠️ unofficial |
| [`google`](#google) | Gmail, Drive, Calendar | Google APIs (OAuth) | ✅ official |
| [`blender`](#blender) | Drive Blender programmatically | BlenderMCP socket / headless | ✅ |
| [`outline`](#outline) | Outline wiki CRUD + search | Outline API | ✅ official |
| [`kan`](#kan) | Kan.bn kanban boards/cards | Kan API | ✅ official |
| [`forge`](#forge) | Generator-evaluator agent loop | local | ✅ |
| [`playwright`](#playwright) | Headed-browser automation + auth bridge | Playwright | varies |
| [`commbank`](#commbank) | Read-only NetBank balance/transaction scrape | Playwright | personal, read-only |
| [`social`](#social) | Build a social graph from FB/LinkedIn | Playwright + GitHub API | ⚠️ scraping |
| [`marketplace-watch`](#marketplace-watch) | Watch FB Marketplace for new listings | Playwright | ⚠️ scraping |
| [`imessage-responder`](#imessage-responder) | Autonomous AI replies in an iMessage thread | chat.db + headless Claude | macOS only |
| [`lib`](#lib) | Shared Playwright plumbing | — | — |

### whatsapp
Baileys-backed WhatsApp client. Post/read in your personal groups & DMs — the
case the Meta Cloud API can't do (it's business→customer 1:1 only).
```bash
node whatsapp/whatsapp.mjs auth          # one-time QR scan (phone → Linked Devices)
node whatsapp/whatsapp.mjs list-groups
node whatsapp/whatsapp.mjs send --to <jid> --text "hi"
node whatsapp/whatsapp.mjs watch         # daemon: logs incoming DMs + media
```
Session is stored under `.tokens/whatsapp/` (git-ignored).

### telegram
Read/send Telegram as your **user** account (MTProto), so it sees your personal
DMs and history — a bot cannot. Interactive login on first run.
```bash
node telegram/telegram.mjs --help
```

### discord
The safe one: sends as an **official bot** (no self-bot ban risk). Can DM users
who share a server with the bot, read replies, fetch attachments.
```bash
node discord/discord.mjs help
```

### signal
Asymmetric by design: **reads** by decrypting Signal Desktop's local DB
(instant, full history); **sends** by shelling out to `signal-cli`. Pair via QR.
```bash
node signal/signal.mjs --help
```

### messenger
Read/send Facebook Messenger DMs as your own account. Note: the unofficial
protocol client is blind to E2EE threads — for those, drive `messenger.com` via
the `playwright` profile. `whoami` before trusting an empty inbox.
```bash
node messenger/messenger.mjs --help
```

### instagram
Instagram DMs as you. IG's private API is blocked, so this drives a headless
browser (slower/heavier, but the only path IG leaves open). Interactive login.
```bash
node instagram/instagram.mjs --help
```

### linkedin
LinkedIn DMs as you. LinkedIn has no messaging API, and its internal Voyager
REST endpoint now 500s (DMs moved to a GraphQL endpoint with a rotating query
hash), so this drives the messaging SPA headlessly and reads the DOM. Reuses a
saved Playwright session. `send` fails closed on unknown flags; `--dry-run`
opens the thread but sends nothing.
```bash
node linkedin/linkedin.mjs --help
```

### google
Gmail, Drive, and Calendar from one OAuth credential.
```bash
node google/gmail.mjs --help     # search/draft/send mail, attachments
node google/gdrive.mjs --help    # upload/list/share, markdown → Google Doc
node google/gcal.mjs --help      # list/create events, invite attendees
```
Provide your own OAuth client; the token lives in `.tokens/` (git-ignored).

### blender
Drive Blender programmatically (a CLI over the BlenderMCP addon). Two modes:
**socket** (drives a live Blender) and **headless** (reproducible batch jobs,
e.g. GLB / blendshape work).
```bash
node blender/blender.mjs --help
```

### outline
Full CRUD + search against an [Outline](https://www.getoutline.com/) wiki, incl.
markdown export. Multi-instance aware.
```bash
node outline/outline.mjs --help
```

### kan
Kan.bn kanban: workspaces, boards, cards, lists, labels, members, invites.
```bash
node kan/kan.mjs --help
```

### forge
A self-contained generator-evaluator loop (planner / builder / evaluator), with
trajectory analysis (plateau / oscillation / regression detection).
```bash
node forge/forge.mjs --help
```

### playwright
Headed-browser automation for sites without a clean API, **and** the auth-bridge
front door: `auth --site URL --name LABEL` does an interactive login (your hands:
password + 2FA) and saves a session that the messaging CLIs reuse. The `_*.mjs`
scripts are small task-specific recipes.
```bash
node playwright/playwright.mjs --help
```

### commbank
**Read-only** NetBank scraper (balances, transactions). There is no code path
that transfers money or mutates anything. Sessions are short-lived, so each
sitting starts with an interactive `auth` (client number + password + NetCode).
```bash
node commbank/commbank.mjs --help
```

### social
Builds a social graph: harvests FB friends / LinkedIn connections and
cross-references against GitHub (location=builder signal). Public APIs +
browser automation; checkpointed and paced. Use responsibly and respect others'
privacy.
```bash
node social/social.mjs --help
```

### marketplace-watch
Polls Facebook Marketplace for new listings matching a search and notifies you.
```bash
cat marketplace-watch/watch.sh   # configure the search + notify target
```

### imessage-responder
**macOS only.** An autonomous 🤖 responder for a *single* iMessage thread,
backed by headless Claude. It reads the thread from the local Messages `chat.db`,
generates a reply, and either sends it (auto-prefixed 🤖) or escalates sensitive
topics to you. Safety properties baked in: **arm-only first run** (never answers
the existing backlog), every send gated, errors escalate rather than guess.

**Ships intentionally incomplete.** You must supply:
- `system-prompt.txt` — copy from `system-prompt.txt.example` and tailor it.
- `CONTACT_HANDLE` / `OWNER_HANDLE` env vars — the contact's handle and yours.

Only use this with someone who **knows and consents** to autonomous AI replies.
```bash
export CONTACT_HANDLE="+10000000000"  OWNER_HANDLE="you@example.com"
cp imessage-responder/system-prompt.txt.example imessage-responder/system-prompt.txt
python3 imessage-responder/responder.py     # first run arms only; sends nothing
```

### lib
Shared Playwright plumbing (`browser-context.mjs`) used by the browser-driven
messaging tools. Not a standalone tool.

---

## Design notes

- **One file per tool.** Each script is readable top-to-bottom and carries its
  own `--help`. No build step, no shared framework to learn.
- **Secrets out-of-band.** Code is committable because credentials live in env
  vars or a git-ignored `.tokens/` dir — never inline.
- **Read before write.** The riskier tools default to read/observe; sending is an
  explicit, separate action.

## License

[MIT](./LICENSE) © 2026 Nick Meinhold
