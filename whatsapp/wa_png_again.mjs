import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from "baileys";
import P from "pino";
const JID = "120363410027853082@g.us";
const AUTH_DIR = `${process.env.HOME}/.claude/cli-tools/.tokens/whatsapp`;
const TARGETS = [
  { id: "3EB0D7C0769AA1066FF4EF", note: "garbled PNG (00:17)" },
];
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: P({ level: "silent" }), browser: Browsers.macOS("Desktop"), printQRInTerminal: false });
  sock.ev.on("creds.update", saveCreds);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 30000);
    sock.ev.on("connection.update", (u) => { if (u.connection === "open") { clearTimeout(t); resolve(); } });
  });
  return sock;
}
for (const t of TARGETS) {
  for (let i = 1; i <= 5; i++) {
    try {
      const sock = await connect();
      const r = await sock.sendMessage(JID, { delete: { remoteJid: JID, fromMe: true, id: t.id } });
      console.log(`[ok] ${t.note} — revoke id=${r.key.id}`);
      await new Promise((r) => setTimeout(r, 3000));
      break;
    } catch (e) {
      console.error(`[try ${i}/5] ${t.note}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2500 * i));
    }
  }
}
process.exit(0);
