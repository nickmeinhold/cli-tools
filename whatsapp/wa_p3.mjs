// Just page 3.
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from "baileys";
import P from "pino";
import fs from "node:fs/promises";

const JID = "120363410027853082@g.us";
const AUTH_DIR = `${process.env.HOME}/.claude/cli-tools/.tokens/whatsapp`;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state,
    logger: P({ level: "silent" }),
    browser: Browsers.macOS("Desktop"),
    printQRInTerminal: false,
  });
  sock.ev.on("creds.update", saveCreds);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 30000);
    sock.ev.on("connection.update", (u) => { if (u.connection === "open") { clearTimeout(t); resolve(); } });
  });
  return sock;
}

async function attempt() {
  const sock = await connect();
  const buf = await fs.readFile("/tmp/notes_p3.jpg");
  const r = await sock.sendMessage(JID, {
    image: buf,
    caption: "Page 3/3",
    mimetype: "image/jpeg",
  });
  console.log(`[ok] id=${r.key.id} bytes=${buf.length}`);
  await new Promise((r) => setTimeout(r, 3500));
}

for (let i = 1; i <= 5; i++) {
  try {
    await attempt();
    process.exit(0);
  } catch (e) {
    console.error(`[try ${i}/5] ${e.message}`);
    await new Promise((r) => setTimeout(r, 3000 * i));
  }
}
console.error("[failed all retries]");
process.exit(1);
