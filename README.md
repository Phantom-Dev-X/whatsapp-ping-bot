# WhatsApp Bot (web pair + console pair + `.ping`)

Node.js bot using Baileys. Pair from a **browser** or from the **panel console** if the host has no website.

## Pair — two ways

### 1) Website (if the panel gives you a port / domain)

Open the site → enter `234909383837` → use the code in WhatsApp.

### 2) Terminal (no website)

On start the bot asks:

```
Phone number: 234909383837
```

It then prints:

```
==========================================
  PAIRING CODE FOR 234909383837
  >>>   ABCD-EFGH   <<<
==========================================
```

WhatsApp → **Linked devices** → **Link a device** → **Link with phone number**.

Or skip the prompt and set env:

```
PHONE_NUMBER=234909383837
```

If the host has no site at all:

```
WEB=false
```

## Spaceify / any Pterodactyl panel

1. Create a **Node 18/20** server on [client.spaceify.eu](https://client.spaceify.eu).
2. Startup: `npm start`
3. Clone once: `git clone https://github.com/Phantom-Dev-X/whatsapp-ping-bot.git .`
4. Start. Console prints a pairing code for `2348147051558` (`WEB=false` in `.env`).
5. Need another code: type `pair` in the console.
6. **Restart** on the panel pulls the latest GitHub commit first.

Baileys: **`@whiskeysockets/baileys`** (WhatsApp Web multi-device). Not the official WhatsApp Business API.

## Auto-deploy from GitHub

`npm start` runs `start.js`, which:

1. Checks `Phantom-Dev-X/whatsapp-ping-bot` on GitHub
2. If there is a new commit, downloads it, runs `npm install`, keeps `session/`
3. Restarts (the panel brings the process back up)
4. Repeats every **3 minutes**

Env:

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUTO_DEPLOY` | `true` | Set `false` to turn this off |
| `GITHUB_REPO` | `Phantom-Dev-X/whatsapp-ping-bot` | `owner/name` |
| `GITHUB_BRANCH` | `main` | Branch to track |
| `DEPLOY_INTERVAL_MS` | `180000` | How often to poll |

KataBump startup command should be `npm start` (not `node index.js`).

## Panel deploy

1. Upload these files.
2. Startup: `npm start` (Node 18+).
3. `npm install` if the panel does not do it.
4. Keep the `session/` folder after first pair.

| Variable        | Default     | Meaning                                      |
|-----------------|-------------|----------------------------------------------|
| `PORT`          | `3000`      | Web pair page                                |
| `WEB`           | `true`      | Set `false` to skip the website              |
| `PHONE_NUMBER`  | (empty)     | Auto-print pairing code (country code, no +) |
| `SESSION_DIR`   | `./session` | Login files                                  |

## Commands

| Command | Who | What |
|---------|-----|------|
| `.ping` | public / owner | Reacts ⚡ then replies `pong` |
| `.mode` | owner | Shows current mode |
| `.mode public` | owner | Bot replies to everyone |
| `.mode private` | owner | Bot only replies to the paired number |

Every `.command` gets a reaction first, then the reply.

3 seconds after connect, the bot DMs you: **NOVA ABSOLUTE bot is connected**.

Pairing codes are **not** auto-printed. Type `pair` in the panel console.

**Baileys:** `@whiskeysockets/baileys` **7.0.0-rc14** (latest WhiskeySockets).

503 / “restart required” (515) reconnects immediately and does **not** burn a retry. Other drops: 3 tries then stop.

## Free hosting (I can’t host it for you)

This bot needs a **process that stays online** (WhatsApp Web socket). Sleepy free web hosts will drop the session.

Realistic free-ish options:

| Place | Notes |
|-------|--------|
| **Oracle Cloud “Always Free” VM** | Best long-term free: small Ubuntu VPS, 24/7. Needs a card to sign up. |
| **Koyeb free nano** | Often used for WA bots; no sleep on the free instance (limits apply). |
| **Render free** | Easy, but **sleeps** when idle — bad for WhatsApp. |
| **Railway** | Nice UX; free credit is usually a **trial**, then pay. |
| **Free Pterodactyl bot panels** (Katabump, Bot-Hosting, similar) | Good fit: console + files. RAM is tight; this bot is small. |
| **Your PC / Termux** | Always works; phone must stay on if Termux. |

I can’t run the bot on Arena 24/7 for you. Use a VPS or a bot panel, pair once, and don’t delete `session/`.
