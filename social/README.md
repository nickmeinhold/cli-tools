# social

Harvest Nick's social graph into structured records — and **discover** people who
should be in it but aren't yet.

Two halves: **harvest** (pull your rosters from networks you're logged into) and
**discover** (find off-graph people via three signals of increasing warmth).

```
social <network> <command>     # harvest a roster
social discover <source>       # find people NOT yet in the social graph
social networks                # backend readiness
social auth <network>          # one-time interactive login
```

## Harvest backends

| Network | Command | Pulls | Via |
|---|---|---|---|
| linkedin | `connections` | 1st-degree connections | Voyager internal API |
| facebook | `friends`, `enrich` | friends; enrich adds Lives-in/Works-at + Melbourne/tech tags | React DOM + per-profile crawl |
| meetup | `members --group X` | members of a group you're in | GraphQL `/gql` |
| luma | `guests --event Y` | guest list of an event you host | lu.ma host API |

The "slippery" pattern: drive a logged-in Playwright session to the site's own
origin, then call its **internal JSON API** with an in-page `fetch()` (same-origin,
cookies ride along). Auth state reuses the `playwright` tool's token dir.

## Discover modes — the signal-distance gradient

Discovery quality tracks how *close* the channel sits to you:

| Mode | Signal | Implementation |
|---|---|---|
| `discover github` | **2nd-degree** — strangers many of your people independently follow (cold leads) | `discover_github.mjs`, public `gh api` |
| `discover messaging` | **1st-degree** — people you DM (warm) | `discover_messaging.mjs` — Signal + Discord + Telegram DMs |
| `discover groups` | **shared-room** — people in your Telegram groups (warm + contextual) | `discover_groups.mjs` — uses `telegram participants` |

Each diffs candidates against the **community-memory roster**
(`~/.claude/projects/-Users-nick-git/memory/*.md`) — the filesystem is the source
of truth for "who's already a node."

### Design principles
- **Consent-gate.** Discovered people are *leads*, not nodes. 2nd-degree people
  especially stay in a leads file (`discovery_leads_github.md`) until Nick actually
  connects — mine wide, gate hard at the point of contact.
- **Dismiss-list.** `--dismiss-shown` writes waved-off contacts to
  `discover-ignore.txt` so they never resurface. (This file is **personal data —
  gitignored**, never sync it to the public mirror.)
- **No silent caps.** When a scan bounds coverage (big channels skipped, supergroups
  that won't enumerate), it logs what it dropped.

## Adding a backend
- **Harvest:** add an entry to the `BACKENDS` registry in `social.mjs`
  (`{authUrl, origin, commands}`).
- **Discover:** add a `discover_<source>.mjs` module + a line in the `SOURCES` map in
  `social.mjs`'s discover handler. Reuse the roster-diff + dismiss-list helpers.

## Files
- `social.mjs` — CLI entry point + harvest backends + discover router
- `discover_github.mjs` / `discover_messaging.mjs` / `discover_groups.mjs` — discover modes
- `gh_xref.mjs` — GitHub cross-reference helper (Melbourne FB friends → GitHub)
- `discover-ignore.txt` — dismiss-list (**personal data, gitignored**)
