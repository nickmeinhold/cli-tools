"""Per-app config for the appstore CLIs (asc + gplay).

One toolkit, many apps. The only thing that couples a distribution script to a
particular app is a handful of identifiers (Apple bundle id, Google package
name) and the paths to that app's credentials. Those live in a small JSON file
so the code stays app-agnostic:

    ~/.config/appstore/apps.json      (override with APPSTORE_CONFIG)

Shape (see apps.example.json):
    {
      "default": "aiko",
      "apps": {
        "aiko": {
          "asc":  { "bundle_id": "cc.imagineering.aikoChatApp",
                    "env": "~/keystores/aiko-asc.env" },
          "play": { "package": "cc.imagineering.aiko_chat_app",
                    "key": "~/keystores/aiko-play-publisher-sa.json" }
        }
      }
    }

App selection precedence:  --app FLAG  >  $APPSTORE_APP  >  config "default".
"""
import json
import os
import sys

CONFIG_PATH = os.environ.get(
    "APPSTORE_CONFIG", os.path.expanduser("~/.config/appstore/apps.json"))


def _load():
    if not os.path.exists(CONFIG_PATH):
        sys.exit(
            f"no app config at {CONFIG_PATH}\n"
            "create it (see appstore/apps.example.json) — one entry per app.")
    with open(CONFIG_PATH) as f:
        return json.load(f)


def resolve(app_flag=None):
    """Return (app_name, app_dict) for the selected app.

    app_dict is the per-app object, e.g. {"asc": {...}, "play": {...}}.
    Paths inside are returned verbatim; callers expanduser() what they use.
    """
    cfg = _load()
    apps = cfg.get("apps", {})
    name = app_flag or os.environ.get("APPSTORE_APP") or cfg.get("default")
    if not name:
        sys.exit("no app selected — pass --app, set $APPSTORE_APP, or add a "
                 f'"default" to {CONFIG_PATH}. known: {", ".join(sorted(apps)) or "(none)"}')
    if name not in apps:
        sys.exit(f'unknown app "{name}" — known: {", ".join(sorted(apps)) or "(none)"}')
    return name, apps[name]


def section(app_flag, key):
    """Resolve the app and return one platform section (e.g. "asc" / "play"),
    erroring clearly if the selected app has no config for that platform."""
    name, app = resolve(app_flag)
    if key not in app:
        sys.exit(f'app "{name}" has no "{key}" section in {CONFIG_PATH}')
    return name, app[key]
