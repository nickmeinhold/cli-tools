"""Shared pre-submission preflight checks for the appstore CLIs (asc + gplay).

`asc preflight` / `gplay preflight` audit the submission preconditions that were
walls at the 2026-07 launch gate — run them BEFORE you submit. The crux:
distribution is artifact-grounded; every rejection came from a precondition that
was true on `main` but not in the submitted artifact / live platform. Repo intent
!= submitted reality — verify the reality. Keep a human-readable spec (one
war-story per check) alongside the app it audits, in that app's own docs.

Config: a per-app "preflight" block in ~/.config/appstore/apps.json, sibling to
the "asc"/"play" blocks (see apps.example.json):

    "preflight": {
      "urls": {"privacy": "https://.../privacy", "terms": "https://.../terms",
               "marketing": "https://..."},
      "well_known_host": "https://chat.example.com",
      "repo": "~/git/myapp",
      "required_keys": {
        "macos_plist": ["LSApplicationCategoryType"],
        "ios_plist":   ["ITSAppUsesNonExemptEncryption"]
      }
    }

Fail-closed: any hard FAIL makes `preflight` exit nonzero so it can gate a submit
in a script. WARN/MANUAL/INFO items print but never fail the run on their own —
they flag the human gates (on-device passkey test, "is the fix SHA in the built
artifact", the Play Console "Send for review" click) the automation can't close.
"""
import json
import os
import plistlib
import sys
import urllib.error
import urllib.request

# Resolve the tool's real directory (works through the ~/.local/bin symlink) so
# the shared config loader imports regardless of how the CLI was invoked.
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _appconfig  # noqa: E402

# Status tags. Plain ASCII — output is routinely piped/greped, so no colour.
PASS = "PASS"
FAIL = "FAIL"      # hard failure -> nonzero exit (gates a submit)
WARN = "WARN"      # automatable-but-needs-a-human-confirm; never fails the run
MANUAL = "MANUAL"  # a gate the automation can't close (e.g. on-device passkey)
INFO = "INFO"      # a per-account constant worth stating

_FAILING = {FAIL}


class Result:
    """One preflight check outcome."""
    __slots__ = ("check", "status", "detail")

    def __init__(self, check, status, detail=""):
        self.check = check
        self.status = status
        self.detail = detail


# --------------------------------------------------------------------------- #
# Low-level probes
# --------------------------------------------------------------------------- #

def _http_status(url, timeout=15):
    """GET url following redirects; return (code, error_or_None). An HTTP error
    status (404 etc.) is a code, not an exception — only transport failures
    (DNS, timeout, TLS) come back as an error string."""
    req = urllib.request.Request(
        url, method="GET", headers={"User-Agent": "appstore-preflight"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # URLError, timeout, TLS, ...
        return None, f"{type(e).__name__}: {e}"


def _http_body(url, timeout=15):
    """GET url; return (code, text). Raises on transport failure."""
    req = urllib.request.Request(
        url, method="GET", headers={"User-Agent": "appstore-preflight"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


# --------------------------------------------------------------------------- #
# Check 2 — every metadata URL resolves 200
# --------------------------------------------------------------------------- #

def check_urls(urls):
    """EVERY configured metadata URL must resolve 200. A 404/500/transport error
    is a hard FAIL (a dead privacy/support/marketing/account-deletion URL =
    rejection or a broken public listing). No silent caps: known labels print in
    a stable order, then ANY other configured URL key (e.g. account-deletion) is
    checked too — never dropped just because it isn't in the known set."""
    urls = urls or {}
    known = ("privacy", "terms", "support", "marketing")
    ordered = [k for k in known if k in urls] + [k for k in urls if k not in known]
    results = []
    for label in ordered:
        url = urls[label]
        if not url:
            results.append(Result(f"url:{label}", MANUAL, "configured empty"))
            continue
        code, err = _http_status(url)
        if err:
            results.append(Result(f"url:{label}", FAIL, f"{url} -> {err}"))
        else:
            results.append(Result(f"url:{label}",
                                  PASS if code == 200 else FAIL, f"[{code}] {url}"))
    if not results:
        results.append(Result("url:*", MANUAL, "no preflight.urls configured"))
    return results


# --------------------------------------------------------------------------- #
# Check 3 — well-known auth files carry the right relations
# --------------------------------------------------------------------------- #

def check_aasa(host):
    """Apple: the AASA file must be served (200) for the associated domain, or
    Universal Links / passkey association silently break."""
    if not host:
        return Result("aasa", MANUAL, "no preflight.well_known_host configured")
    url = host.rstrip("/") + "/.well-known/apple-app-site-association"
    code, err = _http_status(url)
    if err:
        return Result("aasa", FAIL, f"{url} -> {err}")
    return Result("aasa", PASS if code == 200 else FAIL, f"[{code}] {url}")


def check_assetlinks(host):
    """Android Digital Asset Links must carry BOTH relations:
      - delegate_permission/common.get_login_creds  (passkeys — sole ingress)
      - delegate_permission/common.handle_all_urls   (App Links)
    Either missing = FAIL. Google's own assetlinks:check tool can stay green
    while one relation is absent (a lying proxy that cost two launch days), so we
    read the served file ourselves and assert on its contents."""
    if not host:
        return [Result("assetlinks", MANUAL, "no preflight.well_known_host configured")]
    url = host.rstrip("/") + "/.well-known/assetlinks.json"
    try:
        code, body = _http_body(url)
    except Exception as e:
        return [Result("assetlinks", FAIL, f"{url} -> {type(e).__name__}: {e}")]
    if code != 200:
        return [Result("assetlinks", FAIL, f"[{code}] {url}")]
    try:
        data = json.loads(body)
    except Exception as e:
        return [Result("assetlinks", FAIL, f"invalid JSON at {url}: {e}")]
    present = set()
    for entry in data if isinstance(data, list) else []:
        for rel in entry.get("relation", []):
            if "get_login_creds" in rel:
                present.add("get_login_creds")
            if "handle_all_urls" in rel:
                present.add("handle_all_urls")
    results = []
    for rel in ("get_login_creds", "handle_all_urls"):
        ok = rel in present
        results.append(Result(f"assetlinks:{rel}", PASS if ok else FAIL,
                              url if ok else f"MISSING relation at {url}"))
    return results


# --------------------------------------------------------------------------- #
# Check 5 — platform-required manifest / Info.plist keys are present
# --------------------------------------------------------------------------- #

def check_plist_keys(repo, rel_path, keys):
    """Each key must be present in the plist at repo/rel_path. Without a repo
    path the check can't run — MANUAL, not a false PASS."""
    if not keys:
        return []
    if not repo:
        return [Result(f"{rel_path}:{k}", MANUAL,
                      "no repo (pass --repo or set preflight.repo)") for k in keys]
    path = os.path.join(os.path.expanduser(repo), rel_path)
    if not os.path.exists(path):
        return [Result(f"{rel_path}:{k}", FAIL, f"plist not found: {path}") for k in keys]
    try:
        with open(path, "rb") as f:
            pl = plistlib.load(f)
    except Exception as e:
        return [Result(f"{rel_path}:{k}", FAIL, f"unreadable plist: {e}") for k in keys]
    results = []
    for k in keys:
        if k in pl:
            results.append(Result(f"{rel_path}:{k}", PASS, f"present = {pl[k]!r}"))
        else:
            results.append(Result(f"{rel_path}:{k}", FAIL, f"missing from {path}"))
    return results


# --------------------------------------------------------------------------- #
# Config + rendering
# --------------------------------------------------------------------------- #

def get_config(app_flag):
    """Return (app_name, preflight_dict) for the selected app. The preflight
    block is optional — an empty dict means every config-driven check degrades
    to MANUAL rather than crashing."""
    name, app = _appconfig.resolve(app_flag)
    return name, app.get("preflight", {})


def resolve_repo(pf, repo_flag):
    """--repo flag wins over config preflight.repo; either may be None."""
    return repo_flag or pf.get("repo")


def emit(platform, app_name, results):
    """Print every result (no silent caps) and return an exit code: 1 if any
    hard FAIL, else 0. WARN/MANUAL/INFO never flip the exit on their own."""
    print(f"preflight [{platform}] app={app_name}")
    for r in results:
        line = f"  {r.status:<6} {r.check}"
        if r.detail:
            line += f"  — {r.detail}"
        print(line)
    n_fail = sum(1 for r in results if r.status in _FAILING)
    n_warn = sum(1 for r in results if r.status == WARN)
    n_manual = sum(1 for r in results if r.status == MANUAL)
    print(f"\n{len(results)} checks · {n_fail} FAIL · {n_warn} WARN · {n_manual} MANUAL")
    if n_fail:
        print("RESULT: FAIL — resolve hard failures before submitting.")
        return 1
    print("RESULT: OK — automated preconditions pass "
          "(mind the WARN/MANUAL human gates).")
    return 0
