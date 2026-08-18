require('dotenv').config();
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode');
const readline = require('readline');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'session');
const DATA_DIR = path.join(__dirname, 'data');
const MODE_FILE = path.join(DATA_DIR, 'mode.json');
const PREFIX = '.';
const WEB_DISABLED = /^(0|false|off|no)$/i.test(String(process.env.WEB || 'true'));
const MAX_RECONNECT = Number(process.env.MAX_RECONNECT || 3);
const REACT_EMOJI = process.env.REACT_EMOJI || '⚡';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let pairingCode = null;
let lastQrDataUrl = null;
let connectionStatus = 'offline';
let connectedNumber = null;
let pairingInProgress = false;
let startPromise = null;
let terminalPromptStarted = false;
let reconnectTries = 0;
let gaveUp = false;
let greetSent = false;

function loadMode() {
  try {
    const j = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    if (j.mode === 'private' || j.mode === 'public') return j.mode;
  } catch {}
  return 'public';
}

function saveMode(mode) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode }, null, 2));
}

let botMode = loadMode();

function envPhone() {
  return String(process.env.PHONE_NUMBER || process.env.NUMBER || '').replace(/\D/g, '');
}

function ownerJids() {
  const ids = new Set();
  const phone = envPhone();
  if (phone) {
    ids.add(phone);
    ids.add(phone + '@s.whatsapp.net');
  }
  if (sock?.user?.id) {
    const raw = sock.user.id;
    ids.add(raw);
    ids.add(raw.split(':')[0]);
    ids.add(raw.split(':')[0] + '@s.whatsapp.net');
  }
  if (sock?.user?.lid) {
    ids.add(String(sock.user.lid));
    ids.add(String(sock.user.lid).split(':')[0]);
  }
  if (connectedNumber) {
    ids.add(connectedNumber);
    ids.add(connectedNumber + '@s.whatsapp.net');
  }
  return ids;
}

function senderId(msg) {
  if (msg.key.participant) return msg.key.participant;
  return msg.key.remoteJid;
}

function isOwner(msg) {
  const sender = String(senderId(msg) || '');
  const digits = sender.replace(/\D/g, '');
  const owners = ownerJids();
  if (owners.has(sender) || owners.has(sender.split(':')[0])) return true;
  const phone = envPhone();
  if (phone && (digits === phone || digits.endsWith(phone) || phone.endsWith(digits))) return true;
  return false;
}

function htmlPage() {
  const statusColor =
    connectionStatus === 'connected'
      ? '#22c55e'
      : connectionStatus === 'connecting'
        ? '#eab308'
        : '#ef4444';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NOVA ABSOLUTE</title>
</head>
<body style="font-family:sans-serif;background:#0b1220;color:#e8eef7;padding:24px">
  <h1>NOVA ABSOLUTE</h1>
  <p>Status: ${escapeHtml(connectionStatus)} ${connectedNumber ? '· ' + escapeHtml(connectedNumber) : ''}</p>
  <p>Mode: ${escapeHtml(botMode)}</p>
  <p>Web pair is optional. Type <b>pair</b> in the panel console.</p>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

app.get('/', (_req, res) => res.type('html').send(htmlPage()));
app.get('/status', (_req, res) => {
  res.json({ status: connectionStatus, number: connectedNumber, mode: botMode, pairingCode });
});

app.post('/pair', async (req, res) => {
  try {
    const phone = String(req.body.phone || envPhone() || '').replace(/\D/g, '');
    const formatted = await requestPairing(phone, { force: true });
    res.json({ code: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not request pairing code' });
  }
});

async function ensureSocket() {
  if (sock) return sock;
  if (startPromise) return startPromise;
  startPromise = startBot().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

function isRestartRequired(statusCode, err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    statusCode === DisconnectReason.restartRequired ||
    statusCode === 515 ||
    statusCode === 503 ||
    msg.includes('restart required') ||
    msg.includes('statuscode=503') ||
    msg.includes('status code 503') ||
    msg.includes('service unavailable')
  );
}

async function startBot() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1027934701] }));

  connectionStatus = 'connecting';

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        lastQrDataUrl = await qrcode.toDataURL(qr);
      } catch {}
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      pairingCode = null;
      lastQrDataUrl = null;
      reconnectTries = 0;
      gaveUp = false;
      connectedNumber = sock.user?.id?.split(':')[0] || envPhone() || null;
      console.log('Connected as', connectedNumber, '| mode:', botMode);
      if (!greetSent) {
        greetSent = true;
        setTimeout(() => sendConnectedDm().catch((e) => console.error('greet failed', e.message)), 3000);
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const restartNeeded = isRestartRequired(statusCode, lastDisconnect?.error);
      const reason = lastDisconnect?.error?.message || statusCode || 'unknown';
      console.log('Connection closed:', reason, loggedOut ? '(logged out)' : restartNeeded ? '(503 / restart required)' : '');
      sock = null;
      connectionStatus = 'offline';
      pairingInProgress = false;
      startPromise = null;

      if (loggedOut) {
        pairingCode = null;
        reconnectTries = 0;
        greetSent = false;
        console.log('Logged out. Session cleared. Type "pair" in the console when you want a new code.');
        try {
          if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        } catch {}
        setTimeout(() => ensureSocket().catch(console.error), 1500);
        return;
      }

      if (restartNeeded) {
        console.log('WhatsApp asked for a restart (503 / 515). Reconnecting now — not counting as a failed try.');
        setTimeout(() => ensureSocket().catch(console.error), 1500);
        return;
      }

      reconnectTries += 1;
      if (reconnectTries > MAX_RECONNECT) {
        gaveUp = true;
        console.error(`Gave up after ${MAX_RECONNECT} reconnect tries. Press Restart on the panel.`);
        return;
      }
      const wait = 2000 * reconnectTries;
      console.log(`Reconnect ${reconnectTries}/${MAX_RECONNECT} in ${wait / 1000}s…`);
      setTimeout(() => ensureSocket().catch(console.error), wait);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg?.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

      const body = String(text).trim();
      if (!body.startsWith(PREFIX)) return;

      const [rawCmd, ...rest] = body.slice(PREFIX.length).trim().split(/\s+/);
      const cmd = (rawCmd || '').toLowerCase();
      if (!cmd) return;

      if (botMode === 'private' && !isOwner(msg)) return;

      await reactTo(msg);

      if (cmd === 'ping') {
        const start = Date.now();
        await reply(msg, 'pong');
        console.log(`.ping ${Date.now() - start}ms`);
        return;
      }

      if (cmd === 'mode') {
        if (!isOwner(msg)) {
          await reply(msg, 'Owner only.');
          return;
        }
        const arg = (rest[0] || '').toLowerCase();
        if (arg === 'private' || arg === 'public') {
          botMode = arg;
          saveMode(botMode);
          await reply(msg, `Mode set to *${botMode}*\nprivate = only you\npublic = everyone`);
          return;
        }
        await reply(msg, `Current mode: *${botMode}*\nUse \`.mode private\` or \`.mode public\``);
        return;
      }
    } catch (err) {
      console.error('command error:', err.message);
    }
  });

  return sock;
}

async function reactTo(msg) {
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: REACT_EMOJI, key: msg.key },
    });
  } catch (err) {
    console.warn('react failed:', err.message);
  }
}

async function reply(msg, text) {
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function sendConnectedDm() {
  const phone = envPhone();
  const jid = phone
    ? phone + '@s.whatsapp.net'
    : sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
  const text =
    'NOVA ABSOLUTE bot is connected ✅\n\n' +
    `Number: ${phone || connectedNumber || 'unknown'}\n` +
    `Mode: ${botMode}\n` +
    'Commands: .ping  ·  .mode public|private\n\n' +
    'You get na.';
  await sock.sendMessage(jid, { text });
  console.log('Sent connect DM to', jid);
}

async function requestPairing(phoneRaw, { force = false } = {}) {
  const phone = String(phoneRaw || envPhone() || '').replace(/\D/g, '');
  if (phone.length < 8) {
    throw new Error('Enter a valid number with country code, e.g. 2348147051558');
  }
  await ensureSocket();
  if (!sock) throw new Error('Socket not ready, try again');
  if (connectionStatus === 'connected') {
    throw new Error('Already connected.');
  }

  pairingInProgress = true;
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const code = await sock.requestPairingCode(phone);
    pairingCode = String(code).match(/.{1,4}/g)?.join('-') || String(code);
    printPairingBanner(phone, pairingCode);
    return pairingCode;
  } finally {
    pairingInProgress = false;
  }
}

function printPairingBanner(phone, code) {
  const line = '='.repeat(42);
  console.log('\n' + line);
  console.log('  PAIRING CODE FOR', phone);
  console.log('  >>>   ' + code + '   <<<');
  console.log(line);
  console.log('WhatsApp → Linked devices → Link a device');
  console.log('→ Link with phone number → enter the code');
  console.log('Need another code? Type: pair\n');
}

function listenForPairCommand() {
  if (terminalPromptStarted) return;
  terminalPromptStarted = true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Type "pair" in this console when you want a pairing code. No auto codes.');
  rl.on('line', async (line) => {
    const t = String(line || '').trim().toLowerCase();
    if (t === 'pair' || t === 'code' || t === 'pairing') {
      try {
        await requestPairing(envPhone(), { force: true });
      } catch (err) {
        console.error('Pairing failed:', err.message);
      }
    }
  });
}

function startWebOrSkip() {
  listenForPairCommand();
  if (WEB_DISABLED) {
    console.log('Web pair disabled (WEB=false). Type pair in the console.');
    ensureSocket().catch((err) => console.error('start error', err));
    return;
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Optional web page: http://0.0.0.0:${PORT}`);
    ensureSocket().catch((err) => console.error('start error', err));
  });

  server.on('error', (err) => {
    console.warn('Web server failed (' + err.message + '). Console pair still works.');
    ensureSocket().catch((e) => console.error('start error', e));
  });
}

startWebOrSkip();
