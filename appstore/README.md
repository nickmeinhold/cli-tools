# appstore — Apple App Store Connect + Google Play distribution CLI

Two small, app-agnostic CLIs for driving mobile/desktop app distribution from
the terminal instead of clicking through App Store Connect and the Play Console:

- **`asc.py`** — Apple App Store Connect: iOS TestFlight + the full Mac App
  Store pipeline (package → upload → attach → metadata → screenshot → submit).
- **`gplay.py`** — Google Play Developer API: upload an AAB to a track, set
  release notes, update the store listing.

No app identifiers are hardcoded. Which app each command targets comes from a
per-app config, so the same toolkit serves every app you ship.

## Config

Create `~/.config/appstore/apps.json` (override the path with `$APPSTORE_CONFIG`).
See [`apps.example.json`](apps.example.json) for the shape:

```json
{
  "default": "aiko",
  "apps": {
    "aiko": {
      "asc":  { "bundle_id": "cc.example.myApp",  "env": "~/keystores/myapp-asc.env" },
      "play": { "package": "cc.example.my_app",   "key": "~/keystores/myapp-play-sa.json" }
    }
  }
}
```

App selection precedence: `--app NAME` → `$APPSTORE_APP` → config `default`.

Credentials themselves live **outside the repo** (the paths above, typically
`~/keystores`). Nothing here contains a key.

## Auth

- **Apple (`asc`)** — an App Store Connect API key (Team key, App Manager role).
  The app's `env` file holds `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH`
  (`KEY=VALUE` lines); env vars override. Binary upload shells out to
  `xcrun altool`, so run `asc install-key` once to place the `.p8` where altool
  expects it.
- **Google (`gplay`)** — a Play-publisher service-account JSON key (permissions
  granted in the Play Console, not GCP IAM).

## Install

```bash
pip install -r appstore/requirements.txt
# put them on PATH
ln -sf "$PWD/appstore/asc.py"   ~/.local/bin/asc
ln -sf "$PWD/appstore/gplay.py" ~/.local/bin/gplay
```

## Usage

```bash
asc --help
asc verify                     # prove ASC access
asc mas-status                 # Mac App Store version + build + review state
asc mas-submit --confirm       # FAIL-CLOSED: dry-runs without --confirm

gplay --help
gplay verify                   # prove Play access (opens + aborts an edit)
gplay status --track internal
gplay upload --aab app.aab --track internal --notes "…"
```

Both tools keep the distribution-safety discipline from their origin: the
irreversible Apple submit requires `--confirm`, and `gplay upload` commits as a
Console **draft** (`changesNotSentForReview=true`) rather than auto-submitting.

## Preflight — audit submission preconditions before you submit

```bash
asc   --app aiko preflight     # iOS/macOS preconditions
gplay --app aiko preflight     # Android preconditions
```

`preflight` is the automated form of the pre-submission checklist: every rejection
at the 2026-07 launch came from a precondition that was true on `main` but not in
the submitted artifact or on the live platform. It audits five things — metadata
URLs resolve 200, the well-known auth files carry the right relations (Apple AASA
served; Android `assetlinks.json` has **both** `get_login_creds` and
`handle_all_urls` — read directly, because Google's own checker can stay green
while one is missing), platform-required `Info.plist` keys are present, the live
build/version number (so your next upload uses a fresh one), and the per-platform
submit capability.

**Fail-closed:** it exits nonzero if any hard check fails, so it can gate a submit
in a script. `WARN`/`MANUAL`/`INFO` items (the on-device passkey test, "is the fix
SHA in the built artifact", the Play Console "Send for review" click) print but
never flip the exit — the human gates the automation can't close.

Add a `preflight` block per app in `apps.json` (see `apps.example.json`):

```json
"preflight": {
  "urls": { "privacy": "https://…/privacy", "terms": "https://…/terms", "marketing": "https://…" },
  "well_known_host": "https://chat.example.com",
  "repo": "~/git/myapp",
  "required_keys": {
    "macos_plist": ["LSApplicationCategoryType"],
    "ios_plist":   ["ITSAppUsesNonExemptEncryption"]
  }
}
```

The `Info.plist` checks read from `repo` (or `--repo PATH`); every URL key is
checked, not just the well-known ones, so a required `account-deletion` URL is
covered too.
