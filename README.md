# Arynox AI — WhatsApp Automation

A full WhatsApp automation bot with a 2026 AI-product dashboard. It answers customers automatically with AI (Groq + OpenCode Zen), sends bulk messages, and supports both an unofficial free connection (QR scan) and the official Meta Cloud API.

## Features

- **AI automation** — answers every customer automatically like your business representative (Groq `openai/gpt-oss-120b`, fallback OpenCode Zen `deepseek-v4-flash-free`)
- **Conversation memory** — remembers the last 10 messages per customer (no more context-less replies)
- **Business profile** — teach the AI your business name, products, prices, tone and rules
- **Knowledge base (RAG)** — upload PDF/TXT/MD documents (menu, catalog, policies); the AI reads them when answering
- **Media library** — upload images/videos/PDFs, add notes, and the AI attaches the right media automatically in replies (`[media:filename]` tags)
- **Bulk messaging** — send text + media to all selected contacts with human-like delays and progress bar
- **Two backends**
  - **Unofficial** (Baileys) — free, scan QR, full contact sync
  - **Official** (Meta Cloud API) — webhook based, business number required
- **Anti-ban measures** — typing simulation, random delays (2–8s), per-user rate limiting (10 msgs/min), no double replies (dedupe), session persistence
- **2026 dashboard** — dark/light themes, mobile-first, toasts, live log, stats, contact list with last messages
- **Commands** — `!help`, `!ping`, `!time`, `!reset` (clear conversation memory)

## Installation

```bash
npm install
copy .env.example .env   # then fill in your keys
npm start
```

Open http://localhost:3000, scan the QR code (WhatsApp → Linked Devices → Link a Device), and the bot starts automating. All contacts load automatically.

## Configuration (.env)

```
GROQ_API_KEY=your_groq_api_key
OPENCODE_API_KEY=your_opencode_zen_api_key   # fallback provider
AI_PROVIDER=groq
GROQ_MODEL=openai/gpt-oss-120b
OPENCODE_MODEL=deepseek-v4-flash-free
SESSION_NAME=arynox_session
DASHBOARD_PASSWORD=your_dashboard_password     # REQUIRED on any public deployment
PORT=3000
WHATSAPP_BACKEND=baileys                      # baileys or meta
META_TOKEN=                                   # only for official backend
META_PHONE_NUMBER_ID=
META_VERIFY_TOKEN=
META_API_VERSION=v23.0
META_PUBLIC_URL=
```

Anti-ban timing is in `config.js`: `minDelayBetweenMessages`, `maxDelayBetweenMessages`, `maxMessagesPerMinute`, `bulkMinDelay`, `bulkMaxDelay`.

## Anti-ban safety system

**Honest disclaimer:** no unofficial WhatsApp automation is 100% "unbannable" — WhatsApp's terms prohibit it, and anyone claiming otherwise is selling you something. What this app does is make bans *very unlikely* by behaving like a human and respecting recipients:

- **Warm-up mode** — new sessions ramp up automatically: 25 → 50 → 100 → 200 → 400 messages/day over the first 5 days (the #1 reason new bots get banned is sending too much too early)
- **Daily + hourly caps** — hard limits enforced on every send (default 500/day, 30/hour), adjustable live from the dashboard
- **Quiet hours** — nothing sends between 22:00–08:00 by default; bulk sends pause and resume automatically
- **Opt-out handling** — customers who reply "stop" / "unsubscribe" are never messaged again (persisted list)
- **Message spinning** — write `{Hi|Hey|Hello}` in bulk messages; each recipient gets a random variant so texts aren't identical
- **Batch cooling** — bulk sends pause 1.5–4 min after every 25 messages
- **Human behavior** — typing simulation scaled to message length, randomized delays, read receipts with natural timing, per-user rate limiting
- **Official route available** — for guaranteed compliance, switch to the Meta Cloud API backend (official, no ban risk from automation itself)

All limits are visible live on the dashboard's **Safety & Limits** card.

## Security (production)

- Set `DASHBOARD_PASSWORD` in `.env`. The dashboard then requires login (signed cookie, 7 days) — without it, **anyone who can reach the server can control the bot, read your contacts and send messages**. Never expose the server without a password.
- The Meta access token is never sent back to the browser — only a masked preview (`EAAGxx...`); leave the field empty to keep the saved token.
- API hardening included: rate limits on send/bulk/test endpoints (429), message length caps, recipient number validation/deduplication, JSON error responses, 100 MB upload cap.
- Health check for hosting platforms: `GET /api/health`.

## Deployment

- Port: set `PORT` in `.env` (default 3000).
- Works on Windows (run.bat / `npm start`) and Linux VPS / Koyeb (`npm start`).
- If the port is already in use, the app exits with a clear message instead of hanging.
- Unofficial backend keeps the WhatsApp session on disk (gitignored) — on a VPS, session reconnects automatically; scan the QR once from the dashboard.

## Official Meta Cloud API

1. Set `WHATSAPP_BACKEND=meta` (or pick "OFFICIAL" on the dashboard and save)
2. Create a Meta Business app, add WhatsApp, get a permanent System User token
3. Enter token, phone number ID, verify token and your public URL (ngrok/VPS/Koyeb) in the dashboard
4. Configure the webhook in Meta: URL `https://your-url/webhook`, verify token you chose
5. Restart the app — customers who message the number are handled automatically

## Notes

- Unofficial backend: WhatsApp does not allow unofficial clients; the bot includes human-like delays and rate limits to minimize risk. Use responsibly.
- The dashboard stores its data in `data/` (business profile, knowledge base, media notes, contact cache) — all gitignored.