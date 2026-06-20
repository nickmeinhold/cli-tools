#!/usr/bin/env python3
"""Incrementally sync Nick & the contact's iMessage thread into a durable JSONL corpus.

The Messages chat.db is the source of truth; this keeps a flat, append-only
mirror that Claude sessions and the responder can read cheaply without
re-decoding the whole DB each time.

- First run: full rebuild of the corpus from chat.db, records the high-water ROWID.
- Later runs: append only messages with ROWID greater than the high-water mark.
Idempotent and safe to run repeatedly (e.g. once per responder poll cycle).
"""
import sqlite3, struct, json, os, datetime

HANDLE = os.environ.get("CONTACT_HANDLE", "+10000000000")  # the contact you auto-reply to
DB      = os.path.expanduser("~/Library/Messages/chat.db")
CORPUS  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus.jsonl")
STATE   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus_state.json")

# attributedBody is a typedstream NSAttributedString: a fixed preamble then a
# length-prefixed UTF-8 string (0x81 -> uint16 LE length for strings >= 128 bytes).
PRE = b'NSString\x01\x94\x84\x01+'
def decode_body(blob):
    if not blob:
        return None
    p = blob.find(PRE)
    if p == -1:
        return None
    i = p + len(PRE)
    b0 = blob[i]; i += 1
    if b0 == 0x81:
        ln = struct.unpack('<H', blob[i:i+2])[0]; i += 2
    elif b0 == 0x82:
        ln = struct.unpack('<I', blob[i:i+4])[0]; i += 4
    else:
        ln = b0
    return blob[i:i+ln].decode('utf-8', 'replace')

def load_high_water():
    try:
        return json.load(open(STATE)).get("last_rowid", 0)
    except Exception:
        return 0

def save_high_water(rowid):
    json.dump({"last_rowid": rowid}, open(STATE, "w"))

def main():
    db = sqlite3.connect(DB)
    high = load_high_water()
    # First run (no state): rebuild from scratch so we supersede any stale snapshot.
    mode = "a" if high else "w"
    rows = db.execute("""
        SELECT m.ROWID, m.date, m.is_from_me, m.text, m.attributedBody
        FROM message m JOIN handle h ON m.handle_id = h.ROWID
        WHERE h.id = ? AND m.ROWID > ?
        ORDER BY m.ROWID ASC
    """, (HANDLE, high)).fetchall()

    written = 0
    max_rowid = high
    with open(CORPUS, mode) as f:
        for rowid, date, me, text, body in rows:
            max_rowid = max(max_rowid, rowid)          # advance even past skipped rows
            msg = text if (text and text.strip()) else decode_body(body)
            if msg is None:                            # attachment / reaction with no text
                continue
            ts = date / 1_000_000_000 + 978307200
            dt = datetime.datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M')
            f.write(json.dumps({"t": dt, "me": bool(me), "msg": msg}, ensure_ascii=False) + "\n")
            written += 1

    if max_rowid > high:
        save_high_water(max_rowid)
    print(f"corpus {'rebuilt' if mode=='w' else 'appended'}: +{written} messages, high-water ROWID={max_rowid}")

if __name__ == "__main__":
    main()
