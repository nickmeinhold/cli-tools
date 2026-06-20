#!/usr/bin/env python3
"""Autonomous 🤖 responder for Nick & the contact's iMessage thread.

Polled by a LaunchAgent. Each run:
  1. Syncs the durable corpus from chat.db.
  2. Finds new inbound messages from Contact since the last reply high-water.
  3. Generates a reply with HEADLESS Claude Code (Max plan, zero marginal cost),
     guided by system-prompt.txt.
  4. Sends it via Messages, auto-prefixed with 🤖, OR escalates to Nick on Telegram
     for sensitive topics (his intentions, his private disclosures, her vulnerabilities).

Safety properties:
  - First run ARMS ONLY: it records the current newest ROWID and sends nothing, so the
    existing backlog (including any tender unanswered question) is never auto-answered.
  - Everything the responder sees and says is mirrored to Nick on Telegram. No surprises.
  - On any error it notifies Nick and exits rather than sending something half-formed.
"""
import sqlite3, struct, subprocess, sys, os, json, datetime, tempfile, re

HANDLE = os.environ.get("CONTACT_HANDLE", "+10000000000")  # the contact you auto-reply to
HERE   = os.path.dirname(os.path.abspath(__file__))
DB     = os.path.expanduser("~/Library/Messages/chat.db")
CORPUS = os.path.join(HERE, "corpus.jsonl")
SYNC   = os.path.join(HERE, "corpus_sync.py")
SYSTEM = os.path.join(HERE, "system-prompt.txt")
DOSSIER= os.path.join(HERE, "nick-dossier.txt")   # curated "who Nick is" portrait
STATE  = os.path.join(HERE, "reply_state.json")
ROBOT  = "🤖 "
# Notifications go to Nick's OWN iMessage thread (Note-to-Self), never the contact's.
NICK_HANDLE = os.environ.get("OWNER_HANDLE", "owner@example.com")
assert NICK_HANDLE != HANDLE, "FATAL: notify target must differ from the contact's handle"
CONTEXT_LINES = 30          # (legacy) recent-thread window, kept for recent_context()
# How much of the FULL text history to feed the model each reply (working memory).
# The ENRICHED dossier carries the long-term memory of the whole relationship, so we
# only need a short recent window here for live continuity. ~250 lines ~= last 2-3 days
# ~= ~6k tokens total/reply, flat (does not grow unboundedly like the full corpus did).
# Set to None to fall back to the entire corpus.
HISTORY_LINES = 250
CLAUDE_TIMEOUT = 180
# The bot is a SUMMONED GUEST, not the default voice. It only replies when Contact
# explicitly invokes it. Her ordinary messages to Nick are his to answer.
TRIGGERS = ("claude", "🤖")
# Nick can ALSO summon the 🤖 guest from his own side of the thread (added 2026-06-16,
# his request). His reply is sent INTO the thread for Contact to see - a public cameo he
# invited. Stricter than the contact's substring TRIGGERS: the message must START by addressing
# Claude ("Claude ...", "Hey Claude ..."), so Nick narrating ABOUT the bot to Contact
# ("I'm fixing claude") does NOT accidentally fire a cameo. The model's SILENT control
# token is the backstop if an addressed-looking message turns out not to be for the bot.
NICK_SUMMON_RE = re.compile(r'^\s*(?:hey |hi |ok |so |oi |yo )?claude\b', re.IGNORECASE)

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

def _imessage(handle, text):
    """Send `text` to `handle` via Messages.app. Routed through a temp file so emoji,
    quotes and apostrophes survive AppleScript escaping. `handle` is always an explicit
    module constant (HANDLE for Contact, NICK_HANDLE for Nick) so the two pipes can't cross."""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
        tf.write(text)
        path = tf.name
    script = f'''
    set msg to (read POSIX file "{path}" as «class utf8»)
    tell application "Messages"
      set svc to 1st service whose service type = iMessage
      send msg to buddy "{handle}" of svc
    end tell'''
    subprocess.run(["osascript", "-e", script], timeout=30, check=True)
    os.unlink(path)

def notify_nick(text):
    """Best-effort iMessage to Nick's OWN thread (never the contact's). Never raises."""
    try:
        _imessage(NICK_HANDLE, "[imessage-responder] " + text)
    except Exception:
        pass

def send_imessage(text):
    """Send a reply to Contact. Target is locked to her handle."""
    _imessage(HANDLE, text)

def recent_context():
    """Last CONTEXT_LINES messages from the corpus, as 'Nick:'/'Contact:' transcript."""
    try:
        lines = open(CORPUS, encoding="utf-8").read().splitlines()[-CONTEXT_LINES:]
    except FileNotFoundError:
        return ""
    out = []
    for ln in lines:
        d = json.loads(ln)
        who = "Nick" if d["me"] else "Contact"
        out.append(f"{who}: {d['msg']}")
    return "\n".join(out)

def full_history():
    """The conversation as a 'Nick:'/'Contact:' transcript - the ENTIRE corpus when
    HISTORY_LINES is None, else the most recent HISTORY_LINES messages. This is what
    lets the bot 'know everything' about Nick and the relationship, not just the tail."""
    try:
        lines = open(CORPUS, encoding="utf-8").read().splitlines()
    except FileNotFoundError:
        return ""
    if HISTORY_LINES:
        lines = lines[-HISTORY_LINES:]
    out = []
    for ln in lines:
        d = json.loads(ln)
        who = "Nick" if d["me"] else "Contact"
        out.append(f"{who}: {d['msg']}")
    return "\n".join(out)

def load_dossier():
    """The curated 'who Nick is' portrait. Empty string if the file is missing."""
    try:
        return open(DOSSIER, encoding="utf-8").read().strip()
    except FileNotFoundError:
        return ""

def current_max_inbound():
    db = sqlite3.connect(DB)
    row = db.execute("""
        SELECT MAX(m.ROWID) FROM message m JOIN handle h ON m.handle_id=h.ROWID
        WHERE h.id=? AND m.is_from_me=0""", (HANDLE,)).fetchone()
    return row[0] or 0

def _load_state():
    """The whole reply_state dict. Holds two independent high-water marks:
      last_inbound_rowid - newest Contact message the bot has acted on (Contact path)
      last_nick_rowid    - newest Nick message the bot has acted on (summon path)
    Read-modify-write so writing one never clobbers the other."""
    try:
        return json.load(open(STATE))
    except Exception:
        return {}

def _save_state(d):
    json.dump(d, open(STATE, "w"))

def load_high_water():
    return _load_state().get("last_inbound_rowid")

def save_high_water(rowid):
    d = _load_state(); d["last_inbound_rowid"] = rowid; _save_state(d)

def load_nick_high():
    return _load_state().get("last_nick_rowid")

def save_nick_high(rowid):
    d = _load_state(); d["last_nick_rowid"] = rowid; _save_state(d)

ROBOT_MARK = ROBOT.strip()              # "🤖" — author tag on every bot message

def _body_by_guid(db, guid):
    """Decode a message's text by its GUID (text column, falling back to attributedBody
    where the bot's outgoing emoji messages live). None if absent."""
    if not guid:
        return None
    o = db.execute("SELECT text, attributedBody FROM message WHERE guid=?", (guid,)).fetchone()
    if not o:
        return None
    return o[0] if (o[0] and o[0].strip()) else decode_body(o[1])

def is_reply_to_robot(db, originator_guid):
    """True when Contact used iMessage's inline-reply gesture ON one of the bot's 🤖
    messages. A reply to one of Nick's *human* messages returns False — that's his."""
    body = _body_by_guid(db, originator_guid)
    return bool(body) and body.lstrip().startswith(ROBOT_MARK)

def contact_chat_id(db):
    row = db.execute("""
        SELECT c.ROWID FROM chat c
        JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
        JOIN handle h ON chj.handle_id = h.ROWID
        WHERE h.id=? LIMIT 1""", (HANDLE,)).fetchone()
    return row[0] if row else None

def robot_spoke_last(db, chat_id, before_rowid):
    """True when the most recent message in the contact's chat *before* this burst was a 🤖 bot
    message — i.e. Claude currently holds the conversational turn, so the contact's next message
    might be a continuation addressed to it. If the last word was Nick's or the contact's, the
    ball isn't in Claude's court and we don't even wake the model."""
    if chat_id is None:
        return False
    row = db.execute("""
        SELECT m.is_from_me, m.text, m.attributedBody
        FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE cmj.chat_id=? AND m.ROWID < ?
        ORDER BY m.ROWID DESC LIMIT 1""", (chat_id, before_rowid)).fetchone()
    if not row or not row[0]:           # nothing, or last message was inbound (Contact)
        return False
    body = row[1] if (row[1] and row[1].strip()) else decode_body(row[2])
    return bool(body) and body.lstrip().startswith(ROBOT_MARK)

def current_max_nick(db, chat_id):
    """Newest message ROWID Nick has sent in the contact's chat (is_from_me=1). Used to ARM the
    summon path so it never replays the existing backlog on first activation."""
    if chat_id is None:
        return 0
    row = db.execute("""
        SELECT MAX(m.ROWID) FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE cmj.chat_id=? AND m.is_from_me=1""", (chat_id,)).fetchone()
    return (row and row[0]) or 0

def handle_nick_summons(db):
    """Nick-as-summoner path (added 2026-06-16). When Nick addresses Claude in the shared
    thread ("Claude ..."), generate a 🤖 reply and send it INTO the thread for Contact to
    read - the public cameo he invited. Wholly separate from the Contact path: own high-water
    (last_nick_rowid), own arming, own trigger. Loop-safe because the bot's own 🤖 replies
    are is_from_me=1 too, so any message starting with 🤖 is skipped (it's never a summon).
    """
    chat_id = contact_chat_id(db)
    if chat_id is None:
        return

    nick_high = load_nick_high()
    if nick_high is None:                       # arm-only on first activation: never
        save_nick_high(current_max_nick(db, chat_id))   # answer the existing backlog
        notify_nick(f"🤖 Nick-summon path armed at ROWID {current_max_nick(db, chat_id)}. "
                    f"Say \"Claude ...\" in the contact's thread and I'll chime in for her to see.")
        return

    rows = db.execute("""
        SELECT m.ROWID, m.text, m.attributedBody
        FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE cmj.chat_id=? AND m.is_from_me=1 AND m.ROWID > ?
        ORDER BY m.ROWID ASC""", (chat_id, nick_high)).fetchall()
    if not rows:
        return
    new_high = max(r[0] for r in rows)

    summons = []
    for r in rows:
        body = r[1] if (r[1] and r[1].strip()) else decode_body(r[2])
        if not body:
            continue
        if body.lstrip().startswith(ROBOT_MARK):     # our own reply - never re-trigger
            continue
        if NICK_SUMMON_RE.match(body):
            summons.append(body)
    if not summons:                              # Nick was talking to Contact, not the bot
        save_nick_high(new_high)
        return

    nick_message = "\n".join(summons)
    trigger_note = (
        "NICK (not Contact) addressed you directly in the shared thread, summoning a 🤖 "
        "cameo. Your reply WILL BE SENT INTO THE THREAD AND SEEN BY THE CONTACT - he is inviting "
        "you to chime in for her to read. Reply warmly, to the thread (speak to Contact, or "
        "to them both, as fits what Nick asked). The ESCALATE rules still hold: never "
        "invent Nick's feelings or commit him to anything beyond what the history grounds, "
        "never expose the contact's own vulnerabilities. You MAY discuss intimacy and connection "
        "reflectively and warmly (both have asked you into this territory); ESCALATE only "
        "explicit/sexual content, voicing Nick's specific sexual desires on his behalf, or "
        "active conflict. If on reflection Nick's message wasn't actually for you, output "
        "the single word SILENT.")

    try:
        reply = generate_reply(nick_message, trigger_note, speaker="Nick")
    except Exception as e:
        notify_nick(f"🤖 Nick-summon ERROR generating reply to: {nick_message!r}\n{e}\n(Not sending.)")
        return

    if (not reply) or ("ESCALATE" in reply.upper()):
        notify_nick(f"🤖 Nick-summon ESCALATED (nothing sent to Contact).\nYou asked: "
                    f"{nick_message}\n\nClaude's note: {reply or '(empty reply)'}\n\nYour move.")
        save_nick_high(new_high)
        return

    if any(line.strip().upper() == "SILENT" for line in reply.splitlines()):
        save_nick_high(new_high)                 # wasn't for the bot after all - stay quiet
        return

    try:
        send_imessage(ROBOT + reply)
    except Exception as e:
        notify_nick(f"🤖 Nick-summon FAILED to send: {e}\nIntended reply: {reply}")
    finally:
        save_nick_high(new_high)

def _clean(text):
    """Strip any '★ Insight ... ─────' block that can leak from the Explanatory
    output style. Primary defence is --settings outputStyle=default; this is backup."""
    if not text:
        return text
    text = re.sub(r'★\s*Insight.*?─{5,}[^\n]*\n?', '', text, flags=re.DOTALL)
    text = text.strip()
    # The script prepends exactly one 🤖 (ROBOT). The model is told not to add its own,
    # but Opus sometimes does anyway -> "🤖 🤖". Strip any leading robot(s) the model
    # emitted so the prepend stays authoritative and we never double up.
    text = re.sub(r'^(?:🤖\s*)+', '', text)
    # Strip a leaked REASONING PREAMBLE. The model occasionally prefixes meta like
    # "Now for the reply:" / "Here's my reply:" and/or a "---" markdown fence before the
    # actual message body (known intermittent leak despite "write ONLY the body"). Peel a
    # few such layers off the front so they never ship to Contact. (Anchored to the start and
    # to short meta lines only, so real content is never touched.)
    for _ in range(3):
        before = text
        text = re.sub(r'^\s*(?:now for (?:the|my) reply|here(?:\'s| is) (?:my|the) reply|'
                      r'(?:my|the) reply|reply)\s*:?-*\s*', '', text, flags=re.IGNORECASE)
        # The system prompt tells the model to "decide ADDRESSING first"; it sometimes
        # writes that decision as a leading "Addressing: TO ME - ..." line and ships it
        # (leaked to Contact in rowids 66271/66273). Peel a whole leading Addressing: line.
        text = re.sub(r'^\s*Addressing\s*:[^\n]*\n+', '', text, flags=re.IGNORECASE)
        text = re.sub(r'^\s*-{3,}\s*', '', text)          # leading --- fence
        text = text.lstrip()
        if text == before:
            break
    # iMessage renders no markdown, so **bold**/__italic__ markers show as literal noise.
    # Drop the emphasis markers, keep the words.
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    # Single-asterisk *emphasis* also renders as literal asterisks in iMessage. Strip the
    # markers but keep the words (require non-space just inside so a lone "*" is untouched).
    text = re.sub(r'\*(\S[^*\n]*?\S|\S)\*', r'\1', text)
    return text.strip()

def generate_reply(message, trigger_note="", speaker="Contact"):
    """Headless Claude Code under Nick's Max plan. Returns the reply text, a string
    starting with 'ESCALATE:' (declined per the system prompt), or 'SILENT' (the message
    wasn't really for the bot). `trigger_note` tells the model WHY it was woken so it can
    calibrate how strongly it's being addressed. `speaker` is who sent the triggering
    message - "Contact" (normal) or "Nick" (he summoned the cameo; his reply still goes into
    the shared thread for Contact to read)."""
    system  = open(SYSTEM, encoding="utf-8").read()
    dossier = load_dossier()
    prompt = (
        f"{system}\n\n"
        f"--- WHO NICK IS (Claude's portrait of him, shared with Nick's consent) ---\n{dossier}\n\n"
        f"--- your full conversation history with Contact (oldest to newest) ---\n{full_history()}\n\n"
        f"--- why you were triggered ---\n{trigger_note}\n\n"
        f"--- {speaker} just sent ---\n{message}\n\n"
        f"Decide ADDRESSING first, then write the single 🤖 reply (or output an "
        f"ESCALATE: line, or the single word SILENT)."
    )
    res = subprocess.run(
        # --model sonnet: warm 1-3 sentence texts don't need Opus-with-thinking (that was
        # the ~3 min latency). Sonnet replies in ~10-20s and keeps enough nuance for the
        # sensitive "reflect his feelings" replies. Bump to opus for depth, haiku for speed.
        ["claude", "-p", prompt, "--model", "sonnet", "--output-format", "text",
         "--settings", '{"outputStyle":"default"}',   # don't inherit Explanatory style
         "--allowedTools", "WebSearch", "WebFetch"],
        capture_output=True, text=True, timeout=CLAUDE_TIMEOUT
    )
    return _clean(res.stdout.strip())

def main():
    # 1. keep the corpus current
    subprocess.run([sys.executable, SYNC], check=False, capture_output=True)

    # 2. ARM-ONLY on first run: never answer the existing backlog
    high = load_high_water()
    if high is None:
        mx = current_max_inbound()
        save_high_water(mx)
        notify_nick(f"🤖 imessage-responder armed at ROWID {mx}. It will answer only NEW messages from here, never the backlog.")
        return

    # 3. new inbound from Contact since last time (with reply-link metadata)
    db = sqlite3.connect(DB)

    # 3a. Nick-as-summoner path. Runs FIRST because the Contact block below has early
    # returns ("no new Contact messages -> return") that would otherwise skip it. Fully
    # independent state, so the two paths never interfere.
    handle_nick_summons(db)

    rows = db.execute("""
        SELECT m.ROWID, m.text, m.attributedBody, m.thread_originator_guid
        FROM message m JOIN handle h ON m.handle_id=h.ROWID
        WHERE h.id=? AND m.is_from_me=0 AND m.ROWID > ?
        ORDER BY m.ROWID ASC""", (HANDLE, high)).fetchall()
    if not rows:
        return

    new_high  = max(r[0] for r in rows)
    first_new = min(r[0] for r in rows)

    # Decode each new message, and note if ANY is a direct inline-reply to a 🤖 message.
    texts, reply_to_robot = [], False
    for r in rows:
        body = r[1] if (r[1] and r[1].strip()) else decode_body(r[2])
        if not body:
            continue
        texts.append(body)
        if is_reply_to_robot(db, r[3]):
            reply_to_robot = True
    if not texts:                       # only attachments/reactions arrived
        save_high_water(new_high)
        return

    # Decide WHETHER to engage at all, and tell the model why. Three escalating signals:
    #   1. direct inline-reply to a 🤖 message  -> unambiguous, bypass the name gate
    #   2. names the bot ("claude" / 🤖)        -> the original summon
    #   3. the bot spoke last                   -> a bare message that MIGHT continue the
    #                                              exchange; let the model judge, default SILENT
    # If none hold, these are Contact-to-Nick messages: stay silent, no model call. The bot
    # is a guest, never the host.
    has_trigger = any(trig in t.lower() for t in texts for trig in TRIGGERS)
    spoke_last  = robot_spoke_last(db, contact_chat_id(db), first_new)

    if reply_to_robot:
        trigger_note = ("Contact used iMessage's REPLY gesture directly on one of YOUR (🤖) "
                        "messages. Strong signal she is talking TO you — reply unless the "
                        "content is one you must ESCALATE.")
    elif has_trigger:
        trigger_note = ('Contact named you ("claude" or 🤖). She is summoning you.')
    elif spoke_last:
        trigger_note = ("You (🤖) sent the most recent message, so the contact's new message MIGHT "
                        "continue what you just said — OR she may be turning back to talk to "
                        "Nick. Judge from her words: if it plausibly answers/continues YOUR "
                        "last message, reply; if it reads like she's talking to Nick "
                        "(logistics, affection, a reply to something Nick said, anything not "
                        "about your last message), output the single word SILENT.")
    else:
        save_high_water(new_high)       # nothing addressed to the bot — stay quiet
        return

    her_message = "\n".join(texts)      # respond once, accounting for any burst

    # 4. generate, then either escalate, stay silent, or send
    try:
        reply = generate_reply(her_message, trigger_note)
    except Exception as e:
        notify_nick(f"🤖 imessage-responder ERROR generating reply to: {her_message!r}\n{e}\n(Not sending. Over to you.)")
        return

    # Fail safe: if the model mentions ESCALATE ANYWHERE (even after a reasoning
    # preamble), or returns nothing, do NOT send to Contact — route the whole thing
    # to Nick. Better to withhold a borderline reply than leak internal reasoning.
    if (not reply) or ("ESCALATE" in reply.upper()):
        notify_nick(f"ESCALATED (nothing sent to Contact).\nShe said: {her_message}\n\nClaude's note: {reply or '(empty reply)'}\n\nYour move.")
        save_high_water(new_high)
        return

    # SILENT: the model judged this message was for Nick, not the bot (only reachable via
    # the "spoke last" path). Stay completely quiet — no send, no ping to Nick — and just
    # advance the high-water so the conversation flows back to the two of them untouched.
    if any(line.strip().upper() == "SILENT" for line in reply.splitlines()):
        save_high_water(new_high)
        return

    try:
        # Quiet mode (2026-06-01, Nick's call): no per-reply mirror to Nick's own
        # thread — successful replies to Contact are silent. Nick still gets pinged on
        # ESCALATE, generation errors, and send failures (the cases that need him).
        send_imessage(ROBOT + reply)
    except Exception as e:
        notify_nick(f"🤖 imessage-responder FAILED to send: {e}\nIntended reply: {reply}")
    finally:
        save_high_water(new_high)

if __name__ == "__main__":
    main()
