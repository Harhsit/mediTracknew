# Arena Wrapper — Vercel Edition

Chat with arena.ai from a Vercel deployment: a chat page + `POST /api/chat`,
protected by one fixed API key. This is a **stateless** edition of the Arena
wrapper — Vercel has no persistent browser or disk, so every request launches
a fresh serverless Chromium, injects your Arena login from an env var, runs
the chat, and exits.

## Deploy (5 steps)

1. **Push this folder to Vercel.** Either deploy this repo with Vercel's
   *Root Directory* set to `vercel-edition`, or copy this folder into its own
   repo and import that. Framework preset: **Other**. (Deploying from your own
   Vercel account, like you did for the Duck wrapper.)
2. **Make the session string** (on your computer, in the main
   `arena-wrapper` project): `npm run login` once, then
   `npm run session-for-vercel` → it writes `arena-session.txt`.
3. **Set env vars** in the Vercel project (Settings → Environment Variables):
   - `ARENA_SESSION_B64` — the whole contents of `arena-session.txt`
   - `ARENA_API_KEY` — your fixed key, e.g. `arena-anything-you-like`
   - `ARENA_PROXY` — **strongly recommended:** a residential proxy
     (`http://user:pass@host:port`, e.g. your Webshare rotating endpoint).
     Arena/reCAPTCHA distrust Vercel's datacenter IPs; without a residential
     proxy, chats may come back blocked or empty.
   - `ALLOW_KEYLESS_CHAT` — optional; `true` lets the chat page work with no
     key at all (fine if only you use the deployment).
4. **Redeploy** so the env vars apply.
5. Open the site, paste your fixed key, chat. First request is slow
   (browser cold start, ~10–30 s); later ones are faster.

## API

- `POST /api/chat` — `{ message, model?, conversation_id?, image?/images?,
  generateImage? }` with `Authorization: Bearer <ARENA_API_KEY>` →
  `{ status, reply, images, model_used, model_id, conversation_id }`
- `GET /api/models` — live model list with `accepts_images` / `creates_images`
  / `creates_video` flags.

## Honest limits (Vercel platform, not the code)

- **No video creation.** Arena takes ~10 minutes to generate a video; Vercel
  kills requests at 300 s max (Pro) / 60 s (Hobby). The API answers
  `VIDEO_ON_VERCEL` with this explanation. Use the server edition for video.
- **Hobby plan is tight:** 60 s per request — a cold browser start plus a slow
  model can exceed it. Pro (300 s) is much safer.
- **The session can expire.** Arena rotates its login; if chats start failing
  with `LOGIN_REQUIRED`, re-run step 2 and update `ARENA_SESSION_B64`.
- **reCAPTCHA may still refuse** the serverless browser sometimes (headless
  scores low). The residential proxy is the main countermeasure. If Arena
  keeps refusing, the server edition on a VPS/home PC remains the reliable
  option — this edition is best-effort by design.
- **No created keys / dashboard** here (no disk). Fixed key only — same
  decision as the Duck wrapper on Vercel.
