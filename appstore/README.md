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
