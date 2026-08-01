#!/usr/bin/env python3
"""Drive the App Store Connect API for any app (iOS TestFlight + Mac App Store).

App-agnostic: the bundle id and credential paths come from the appstore config
(~/.config/appstore/apps.json — see appstore/apps.example.json), selected with
--app / $APPSTORE_APP / the config "default". No app identifiers are hardcoded.

Auth: an App Store Connect API key (Team key, App Manager role). Three inputs,
read from env or the app's asc.env file (KEY=VALUE lines):
  ASC_KEY_ID     the 10-char Key ID
  ASC_ISSUER_ID  the issuer UUID (top of the Integrations page)
  ASC_KEY_PATH   path to the AuthKey_<KEYID>.p8 (default ~/keystores/AuthKey_<KEYID>.p8)

The REST API is authenticated with a short-lived ES256 JWT signed by the .p8.
Binary upload itself goes through `xcrun altool`, which reads the same .p8 from
~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 (see `install-key`).

Commands:
  verify                 prove access (GET /v1/apps)
  app                    find the app record by bundle id
  builds [--limit N]     list recent TestFlight builds + processing state
  install-key            copy the .p8 to ~/.appstoreconnect/private_keys/ for altool
  upload --ipa F [--platform ios|macos]   upload a binary via altool

  --- Mac App Store (mas-*) — the fully API/CLI pipeline ---
  mas-status                          macOS version + latest macOS build + review state
  mas-package [--repo P]              flutter build + archive + exportArchive -> signed .pkg
  mas-upload --pkg F                  altool --upload-app -t macos
  mas-attach [--version V]            find latest VALID macOS build, attach to the macOS
                                      version (creating it for V if needed), answer export
                                      compliance (usesNonExemptEncryption=false)
  mas-mirror-metadata                 copy the live iOS listing (desc/keywords/support) onto
                                      the macOS version's en-* localization
  mas-screenshot --file F [--name N]  upload a macOS screenshot (reserve->PUT->commit-md5)
  mas-submit --confirm                create reviewSubmission(MAC_OS)+item, SUBMIT for review.
                                      FAIL-CLOSED: without --confirm it dry-runs and submits nothing.
  mas-release [--repo P] [--version V]   package -> upload -> wait-for-processing -> attach.
                                      Stops BEFORE submit (submit is a separate, confirmed step).

Screenshot sizing note: a 1280x800-point macOS window on a 2x Retina display
captures at exactly 2560x1600 px (an accepted App Store size). Resizing the app
window needs Accessibility granted to the terminal, and Flutter's canvas does not
accept synthetic taps, so in-app navigation between screens is a human step.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

# Resolve the tool's real directory (works through the ~/.local/bin symlink) so
# the shared config loader imports regardless of how the CLI was invoked.
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _appconfig  # noqa: E402
import preflight  # noqa: E402

# Set once at runtime from the selected app's config (see main()).
BUNDLE_ID = None
ENV_FILE = None
API = "https://api.appstoreconnect.apple.com"


def _cfg():
    cfg = {}
    if ENV_FILE and os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    cfg[k.strip()] = v.strip()
    for k in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH"):
        if os.environ.get(k):
            cfg[k] = os.environ[k]
    if "ASC_KEY_ID" not in cfg or "ASC_ISSUER_ID" not in cfg:
        sys.exit(f"missing ASC_KEY_ID / ASC_ISSUER_ID (set env or {ENV_FILE})")
    cfg.setdefault("ASC_KEY_PATH",
                   os.path.expanduser(f"~/keystores/AuthKey_{cfg['ASC_KEY_ID']}.p8"))
    return cfg


def _token(cfg):
    import jwt  # PyJWT
    with open(cfg["ASC_KEY_PATH"]) as f:
        private_key = f.read()
    now = int(time.time())
    payload = {"iss": cfg["ASC_ISSUER_ID"], "iat": now,
               "exp": now + 1200, "aud": "appstoreconnect-v1"}
    headers = {"kid": cfg["ASC_KEY_ID"], "typ": "JWT"}
    return jwt.encode(payload, private_key, algorithm="ES256", headers=headers)


def _req(cfg, path, method="GET", body=None):
    """One authenticated JSON request. Handles empty (204) bodies — a PATCH to a
    relationships endpoint returns no content, which json.load would choke on."""
    url = path if path.startswith("http") else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {_token(cfg)}",
        "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def _get(cfg, path):
    return _req(cfg, path)


def verify(args):
    cfg = _cfg()
    apps = _get(cfg, "/v1/apps?limit=5").get("data", [])
    print(f"ACCESS OK — {len(apps)} app(s) visible:")
    for a in apps:
        at = a["attributes"]
        print(f"  {at.get('bundleId')}  ({at.get('name')})  id={a['id']}")


def _find_app(cfg):
    apps = _get(cfg, f"/v1/apps?filter[bundleId]={BUNDLE_ID}").get("data", [])
    return apps[0] if apps else None


def _app_id(cfg):
    a = _find_app(cfg)
    if not a:
        sys.exit(f"no app record for {BUNDLE_ID}")
    return a["id"]


def app(args):
    cfg = _cfg()
    a = _find_app(cfg)
    if not a:
        print(f"NO app record for {BUNDLE_ID} — create it in ASC (My Apps -> +).")
        sys.exit(2)
    at = a["attributes"]
    print(f"app id={a['id']} bundleId={at.get('bundleId')} name={at.get('name')} "
          f"sku={at.get('sku')}")


def builds(args):
    cfg = _cfg()
    aid = _app_id(cfg)
    data = _get(cfg, f"/v1/builds?filter[app]={aid}"
                     f"&limit={args.limit}&sort=-version")
    for b in data.get("data", []):
        at = b["attributes"]
        print(f"  build {at.get('version')}  state={at.get('processingState')}  "
              f"expired={at.get('expired')}  uploaded={at.get('uploadedDate')}")


def install_key(args):
    cfg = _cfg()
    dst_dir = os.path.expanduser("~/.appstoreconnect/private_keys")
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, f"AuthKey_{cfg['ASC_KEY_ID']}.p8")
    shutil.copy2(cfg["ASC_KEY_PATH"], dst)
    print(f"installed key for altool -> {dst}")


def upload(args):
    cfg = _cfg()
    plat = getattr(args, "platform", "ios")
    cmd = ["xcrun", "altool", "--upload-app", "-f", args.ipa, "-t", plat,
           "--apiKey", cfg["ASC_KEY_ID"], "--apiIssuer", cfg["ASC_ISSUER_ID"]]
    print("+", " ".join(cmd))
    sys.exit(subprocess.call(cmd))


# --------------------------------------------------------------------------- #
# Mac App Store pipeline
# --------------------------------------------------------------------------- #

def _versions(cfg, aid):
    return _get(cfg, f"/v1/apps/{aid}/appStoreVersions?limit=20")["data"]


def _mac_version(cfg, aid, create_version=None):
    """Return the MAC_OS appStoreVersion. If none exists and create_version is
    given, create one (this is also how macOS gets enabled on an iOS-only
    record — POST platform=MAC_OS)."""
    for v in _versions(cfg, aid):
        if v["attributes"]["platform"] == "MAC_OS":
            return v
    if not create_version:
        return None
    body = {"data": {"type": "appStoreVersions",
            "attributes": {"platform": "MAC_OS", "versionString": create_version},
            "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}}
    v = _req(cfg, "/v1/appStoreVersions", "POST", body)["data"]
    print(f"  created MAC_OS version {create_version} ({v['id']})")
    return v


def _latest_mac_build(cfg, aid):
    """Newest macOS build + its processing state (macOS distinguished by the
    build's preReleaseVersion.platform)."""
    resp = _get(cfg, f"/v1/builds?filter[app]={aid}&limit=15"
                     f"&sort=-uploadedDate&include=preReleaseVersion")
    inc = {i["id"]: i for i in resp.get("included", [])}
    for b in resp["data"]:
        pr = b.get("relationships", {}).get("preReleaseVersion", {}).get("data")
        plat = inc.get(pr["id"], {}).get("attributes", {}).get("platform") if pr else None
        if plat == "MAC_OS":
            return b
    return None


def mas_status(args):
    cfg = _cfg()
    aid = _app_id(cfg)
    v = _mac_version(cfg, aid)
    print(f"macOS version: {v['attributes']['versionString'] if v else '(none)'} "
          f"state={v['attributes']['appStoreState'] if v else '-'}")
    b = _latest_mac_build(cfg, aid)
    if b:
        ba = b["attributes"]
        print(f"latest macOS build: v{ba.get('version')} "
              f"processing={ba.get('processingState')} uploaded={ba.get('uploadedDate')}")
    else:
        print("latest macOS build: (none surfaced yet — may still be processing)")
    for rs in _get(cfg, f"/v1/reviewSubmissions?filter[app]={aid}&limit=5")["data"]:
        ra = rs["attributes"]
        print(f"reviewSubmission {ra.get('platform')} -> {ra.get('state')}")


def _pubspec_version(repo):
    """marketing version = the part before '+' in pubspec 'version:'."""
    ps = os.path.join(repo, "pubspec.yaml")
    with open(ps) as f:
        for line in f:
            if line.startswith("version:"):
                return line.split(":", 1)[1].strip().split("+")[0]
    return None


def mas_package(args):
    """flutter build macos --release -> xcodebuild archive -> exportArchive."""
    repo = os.path.abspath(args.repo)
    arch = os.path.join(repo, "build/macos-archive/Runner.xcarchive")
    out = os.path.join(repo, "build/mas-export")
    opts = os.path.join(repo, "macos/ExportOptions.plist")
    if not os.path.exists(opts):
        sys.exit(f"missing {opts} (method=app-store manual dist signing)")
    shutil.rmtree(os.path.join(repo, "build/macos-archive"), ignore_errors=True)
    shutil.rmtree(out, ignore_errors=True)
    steps = [
        ["flutter", "build", "macos", "--release"],
        ["xcodebuild", "-workspace", "macos/Runner.xcworkspace", "-scheme", "Runner",
         "-configuration", "Release", "-archivePath", arch, "archive"],
        ["xcodebuild", "-exportArchive", "-archivePath", arch, "-exportPath", out,
         "-exportOptionsPlist", opts, "-allowProvisioningUpdates"],
    ]
    for cmd in steps:
        print("+", " ".join(cmd))
        if subprocess.call(cmd, cwd=repo) != 0:
            sys.exit(f"step failed: {cmd[0]} {cmd[1] if len(cmd) > 1 else ''}")
    pkgs = [f for f in os.listdir(out) if f.endswith(".pkg")]
    if not pkgs:
        sys.exit(f"no .pkg produced in {out}")
    pkg = os.path.join(out, pkgs[0])
    print(f"PKG: {pkg}")
    return pkg


def mas_upload(args):
    cfg = _cfg()
    cmd = ["xcrun", "altool", "--upload-app", "-f", args.pkg, "-t", "macos",
           "--apiKey", cfg["ASC_KEY_ID"], "--apiIssuer", cfg["ASC_ISSUER_ID"]]
    print("+", " ".join(cmd))
    rc = subprocess.call(cmd)
    if rc != 0:
        sys.exit(rc)


def mas_attach(args):
    cfg = _cfg()
    aid = _app_id(cfg)
    v = _mac_version(cfg, aid, create_version=getattr(args, "version", None))
    if not v:
        sys.exit("no MAC_OS version — pass --version to create one")
    b = _latest_mac_build(cfg, aid)
    if not b:
        sys.exit("no macOS build found (still processing?) — retry mas-status later")
    if b["attributes"]["processingState"] != "VALID":
        sys.exit(f"macOS build not VALID yet (state={b['attributes']['processingState']})")
    _req(cfg, f"/v1/appStoreVersions/{v['id']}/relationships/build", "PATCH",
         {"data": {"type": "builds", "id": b["id"]}})
    _req(cfg, f"/v1/builds/{b['id']}", "PATCH",
         {"data": {"type": "builds", "id": b["id"],
                   "attributes": {"usesNonExemptEncryption": False}}})
    print(f"attached macOS build v{b['attributes'].get('version')} + set export compliance")


def _mac_localizations(cfg, aid):
    v = _mac_version(cfg, aid)
    if not v:
        sys.exit("no MAC_OS version yet")
    return v, _get(cfg, f"/v1/appStoreVersions/{v['id']}/appStoreVersionLocalizations")["data"]


def mas_mirror_metadata(args):
    """Copy the live iOS listing's description/keywords/supportUrl onto macOS."""
    cfg = _cfg()
    aid = _app_id(cfg)
    iosv = next(v for v in _versions(cfg, aid) if v["attributes"]["platform"] == "IOS")
    ia = _get(cfg, f"/v1/appStoreVersions/{iosv['id']}/appStoreVersionLocalizations"
              )["data"][0]["attributes"]
    _, mlocs = _mac_localizations(cfg, aid)
    attrs = {"description": ia.get("description"), "keywords": ia.get("keywords"),
             "supportUrl": ia.get("supportUrl")}
    for l in mlocs:
        _req(cfg, f"/v1/appStoreVersionLocalizations/{l['id']}", "PATCH",
             {"data": {"type": "appStoreVersionLocalizations", "id": l["id"],
                       "attributes": attrs}})
        print(f"  mirrored onto {l['attributes']['locale']}")


def mas_screenshot(args):
    cfg = _cfg()
    aid = _app_id(cfg)
    _, mlocs = _mac_localizations(cfg, aid)
    loc = mlocs[0]["id"]
    ds = "APP_DESKTOP"
    sets = _get(cfg, f"/v1/appStoreVersionLocalizations/{loc}/appScreenshotSets")["data"]
    sid = next((s["id"] for s in sets
                if s["attributes"]["screenshotDisplayType"] == ds), None)
    if not sid:
        sid = _req(cfg, "/v1/appScreenshotSets", "POST",
                   {"data": {"type": "appScreenshotSets",
                             "attributes": {"screenshotDisplayType": ds},
                             "relationships": {"appStoreVersionLocalization":
                                 {"data": {"type": "appStoreVersionLocalizations",
                                           "id": loc}}}}})["data"]["id"]
    data = open(args.file, "rb").read()
    name = getattr(args, "name", None) or os.path.basename(args.file)
    res = _req(cfg, "/v1/appScreenshots", "POST",
               {"data": {"type": "appScreenshots",
                         "attributes": {"fileSize": len(data), "fileName": name},
                         "relationships": {"appScreenshotSet":
                             {"data": {"type": "appScreenshotSets", "id": sid}}}}})
    shot_id = res["data"]["id"]
    for op in res["data"]["attributes"]["uploadOperations"]:
        chunk = data[op["offset"]:op["offset"] + op["length"]]
        hdrs = {h["name"]: h["value"] for h in op["requestHeaders"]}
        urllib.request.urlopen(urllib.request.Request(
            op["url"], data=chunk, method=op["method"], headers=hdrs))
    _req(cfg, f"/v1/appScreenshots/{shot_id}", "PATCH",
         {"data": {"type": "appScreenshots", "id": shot_id,
                   "attributes": {"uploaded": True,
                                  "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
    n = len(_get(cfg, f"/v1/appScreenshotSets/{sid}/appScreenshots")["data"])
    print(f"uploaded {name}; macOS listing now has {n} screenshot(s)")


def mas_submit(args):
    """Create + submit the macOS review submission. FAIL-CLOSED: --confirm required."""
    cfg = _cfg()
    aid = _app_id(cfg)
    v = _mac_version(cfg, aid)
    if not v:
        sys.exit("no MAC_OS version to submit")
    if not getattr(args, "confirm", False):
        print("DRY RUN — would submit macOS version "
              f"{v['attributes']['versionString']} ({v['attributes']['appStoreState']}) "
              "to Apple review. Re-run with --confirm to actually submit.")
        return
    rs = _req(cfg, "/v1/reviewSubmissions", "POST",
              {"data": {"type": "reviewSubmissions",
                        "attributes": {"platform": "MAC_OS"},
                        "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}})
    rsid = rs["data"]["id"]
    _req(cfg, "/v1/reviewSubmissionItems", "POST",
         {"data": {"type": "reviewSubmissionItems",
                   "relationships": {
                       "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": rsid}},
                       "appStoreVersion": {"data": {"type": "appStoreVersions", "id": v["id"]}}}}})
    r = _req(cfg, f"/v1/reviewSubmissions/{rsid}", "PATCH",
             {"data": {"type": "reviewSubmissions", "id": rsid,
                       "attributes": {"submitted": True}}})
    print(f"SUBMITTED — state: {r['data']['attributes'].get('state')}")


def mas_release(args):
    """package -> upload -> wait for processing -> attach. STOPS before submit."""
    cfg = _cfg()
    aid = _app_id(cfg)
    version = getattr(args, "version", None) or _pubspec_version(os.path.abspath(args.repo))
    pkg = mas_package(args)
    args.pkg = pkg
    mas_upload(args)
    print("waiting for Apple to process the build (first macOS build can take 15-30 min)...")
    for _ in range(40):  # ~20 min
        b = _latest_mac_build(cfg, aid)
        if b and b["attributes"]["processingState"] == "VALID":
            break
        time.sleep(30)
    args.version = version
    mas_attach(args)
    print("RELEASE staged. Next: mas-screenshot (as needed), then mas-submit --confirm.")


def _asc_build_result():
    """Check 1 (automatable part): the latest build number ASC already has, so
    the caller can confirm their next upload uses a fresh one. Best-effort —
    missing creds/network degrade to MANUAL, they never abort the URL checks."""
    try:
        cfg = _cfg()
        aid = _app_id(cfg)
        blds = _get(cfg, f"/v1/builds?filter[app]={aid}&limit=1&sort=-version").get("data", [])
        if blds:
            v = blds[0]["attributes"].get("version")
            return preflight.Result("build:latest-asc", preflight.INFO,
                                    f"latest ASC build = {v}; next upload must use a fresh number")
        return preflight.Result("build:latest-asc", preflight.WARN, "no builds visible yet")
    except SystemExit as e:  # _cfg()/_app_id() exit on missing creds/app record
        return preflight.Result("build:latest-asc", preflight.MANUAL, f"could not query ASC: {e}")
    except Exception as e:
        return preflight.Result("build:latest-asc", preflight.MANUAL,
                                f"could not query ASC: {type(e).__name__}: {e}")


def preflight_cmd(args):
    """Audit iOS/macOS submission preconditions (see preflight.py + the spec)."""
    name, pf = preflight.get_config(args.app)
    repo = preflight.resolve_repo(pf, getattr(args, "repo", None))
    results = []
    # 1 · fresh build number (automatable) + the fix-is-in-the-artifact human gate
    results.append(_asc_build_result())
    results.append(preflight.Result("build:fix-in-artifact", preflight.WARN,
        "confirm the intended fix SHA is in the built artifact, not merely on main"))
    # 2 · every metadata URL resolves 200
    results += preflight.check_urls(pf.get("urls"))
    # 3 · AASA served + the on-device passkey gate (sole ingress)
    results.append(preflight.check_aasa(pf.get("well_known_host")))
    results.append(preflight.Result("passkey:on-device", preflight.MANUAL,
        "vs prod on the target platform: tap 'Create a passkey' (not Sign in) on a "
        "fresh device, authenticate, confirm you reach the chat"))
    # 4 · submit capability (per-account constant)
    results.append(preflight.Result("submit:capability", preflight.INFO,
        "iOS/macOS submit via ASC API (asc mas-submit --confirm)"))
    # 5 · platform-required Info.plist keys
    rk = pf.get("required_keys", {})
    results += preflight.check_plist_keys(repo, "macos/Runner/Info.plist", rk.get("macos_plist", []))
    results += preflight.check_plist_keys(repo, "ios/Runner/Info.plist", rk.get("ios_plist", []))
    sys.exit(preflight.emit("asc", name, results))


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--app", default=None,
                   help="app name from ~/.config/appstore/apps.json "
                        "(else $APPSTORE_APP, else config default)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("verify")
    sub.add_parser("app")
    b = sub.add_parser("builds"); b.add_argument("--limit", type=int, default=10)
    sub.add_parser("install-key")
    up = sub.add_parser("upload")
    up.add_argument("--ipa", required=True)
    up.add_argument("--platform", default="ios", choices=["ios", "macos"])
    # mas-*
    sub.add_parser("mas-status")
    pk = sub.add_parser("mas-package"); pk.add_argument("--repo", default=".")
    mu = sub.add_parser("mas-upload"); mu.add_argument("--pkg", required=True)
    at = sub.add_parser("mas-attach"); at.add_argument("--version", default=None)
    sub.add_parser("mas-mirror-metadata")
    sc = sub.add_parser("mas-screenshot")
    sc.add_argument("--file", required=True); sc.add_argument("--name", default=None)
    sm = sub.add_parser("mas-submit"); sm.add_argument("--confirm", action="store_true")
    rl = sub.add_parser("mas-release")
    rl.add_argument("--repo", default="."); rl.add_argument("--version", default=None)
    pf = sub.add_parser("preflight")
    pf.add_argument("--repo", default=None,
                    help="flutter project root for Info.plist checks "
                         "(else preflight.repo in the app config)")
    args = p.parse_args()

    # Resolve the selected app's Apple config into the runtime constants.
    global BUNDLE_ID, ENV_FILE
    _, asc = _appconfig.section(args.app, "asc")
    BUNDLE_ID = asc["bundle_id"]
    ENV_FILE = os.path.expanduser(asc.get("env", "")) if asc.get("env") else None

    {"verify": verify, "app": app, "builds": builds, "install-key": install_key,
     "upload": upload, "mas-status": mas_status, "mas-package": mas_package,
     "mas-upload": mas_upload, "mas-attach": mas_attach,
     "mas-mirror-metadata": mas_mirror_metadata, "mas-screenshot": mas_screenshot,
     "mas-submit": mas_submit, "mas-release": mas_release,
     "preflight": preflight_cmd}[args.cmd](args)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR HTTP {e.code}: {e.read().decode(errors='replace')}")
    except Exception as e:
        sys.exit(f"ERROR: {type(e).__name__}: {e}")
