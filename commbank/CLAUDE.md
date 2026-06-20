# commbank — read-only NetBank CLI

Drives Chromium against Commonwealth Bank NetBank via a Playwright `storageState`, to
**read** account balances and transactions. Built 2026-06-07 (out of an ad-hoc "did I pay
this invoice?" investigation — the cross-account `search` is the reason it exists).

## Read-only by design
This tool only navigates and scrapes. There is **no** code path that transfers money, pays
a bill, or mutates anything. Safe to run without a second thought; worst case it reads a balance.

## Why it's not always-on (unlike gmail/signal/telegram)
NetBank sessions are **server-side and short-lived** (~15-20 min idle, hard cap too). A saved
cookie jar can't keep you logged in indefinitely the way Gmail's refresh token does. So each
*sitting* starts with `commbank auth` (interactive login), after which queries run freely until
the session expires. When it expires, commands print `Run: commbank auth` and exit 3.

## Auth
`commbank auth` shells out to the shared `playwright` CLI's interactive login (headed Chromium,
you type client number + password + NetCode 2FA, press Enter to save). The session lands at
`~/.claude/cli-tools/.tokens/playwright/commbank.json` — same token store as the other
playwright-backed tools. `node_modules` is a symlink to `../playwright/node_modules` (no second
Playwright/browser install).

## Subcommands
```
commbank auth                                   # log in (run first each sitting)
commbank accounts                               # [{name, account, balance, available}]
commbank transactions --account "Business Trans Acct" [--from dd/mm/yyyy --to dd/mm/yyyy] [--raw]
commbank search --term "after hours" [--amount 210.00] [--account NAME] [--from --to]
```
- All output is JSON on stdout (jq-composable).
- `search` defaults to the range `01/07/2025 .. today` and sweeps **all** accounts unless
  `--account` is given — that breadth is the whole point (a company invoice paid from a personal
  account is exactly what a single-account check misses).
- `--headed` watches the browser run; default is headless.

## Selectors it depends on (re-check if NetBank redesigns)
- Transaction rows: elements with the class token `transaction-item`; per row it reads
  `.transaction-item__date`, `.transaction-item__description`, and amounts from
  `.honeycomb-currency span[aria-hidden=true]` (amount, then running balance). The parallel
  `.sr-only` spans are the screen-reader duplicates and are deliberately ignored.
- Account tiles (home): `<Name>`/`Balance $X`/`Available $Y`/`Options for <Name>` text blocks.
- Date-range picker: `#date-filter-bubble` → `#date-picker-start-date-input` / `-end-date-input`.
- Verified end-to-end against live NetBank 2026-06-07 (accounts, transactions, search all clean).
