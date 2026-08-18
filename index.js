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
const PREFIX = '.';
const WEB_DISABLED = /^(0|false|off|no)$/i.test(String(process.env.WEB || 'true'));

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
  <title>WhatsApp Bot — Pair</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #1e3a2f 0%, transparent 50%),
                  radial-gradient(900px 500px at 110% 10%, #16324a 0%, transparent 45%),
                  #0b1220;
      color: #e8eef7;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%; max-width: 440px;
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      padding: 28px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.45);
    }
    h1 { margin: 0 0 6px; font-size: 1.4rem; }
    p.sub { margin: 0 0 20px; color: #94a3b8; font-size: 0.92rem; }
    .status {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 20px; font-size: 0.9rem; color: #cbd5e1;
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: ${statusColor}; box-shadow: 0 0 10px ${statusColor}; }
    label { display: block; font-size: 0.8rem; color: #94a3b8; margin-bottom: 6px; }
    input {
      width: 100%; padding: 12px 14px; border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      background: #0f172a; color: #fff; font-size: 1rem; outline: none;
    }
    input:focus { border-color: #34d399; }
    button {
      width: 100%; margin-top: 12px; padding: 12px 14px;
      border: 0; border-radius: 12px; cursor: pointer;
      background: #10b981; color: #042f24; font-weight: 700; font-size: 1rem;
    }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .code {
      margin-top: 18px; text-align: center;
      font-size: 2rem; letter-spacing: 0.28em; font-weight: 800;
      color: #34d399;
    }
    .hint { margin-top: 10px; color: #94a3b8; font-size: 0.82rem; line-height: 1.45; }
    .err { color: #fca5a5; margin-top: 10px; font-size: 0.85rem; }
    img { display: block; margin: 16px auto 0; width: 200px; height: 200px; background: #fff; border-radius: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WhatsApp Bot</h1>
    <p class="sub">Web pair · only command is <b>.ping</b></p>
    <div class="status"><span class="dot"></span><span id="st">${escapeHtml(connectionStatus)}${connectedNumber ? ' · ' + escapeHtml(connectedNumber) : ''}</span></div>
    ${
      connectionStatus === 'connected'
        ? `<p class="hint">Bot is online. Send <b>.ping</b> in any chat. Session is saved in the <code>session</code> folder — keep that folder if you redeploy.</p>
           <form method="POST" action="/logout"><button type="submit">Logout / re-pair</button></form>`
        : `<form id="pairForm">
             <label for="phone">Phone number (country code, no +)</label>
             <input id="phone" name="phone" placeholder="2348012345678" inputmode="numeric" required />
             <button type="submit" id="btn">Get pairing code</button>
           </form>
           <div id="out"></div>
           ${lastQrDataUrl ? `<img alt="QR" src="${lastQrDataUrl}" />` : ''}`
    }
  </div>
  <script>
    const form = document.getElementById('pairForm');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('btn');
        const out = document.getElementById('out');
        btn.disabled = true;
        btn.textContent = 'Requesting…';
        out.innerHTML = '';
        try {
          const phone = document.getElementById('phone').value.replace(/\\D/g, '');
          const res = await fetch('/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed');
          out.innerHTML = '<div class="code">' + data.code + '</div>'
            + '<p class="hint">WhatsApp → Linked devices → Link a device → Link with phone number. Enter this code. Page refreshes when connected.</p>';
        } catch (err) {
          out.innerHTML = '<p class="err">' + err.message + '</p>';
        } finally {
          btn.disabled = false;
          btn.textContent = 'Get pairing code';
        }
      });
    }
    setInterval(async () => {
      try {
        const r = await fetch('/status');
        const s = await r.json();
        if (s.status === 'connected' && ${JSON.stringify(connectionStatus)} !== 'connected') location.reload();
      } catch {}
    }, 3000);
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

app.get('/', (_req, res) => {
  res.type('html').send(htmlPage());
});

app.get('/status', (_req, res) => {
  res.json({
    status: connectionStatus,
    number: connectedNumber,
    hasPairingCode: Boolean(pairingCode),
    pairingCode,
  });
});

app.post('/pair', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    if (phone.length < 8) {
      return res.status(400).json({ error: 'Enter a valid number with country code, e.g. 2348012345678' });
    }
    if (connectionStatus === 'connected') {
      return res.status(400).json({ error: 'Already connected. Logout first.' });
    }

    await ensureSocket();

    if (!sock || sock.authState.creds.registered) {
      return res.status(400).json({ error: 'Session already registered. Use logout if you need a new pair.' });
    }

    const formatted = await requestPairing(phone);
    res.json({ code: formatted });
  } catch (err) {
    console.error('pair error', err);
    res.status(500).json({ error: err.message || 'Could not request pairing code' });
  }
});

app.post('/logout', async (_req, res) => {
  try {
    if (sock) {
      try { await sock.logout(); } catch {}
    }
    sock = null;
    pairingCode = null;
    lastQrDataUrl = null;
    connectionStatus = 'offline';
    connectedNumber = null;
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }
    startPromise = null;
    ensureSocket().catch(() => {});
    res.redirect('/');
  } catch (err) {
    res.status(500).send(String(err.message));
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
      connectedNumber = sock.user?.id?.split(':')[0] || null;
      console.log('Connected as', connectedNumber);
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log('Connection closed', code, loggedOut ? '(logged out)' : '');
      sock = null;
      connectionStatus = 'offline';
      connectedNumber = null;
      if (!loggedOut) {
        setTimeout(() => ensureSocket().catch(console.error), 2000);
      } else {
        pairingCode = null;
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    const body = String(text).trim();
    if (!body.toLowerCase().startsWith(PREFIX + 'ping')) return;

    const start = Date.now();
    await sock.sendMessage(msg.key.remoteJid, { text: 'pong' }, { quoted: msg });
    const ms = Date.now() - start;
    console.log(`.ping from ${msg.key.remoteJid} (${ms}ms)`);
  });

  return sock;
}

async function requestPairing(phoneRaw) {
  const phone = String(phoneRaw || '').replace(/\D/g, '');
  if (phone.length < 8) {
    throw new Error('Enter a valid number with country code, e.g. 234909383837');
  }
  await ensureSocket();
  if (!sock) throw new Error('Socket not ready, try again');
  if (sock.authState.creds.registered) {
    throw new Error('Session already registered. Delete the session folder to re-pair.');
  }
  pairingInProgress = true;
  const code = await sock.requestPairingCode(phone);
  pairingCode = String(code).match(/.{1,4}/g)?.join('-') || String(code);
  printPairingBanner(phone, pairingCode);
  return pairingCode;
}

function printPairingBanner(phone, code) {
  const line = '='.repeat(42);
  console.log('\n' + line);
  console.log('  PAIRING CODE FOR', phone);
  console.log('  >>>   ' + code + '   <<<');
  console.log(line);
  console.log('WhatsApp → Linked devices → Link a device');
  console.log('→ Link with phone number → enter the code\n');
}

function askTerminal(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

async function maybeTerminalPair() {
  if (terminalPromptStarted) return;
  terminalPromptStarted = true;

  await ensureSocket();
  if (!sock || sock.authState.creds.registered || connectionStatus === 'connected') {
    return;
  }

  const fromEnv = String(process.env.PHONE_NUMBER || process.env.NUMBER || '').replace(/\D/g, '');
  if (fromEnv.length >= 8) {
    console.log('Using PHONE_NUMBER from environment…');
    try {
      await requestPairing(fromEnv);
    } catch (err) {
      console.error('Pairing failed:', err.message);
    }
    return;
  }

  console.log('');
  console.log('No website? Pair from this console.');
  console.log('Type your number with country code (example: 234909383837) then press Enter.');
  try {
    const phone = await askTerminal('Phone number: ');
    if (!phone) {
      console.log('No number entered. Set PHONE_NUMBER=234… in env, or open the web pair page.');
      return;
    }
    await requestPairing(phone);
  } catch (err) {
    console.error('Pairing failed:', err.message);
  }
}

function startWebOrSkip() {
  if (WEB_DISABLED) {
    console.log('Web pair disabled (WEB=false). Use console / PHONE_NUMBER.');
    ensureSocket()
      .then(() => maybeTerminalPair())
      .catch((err) => console.error('start error', err));
    return;
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web pair page: http://0.0.0.0:${PORT}`);
    console.log('If this host has no public site, use the console prompt or PHONE_NUMBER.');
    ensureSocket()
      .then(() => maybeTerminalPair())
      .catch((err) => console.error('start error', err));
  });

  server.on('error', (err) => {
    console.warn('Web server failed (' + err.message + '). Falling back to terminal pairing.');
    ensureSocket()
      .then(() => maybeTerminalPair())
      .catch((e) => console.error('start error', e));
  });
}

startWebOrSkip();
