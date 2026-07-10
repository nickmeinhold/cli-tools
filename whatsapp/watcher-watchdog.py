#!/usr/bin/env python3
"""Watch-the-watcher: liveness probe for com.nick.whatsapp-watcher.

launchd's KeepAlive only restarts a DEAD process. It cannot see an
alive-but-wedged watcher — one whose Baileys socket never reaches 'open' and
loops reconnecting forever (the process has a PID, so launchd thinks it's
healthy). That exact failure caused a 4.5-day silent outage on 2026-06-27.

This probe (run every 5 min by com.nick.whatsapp-watcher-watchdog) distinguishes
CONNECTED from merely-alive using the watcher's heartbeat, which now carries a
`connected` flag (whatsapp.mjs). Health = the newest event that PROVES a live
socket within WEDGE_THRESHOLD. If the watcher is alive but has shown no live
socket for that long, it's wedged → force one restart, with guards so we never
reconnect-storm (which itself gets WhatsApp to 408-throttle the device):

  - COOLDOWN between restarts (no rapid-fire).
  - After MAX_RESTARTS_PER_HOUR failed restarts, QUARANTINE and ALERT Nick
    instead of restarting again — because the one thing a restart can't fix is
    an expired/unregistered session (creds registered:false), which needs a QR
    re-pair (Nick's phone). Restart-looping on that just burns toward a ban.

Exit code is always 0 (launchd StartInterval jobs shouldn't be marked failed);
actions are logged to stdout and to the alert channels.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

LABEL = "com.nick.whatsapp-watcher"
EVENTS = Path.home() / ".whatsapp.messages" / "wa-events.ndjson"
STATE = Path.home() / ".whatsapp.messages" / "watcher-watchdog-state.json"

WEDGE_THRESHOLD_MS = 15 * 60 * 1000   # no live socket this long (while alive) = wedged
COOLDOWN_MS = 15 * 60 * 1000          # min gap between forced restarts
MAX_RESTARTS_PER_HOUR = 3             # then quarantine + alert instead of restarting
TAIL_LINES = 120                      # how much of the events log to scan

# Events that can ONLY be written when the socket is actually open. A wedged
# watcher still emits `heartbeat` (connected:false), `error`, `watchdog_kick` —
# those must NOT count as liveness.
LIVE_EVENTS = {"connected", "message", "outbox_sent", "job_done", "media"}

now_ms = lambda: int(time.time() * 1000)


def log(msg: str) -> None:
    print(f"[wa-watchdog {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {msg}", flush=True)


def watcher_pid() -> int | None:
    """Return the watcher's PID from launchctl, or None if not running."""
    try:
        out = subprocess.run(["launchctl", "list", LABEL], capture_output=True, text=True, timeout=10)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    for line in out.stdout.splitlines():
        line = line.strip()
        if line.startswith('"PID"'):
            # '"PID" = 12345;'
            digits = "".join(c for c in line.split("=", 1)[1] if c.isdigit())
            return int(digits) if digits else None
    return None


def last_live_ms() -> int | None:
    """Newest timestamp among events that prove a live socket, or None."""
    if not EVENTS.exists():
        return None
    try:
        # Read the tail cheaply.
        with EVENTS.open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            block = min(size, 64 * 1024)
            f.seek(size - block)
            lines = f.read().decode("utf-8", "replace").splitlines()[-TAIL_LINES:]
    except Exception:
        return None
    newest: int | None = None
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        ev = d.get("event")
        live = ev in LIVE_EVENTS or (ev == "heartbeat" and d.get("connected") is True)
        if live:
            ts = d.get("t")
            if isinstance(ts, (int, float)) and (newest is None or ts > newest):
                newest = int(ts)
    return newest


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {"restarts": [], "quarantined": False, "quarantine_reason": None}


def save_state(state: dict) -> None:
    try:
        STATE.write_text(json.dumps(state))
    except Exception as e:
        log(f"could not persist state: {e}")


def restart_watcher() -> None:
    uid = os.getuid()
    subprocess.run(
        ["launchctl", "kickstart", "-k", f"gui/{uid}/{LABEL}"],
        capture_output=True, text=True, timeout=20,
    )


def alert(msg: str) -> None:
    """Best-effort: local macOS notification + Telegram to Nick's phone."""
    log(f"ALERT: {msg}")
    try:
        subprocess.run(
            ["osascript", "-e", f'display notification "{msg}" with title "WhatsApp watcher"'],
            capture_output=True, timeout=10,
        )
    except Exception:
        pass
    try:
        subprocess.run(
            ["node", str(Path.home() / "git/tools/cli-tools/telegram/telegram.mjs"),
             "send", "--to", "me", "--text", f"⚠️ WhatsApp watcher: {msg}"],
            capture_output=True, timeout=30,
        )
    except Exception:
        pass


def main() -> int:
    pid = watcher_pid()
    live = last_live_ms()
    now = now_ms()
    state = load_state()
    # Prune restart records older than an hour.
    state["restarts"] = [t for t in state.get("restarts", []) if now - t < 60 * 60 * 1000]

    healthy = live is not None and (now - live) <= WEDGE_THRESHOLD_MS
    if healthy:
        if state.get("quarantined") or state.get("restarts"):
            log(f"healthy again (last live {(now - live)//1000}s ago); clearing quarantine/counter")
        save_state({"restarts": [], "quarantined": False, "quarantine_reason": None})
        return 0

    # Not healthy. If the process is genuinely dead, KeepAlive=true should handle
    # it; we still nudge as a backstop, but the interesting case is alive+wedged.
    stale_s = "never" if live is None else f"{(now - live)//1000}s"
    log(f"UNHEALTHY: pid={pid} last_live={stale_s} (threshold {WEDGE_THRESHOLD_MS//1000}s)")

    if state.get("quarantined"):
        log("quarantined — not restarting; waiting for human (likely QR re-pair)")
        return 0

    if len(state["restarts"]) >= MAX_RESTARTS_PER_HOUR:
        state["quarantined"] = True
        state["quarantine_reason"] = "wedged after repeated restarts — likely expired session (QR re-pair needed)"
        save_state(state)
        alert("wedged after 3 restarts in an hour — likely needs a QR re-pair (whatsapp auth). Not restarting further.")
        return 0

    last_restart = max(state["restarts"], default=0)
    if now - last_restart < COOLDOWN_MS:
        log(f"in cooldown ({(now - last_restart)//1000}s < {COOLDOWN_MS//1000}s); skipping restart")
        return 0

    log("forcing restart (kickstart -k)")
    restart_watcher()
    state["restarts"].append(now)
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
