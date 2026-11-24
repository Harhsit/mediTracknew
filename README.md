# Arena AI Wrapper — API-key server for arena.ai (local or deployed)

Turns your own Arena (arena.ai, formerly LMArena) account into an
OpenAI-style local API: `POST /api/chat` with **your own API keys** and a
**model of your choice** per request. Same pattern as the DuckAI wrapper.

Arena has no official API and is protected by Cloudflare + reCAPTCHA, so
this wrapper keeps **one real Chromium browser** (Playwright, persistent
profile) logged in to your account on this machine and does everything
inside that page: session cookies authenticate, a fresh reCAPTCHA v3
token is minted in-page for every chat, and the chat runs as an in-page
`fetch` to Arena's internal streaming endpoint. Chats are serialised
(one at a time) — correctness over speed.

## Setup

```bash
npm install
npm run setup        # downloads Chromium for Playwright
npm run login        # a browser window opens — log in to arena.ai once
```

## Run

```bash
ADMIN_PASSWORD=choose-a-password ARENA_API_KEY=arena-pick-your-fixed-key npm start
# → http://localhost:3100/           (chat page)
# → http://localhost:3100/dashboard  (admin: create/revoke keys, fixed key, how-to)
```

Environment variables:

| Variable | Meaning |
|---|---|
| `PORT` | Port (default 3100) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Dashboard admin login (password required for key admin) |
| `ARENA_API_KEY` | One fixed API key that always works |
| `ALLOW_KEYLESS_CHAT` | `true` = key optional when no key is sent (a wrong key still gets 401) |
| `ARENA_HEADED` | `1` = show the engine browser window |
| `ARENA_PROXY` | Proxy for the engine browser, e.g. `http://user:pass@host:port` (also honours `HTTPS_PROXY`) |
| `ARENA_PROFILE_DIR` | Where the browser profile / Arena login lives (default `./arena-profile`) |

## API

```bash
curl -X POST http://localhost:3100/api/chat \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is 2+2? Answer with just the number", "model": "gpt-6-luna-max"}'
```

```json
{ "status": "success", "reply": "4", "model_used": "gpt-6-luna-max",
  "model_id": "…", "conversation_id": "…" }
```

- `GET /api/models` — the live model list scraped from arena.ai, with
  `accepts_images` / `creates_images` flags per model.
- Send `conversation_id` back to continue the same conversation.
- Model names come from Arena and change over time — check `/api/models`.

## Images

Send an image to a vision model (`accepts_images: true`) — the wrapper
uploads it through Arena's own storage flow (generate-upload-url →
PUT → get-signed-url) and attaches it, exactly like the website:

```json
{ "message": "What is in this picture?", "model": "gpt-6-luna-max",
  "image": "data:image/png;base64,iVBORw0KGgo..." }
```

(`"images": [ ... ]` accepts several; max 10 MB each.)

Create a video with `"generateVideo": true` — there is **no model
selection for video**: any `"model"` is ignored and the server picks a
random video model per request (`model_used` in the reply says which).
The video returns in the reply's `videos` list.

Create an image with an image model (`creates_images: true`):

```json
{ "message": "A red bicycle on a beach at sunset",
  "model": "<image model>", "generateImage": true }
```

The reply's `images` list carries each created image as a `url` and/or
`data_url`. Asking a model for a capability it doesn't have fails fast
with `IMAGE_NOT_SUPPORTED`.
- Errors carry a `code`: `LOGIN_REQUIRED` (run `npm run login` again),
  `RECAPTCHA_FAILED`, `EMPTY_STREAM`, `CLOUDFLARE_BLOCKED`,
  `UNKNOWN_MODEL`, `ARENA_UNREACHABLE`, …

## Vercel edition

A separate, stateless build for Vercel lives in **`vercel-edition/`** (its own
README has the deploy steps): every request launches a serverless Chromium,
injects your session from the `ARENA_SESSION_B64` env var (make it with
`npm run session-for-vercel` here, after `npm run login`), and chats with a
fixed key. Text, vision and image creation are supported; **video is not**
(Vercel's request time limit vs Arena's ~10-minute generation). Best-effort:
reCAPTCHA may still refuse a headless serverless browser sometimes — the
server edition below remains the reliable option.

## Deploy it as a site (Render / Railway / Fly / VPS)

The same code runs as a hosted site — there is a `Dockerfile` and a `render.yaml`
in this repo. Read the honest requirements first, they are stricter than the
Duck wrapper's:

- **RAM ≥ 2 GB.** The engine runs a real Chromium. Free tiers (512 MB) will
  crash it, and **Vercel cannot run it at all** (no persistent browser).
- **A persistent disk** mounted at `/data` (the blueprint does this): the Arena
  login session and `keys.json` live there (`DATA_DIR=/data`,
  `ARENA_PROFILE_DIR=/data/arena-profile`). Without a disk, every restart wipes
  the login and the created keys.
- **A residential proxy is strongly recommended** (`ARENA_PROXY`, e.g. a
  Webshare rotating endpoint like the Duck setup): Arena/reCAPTCHA distrust
  datacenter IPs, so a bare server IP may get silent 403s. Not guaranteed —
  Arena breaks wrappers from time to time; a home PC remains the most reliable
  host, a VPS the next best.

Steps (Render):

1. Push this repo to GitHub → Render → New → Blueprint (it reads `render.yaml`)
   — or New Web Service → Docker. Plan: **Standard (2 GB)** + the `/data` disk.
2. Set env vars: `ADMIN_PASSWORD`, `ARENA_API_KEY` (your fixed key), and
   `ARENA_PROXY` (your residential proxy).
3. On **your own computer**: `npm run login` (log in to arena.ai once), then
   `npm run export-session` → `arena-profile.zip`.
4. Open the deployed dashboard → log in as admin → **Import Arena session** →
   upload the zip. Done — the site now chats as your account, from anywhere,
   with the fixed key or created keys. If chats later return `LOGIN_REQUIRED`,
   repeat steps 3–4 with a fresh export.

## Honest limits

- Arena can change its site and break every wrapper (it has, several
  times). Errors are explicit instead of hangs, but fixes may be needed.
- Your Arena account's own limits apply (daily credits for Direct mode);
  rapid-fire requests earn cooldowns. Keep request rates human.
- Run it on the same machine/IP where you logged in — reCAPTCHA tokens
  are bound to both. A home machine is the right host; datacenter
  servers are exactly what Arena's protections punish.
- No tool/function calling through Arena — plain chat in, text out
  (images a model creates come back in the `images` field).
