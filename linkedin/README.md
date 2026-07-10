# linkedin — LinkedIn DM CLI

Read and send LinkedIn direct messages as Nick's own account, from the terminal.

```
node ~/git/tools/cli-tools/linkedin/linkedin.mjs <subcommand>

  auth                                         Interactive browser login; persist the session.
  whoami                                       Print the logged-in name (health check).
  list [--limit N] [--json]                    List DM threads, newest first (● = unread).
  read --to <name> [--limit N] [--json]        Recent messages in a thread (name substring).
  send --to <name> (--text "…" | --file P)     Send a DM to the matching thread.
             [--dry-run]                        Open the thread, send NOTHING, report the tail.
```

## Why browser-backed (not a protocol/API client)

Unlike `whatsapp`/`signal`/`telegram` (real protocol clients), LinkedIn gives no usable
messaging API:

- There is **no supported public messaging API**.
- LinkedIn's *internal* Voyager REST endpoint (`/voyager/api/messaging/conversations`) now
  returns **HTTP 500** — DMs were migrated to a **GraphQL** endpoint whose `queryId` hash
  **rotates on every LinkedIn deploy**, so hard-coding it is a maintenance treadmill.

So this drives the **real messaging SPA** headlessly (Playwright) and reads the rendered DOM.
That survives their API churn for free — the same reason the `instagram` CLI drives the web
client instead of the (467-blocked) private API.

Two DOM facts that bit during the build, worth knowing if selectors ever break:

- Message rows are **not `<li>`** — the class `msg-s-event-listitem` sits on a `<div>`, and the
  message text is `.msg-s-event-listitem__body`.
- **Sender names are group-level headers** (`.msg-s-message-group__name`), not nested per row —
  so `read` walks names + bodies in DOM order and carries the last sender forward.
- LinkedIn **auto-opens the top thread**, so `read`/`send` gate on the thread header
  (`.msg-entity-lockup__entity-title`) matching the requested name before touching messages —
  otherwise a no-op click silently reads/sends to the wrong person.

## Session

Reuses the **existing** Playwright LinkedIn session (`social`/`playwright` already banked it):

    ~/git/tools/cli-tools/.tokens/playwright/linkedin.json   (label: "linkedin")

`li_at` lasts ~a year; if calls start returning stale, re-run `linkedin auth`.

## Safety

`send` is a mutating, outward-facing verb, so it **fails closed**: an unrecognised flag (e.g. a
typo'd `--dryrun`) **aborts** rather than silently firing a real send. `--dry-run` opens the
thread and reports what it *would* send without sending.

## ToS

LinkedIn is aggressive about automation. This is for **your own** inbox at human pace — the same
account you'd use in a browser. Don't point it at bulk outreach; that's what flags accounts.
