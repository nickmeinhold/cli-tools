// One-off: delete two garbled messages and send 3 PNG pages as real image messages.
// Uses the same Baileys auth state as the whatsapp CLI.
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from "baileys";
import P from "pino";

const JID = "120363410027853082@g.us"; // Echo group
const AUTH_DIR = `${process.env.HOME}/.claude/cli-tools/.tokens/whatsapp`;

const GARBLED = [
  { stanzaId: "3EB0D746DBBFA190871811", note: "garbled PDF (2026-06-01 11:41)" },
  { stanzaId: "3EB0D7C0769AA1066FF4EF", note: "garbled PNG (2026-06-02 00:17)" },
];

const PNG_PAGES = [
  { path: "/tmp/notes_p1.png", caption: "Session notes (re-sent as proper images — the previous attachments were a CLI bug, sorry). Page 1/3." },
  { path: "/tmp/notes_p2.png", caption: "Page 2/3" },
  { path: "/tmp/notes_p3.png", caption: "Page 3/3" },
];

async function main() {
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
    sock.ev.on("connection.update", (u) => {
      if (u.connection === "open") resolve();
      if (u.connection === "close") reject(new Error("conn closed before open"));
    });
    setTimeout(() => reject(new Error("connect timeout")), 30000);
  });

  console.log("[connected]");

  // === Step 1: delete garbled messages ===
  for (const g of GARBLED) {
    try {
      const result = await sock.sendMessage(JID, {
        delete: { remoteJid: JID, fromMe: true, id: g.stanzaId },
      });
      console.log(`[delete ok] ${g.note} — revoke message_id=${result.key.id}`);
    } catch (e) {
      console.error(`[delete fail] ${g.note}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200)); // pace
  }

  // === Step 2: send proper image messages ===
  const fs = await import("node:fs/promises");
  for (const p of PNG_PAGES) {
    try {
      const buf = await fs.readFile(p.path);
      const result = await sock.sendMessage(JID, {
        image: buf,
        caption: p.caption,
        mimetype: "image/png",
      });
      console.log(`[image ok] ${p.path} — message_id=${result.key.id}`);
    } catch (e) {
      console.error(`[image fail] ${p.path}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  await new Promise((r) => setTimeout(r, 4000)); // let server ACK
  // IMPORTANT: do NOT call sock.logout() — that unlinks the device.
  // Just terminate; the session stays valid for next CLI invocation.
  process.exit(0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
