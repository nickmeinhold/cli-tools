// Delete the wrong Adi reply + Nick's correction note.
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from "baileys";
import P from "pino";

const JID = "120363410027853082@g.us";
const AUTH_DIR = `${process.env.HOME}/.claude/cli-tools/.tokens/whatsapp`;

const TARGETS = [
  { id: "3EB0A6C1835C5AEDB3C82D", note: "wrong Adi reply (00:17)" },
  { id: "3BBC019038B3D5A9F127",   note: "Sorry-that-was-wrong correction (07:57)" },
];

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger: P({ level: "silent" }),
    browser: Browsers.macOS("Desktop"), printQRInTerminal: false,
  });
  sock.ev.on("creds.update", saveCreds);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 30000);
    sock.ev.on("connection.update", (u) => { if (u.connection === "open") { clearTimeout(t); resolve(); } });
  });
  return sock;
}

async function delOne(t) {
  for (let i = 1; i <= 5; i++) {
    try {
      const sock = await connect();
      const r = await sock.sendMessage(JID, {
        delete: { remoteJid: JID, fromMe: true, id: t.id },
      });
      console.log(`[ok] ${t.note} — revoke id=${r.key.id}`);
      await new Promise((r) => setTimeout(r, 3000));
      return;
    } catch (e) {
      console.error(`[try ${i}/5] ${t.note}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2500 * i));
    }
  }
  console.error(`[abandoned] ${t.note}`);
}

for (const t of TARGETS) await delOne(t);
process.exit(0);
