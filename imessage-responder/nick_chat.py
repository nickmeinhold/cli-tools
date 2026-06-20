#!/usr/bin/env python3
"""Let Nick chat with Claude by text. He messages his OWN iMessage thread
(Note-to-Self, owner@example.com) starting a line with "Claude ..." and
gets a 🤖 reply. This is the full assistant (web search, no Contact guardrails) —
it's just Nick talking to Claude, on his phone.

Runs on the Mac (needs Full Disk Access + the Max-plan claude login), polled by
its own LaunchAgent, independent of the Contact responder.

LOOP SAFETY (critical, because the self-thread has everything as is_from_me=1):
  - A message counts as a Nick query only if it starts with "claude" AND does
    NOT start with "🤖" (our own replies) or "[" (the imessage-responder's
    notifications, prefixed "[imessage-responder]").
  - Every message is processed once via a monotonic ROWID high-water mark.
  Together these make it impossible for the bot to answer itself.
"""
import sqlite3, struct, subprocess, os, json, tempfile

NICK_HANDLE = os.environ.get("OWNER_HANDLE", "owner@example.com")
HERE   = os.path.dirname(os.path.abspath(__file__))
DB     = os.path.expanduser("~/Library/Messages/chat.db")
STATE  = os.path.join(HERE, "nick_chat_state.json")
ROBOT  = "🤖 "
CLAUDE_TIMEOUT = 180

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

def send(text):
    """Send to Nick's own thread via Messages, text routed through a temp file."""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
        tf.write(text); path = tf.name
    script = f'''
    set msg to (read POSIX file "{path}" as «class utf8»)
    tell application "Messages"
      set svc to 1st service whose service type = iMessage
      send msg to buddy "{NICK_HANDLE}" of svc
    end tell'''
    subprocess.run(["osascript", "-e", script], timeout=30, check=True)
    os.unlink(path)

def is_nick_query(text):
    if not text:
        return False
    t = text.lstrip()
    if t.startswith(ROBOT.strip()) or t.startswith("["):   # our reply / a notification
        return False
    return t.lower().startswith("claude")

def load_high():
    try:
        return json.load(open(STATE)).get("last_rowid")
    except Exception:
        return None

def save_high(rowid):
    json.dump({"last_rowid": rowid}, open(STATE, "w"))

def generate(query):
    """Full Claude (web search on), no Contact guardrails. outputStyle=default so the
    Explanatory style doesn't glue insight blocks onto the text reply."""
    prompt = ("You are Claude, replying to Nick by text message. He is your collaborator. "
              "Be helpful, concise and casual (text length). Web search when useful. "
              "Output only the message.\n\nNick: " + query)
    res = subprocess.run(
        ["claude", "-p", prompt, "--output-format", "text",
         "--settings", '{"outputStyle":"default"}',
         "--allowedTools", "WebSearch", "WebFetch"],
        capture_output=True, text=True, timeout=CLAUDE_TIMEOUT
    )
    return res.stdout.strip()

def main():
    db = sqlite3.connect(DB)
    high = load_high()
    if high is None:                       # arm-only: ignore backlog
        mx = db.execute("""SELECT MAX(m.ROWID) FROM message m JOIN handle h
                           ON m.handle_id=h.ROWID WHERE h.id=?""", (NICK_HANDLE,)).fetchone()[0] or 0
        save_high(mx)
        return

    rows = db.execute("""
        SELECT m.ROWID, m.text, m.attributedBody
        FROM message m JOIN handle h ON m.handle_id=h.ROWID
        WHERE h.id=? AND m.ROWID > ?
        ORDER BY m.ROWID ASC""", (NICK_HANDLE, high)).fetchall()
    if not rows:
        return

    new_high = max(r[0] for r in rows)
    queries = [t for t in ((r[1] if (r[1] and r[1].strip()) else decode_body(r[2])) for r in rows)
               if is_nick_query(t)]
    if not queries:
        save_high(new_high)                # nothing addressed to Claude; just advance
        return

    # strip the leading "claude" / "claude," from the most recent query
    q = queries[-1]
    q = q.lstrip()[len("claude"):].lstrip(" ,:-").strip() or q
    try:
        reply = generate(q)
        if reply:
            send(ROBOT + reply)
    except Exception as e:
        try:
            send(ROBOT + f"(error: {e})")
        except Exception:
            pass
    finally:
        save_high(new_high)

if __name__ == "__main__":
    main()
