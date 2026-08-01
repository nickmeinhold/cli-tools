#!/usr/bin/env python3
"""Drive the Google Play Developer API for any app.

App-agnostic: the package name and service-account key path come from the
appstore config (~/.config/appstore/apps.json — see appstore/apps.example.json),
selected with --app / $APPSTORE_APP / the config "default".

Auth: a Play-publisher service-account key (granted release permissions in Play
Console, NOT via GCP IAM).

Commands:
  verify                 prove access (open + abort an edit; changes nothing)
  status [--track T]     show track releases (default: internal)
  upload --aab F [--track T] [--notes TEXT]
                         upload an AAB, assign to a track, commit
  notes --text T [--track T] [--lang L]
                         set release notes on an existing track release (no re-upload)
  listing --title .. --short .. --full .. [--icon F] [--feature F] [--screenshots a,b]
                         update store listing text + images (lands as a Console DRAFT)
"""
import argparse
import os
import sys

# Resolve the tool's real directory (works through the ~/.local/bin symlink) so
# the shared config loader imports regardless of how the CLI was invoked.
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _appconfig  # noqa: E402

from google.oauth2 import service_account  # noqa: E402
from googleapiclient.discovery import build  # noqa: E402
from googleapiclient.http import MediaFileUpload  # noqa: E402

# Set once at runtime from the selected app's config (see main()).
PACKAGE = None
KEY = None
SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]


def _svc():
    creds = service_account.Credentials.from_service_account_file(KEY, scopes=SCOPES)
    return build("androidpublisher", "v3", credentials=creds, cache_discovery=False)


def verify(args):
    svc = _svc()
    edit = svc.edits().insert(packageName=PACKAGE, body={}).execute()
    eid = edit["id"]
    # Abort immediately — nothing is committed, so this is a pure read of access.
    svc.edits().delete(packageName=PACKAGE, editId=eid).execute()
    print(f"ACCESS OK — opened+aborted edit {eid} on {PACKAGE}")


def status(args):
    svc = _svc()
    edit = svc.edits().insert(packageName=PACKAGE, body={}).execute()
    eid = edit["id"]
    try:
        t = svc.edits().tracks().get(
            packageName=PACKAGE, editId=eid, track=args.track).execute()
        print(f"track={t.get('track')}")
        for r in t.get("releases", []):
            print(f"  status={r.get('status')} name={r.get('name')} "
                  f"versionCodes={r.get('versionCodes')}")
    finally:
        svc.edits().delete(packageName=PACKAGE, editId=eid).execute()


def upload(args):
    svc = _svc()
    edit = svc.edits().insert(packageName=PACKAGE, body={}).execute()
    eid = edit["id"]
    media = MediaFileUpload(args.aab, mimetype="application/octet-stream",
                            resumable=True)
    b = svc.edits().bundles().upload(
        packageName=PACKAGE, editId=eid, media_body=media).execute()
    vc = b["versionCode"]
    print(f"uploaded versionCode={vc}")
    release = {"status": "completed", "versionCodes": [vc]}
    if args.notes:
        release["releaseNotes"] = [{"language": "en-US", "text": args.notes}]
    svc.edits().tracks().update(
        packageName=PACKAGE, editId=eid, track=args.track,
        body={"track": args.track, "releases": [release]}).execute()
    # Some accounts require review to be triggered from the Console UI, not the
    # API: a plain commit 400s with "Changes cannot be sent for review
    # automatically." changesNotSentForReview=true commits the release as a
    # DRAFT on the track; a human then clicks "Send for review" in the Console.
    svc.edits().commit(
        packageName=PACKAGE, editId=eid,
        changesNotSentForReview=True).execute()
    print(f"committed versionCode={vc} to track={args.track} "
          f"(DRAFT — send for review in Play Console)")


def notes(args):
    """Set release notes on an existing track release (no re-upload)."""
    svc = _svc()
    edit = svc.edits().insert(packageName=PACKAGE, body={}).execute()
    eid = edit["id"]
    try:
        t = svc.edits().tracks().get(
            packageName=PACKAGE, editId=eid, track=args.track).execute()
        releases = t.get("releases", [])
        if not releases:
            print(f"no release on track {args.track}")
            svc.edits().delete(packageName=PACKAGE, editId=eid).execute()
            return
        rel = releases[0]
        rel["releaseNotes"] = [{"language": args.lang, "text": args.text}]
        svc.edits().tracks().update(
            packageName=PACKAGE, editId=eid, track=args.track,
            body={"track": args.track, "releases": [rel]}).execute()
        svc.edits().commit(packageName=PACKAGE, editId=eid).execute()
        print(f"release notes set on {args.track} (versionCodes={rel.get('versionCodes')})")
    except Exception:
        svc.edits().delete(packageName=PACKAGE, editId=eid).execute()
        raise


def listing(args):
    """Update store listing text + images (icon, feature graphic, screenshots),
    then commit. Lands as a DRAFT in Play Console — nothing is published live."""
    svc = _svc()
    edit = svc.edits().insert(packageName=PACKAGE, body={}).execute()
    eid = edit["id"]
    try:
        lang = args.lang
        if not lang:
            details = svc.edits().details().get(
                packageName=PACKAGE, editId=eid).execute()
            lang = details.get("defaultLanguage", "en-US")
        print(f"language={lang}")

        # 1. Text
        svc.edits().listings().update(
            packageName=PACKAGE, editId=eid, language=lang,
            body={
                "language": lang,
                "title": args.title,
                "shortDescription": args.short,
                "fullDescription": args.full,
            }).execute()
        print(f"listing text updated (title={args.title!r})")

        # 2. Icon + feature graphic (single-slot image types: upload replaces)
        for image_type, path in [("icon", args.icon),
                                 ("featureGraphic", args.feature)]:
            if not path:
                continue
            svc.edits().images().deleteall(
                packageName=PACKAGE, editId=eid, language=lang,
                imageType=image_type).execute()
            svc.edits().images().upload(
                packageName=PACKAGE, editId=eid, language=lang,
                imageType=image_type,
                media_body=MediaFileUpload(path, mimetype="image/png")).execute()
            print(f"uploaded {image_type} <- {os.path.basename(path)}")

        # 3. Phone screenshots (multi-slot: clear then upload in order)
        shots = [s for s in (args.screenshots or "").split(",") if s]
        if shots:
            svc.edits().images().deleteall(
                packageName=PACKAGE, editId=eid, language=lang,
                imageType="phoneScreenshots").execute()
            for s in shots:
                svc.edits().images().upload(
                    packageName=PACKAGE, editId=eid, language=lang,
                    imageType="phoneScreenshots",
                    media_body=MediaFileUpload(s, mimetype="image/png")).execute()
                print(f"uploaded phoneScreenshot <- {os.path.basename(s)}")

        svc.edits().commit(packageName=PACKAGE, editId=eid).execute()
        print(f"COMMITTED listing edit {eid} (draft in Console; not published live)")
    except Exception:
        svc.edits().delete(packageName=PACKAGE, editId=eid).execute()
        raise


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--app", default=None,
                   help="app name from ~/.config/appstore/apps.json "
                        "(else $APPSTORE_APP, else config default)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("verify")
    sp = sub.add_parser("status"); sp.add_argument("--track", default="internal")
    up = sub.add_parser("upload")
    up.add_argument("--aab", required=True)
    up.add_argument("--track", default="internal")
    up.add_argument("--notes", default="")
    nt = sub.add_parser("notes")
    nt.add_argument("--track", default="internal")
    nt.add_argument("--lang", default="en-US")
    nt.add_argument("--text", required=True)
    ls = sub.add_parser("listing")
    ls.add_argument("--lang", default="")  # blank => app default language
    ls.add_argument("--title", required=True)
    ls.add_argument("--short", required=True)
    ls.add_argument("--full", required=True)
    ls.add_argument("--icon", default="")
    ls.add_argument("--feature", default="")
    ls.add_argument("--screenshots", default="")  # comma-separated, in order
    args = p.parse_args()

    # Resolve the selected app's Play config into the runtime constants.
    global PACKAGE, KEY
    _, play = _appconfig.section(args.app, "play")
    PACKAGE = play["package"]
    KEY = os.path.expanduser(play["key"])

    {"verify": verify, "status": status, "upload": upload, "notes": notes,
     "listing": listing}[args.cmd](args)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
