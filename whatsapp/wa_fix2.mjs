// Robust version: fresh socket per operation, retries on Connection Closed.
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from "baileys";
import P from "pino";
import fs from "node:fs/promises";

const JID = "120363410027853082@g.us";
const AUTH_DIR = `${process.env.HOME}/.claude/cli-tools/.tokens/whatsapp`;

const OPS = [
  { kind: "delete", stanzaId: "3EB0D7C0769AA1066FF4EF", note: "garbled PNG (00:17)" },
  { kind: "image", path: "/tmp/notes_p1.png", caption: "Session notes — re-sent properly as images, the earlier attachments hit a CLI bug. Page 1/3." },
  { kind: "image", path: "/tmp/notes_p2.png", caption: "Page 2/3" },
  { kind: "image", path: "/tmp/notes_p3.png", caption: "Page 3/3" },
];

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    browser: Browsers.macOS("Desktop"),
    printQRInTerminal: false,
  });
  sock.ev.on("creds.update", saveCreds);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 30000);
    sock.ev.on("connection.update", (u) => {
      if (u.connection === "open") { clearTimeout(timer); resolve(); }
    });
  });
  return sock;
}

async function runOp(op) {
  const sock = await connect();
  try {
    if (op.kind === "delete") {
      const r = await sock.sendMessage(JID, {
        delete: { remoteJid: JID, fromMe: true, id: op.stanzaId },
      });
      return `revoke id=${r.key.id}`;
    } else if (op.kind === "image") {
      const buf = await fs.readFile(op.path);
      const r = await sock.sendMessage(JID, {
        image: buf,
        caption: op.caption,
        mimetype: "image/png",
      });
      return `image id=${r.key.id} bytes=${buf.length}`;
    }
  } finally {
    // Let the message persist server-side before tearing down the socket
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function withRetry(op, maxTries = 4) {
  for (let i = 1; i <= maxTries; i++) {
    try {
      const r = await runOp(op);
      console.log(`[ok] ${op.kind} ${op.note || op.path} — ${r}`);
      return true;
    } catch (e) {
      console.error(`[try ${i}/${maxTries}] ${op.kind} ${op.note || op.path}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  console.error(`[abandon] ${op.kind} ${op.note || op.path}`);
  return false;
}

async function main() {
  for (const op of OPS) {
    await withRetry(op);
    await new Promise((r) => setTimeout(r, 1500));
  }
  process.exit(0);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
