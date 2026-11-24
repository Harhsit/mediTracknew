// arena.js — the Arena.ai engine for this wrapper.
//
// How it works (built from the documented behaviour of the existing
// bridge projects, Nov 2026):
//  * arena.ai has NO official API and sits behind Cloudflare. Plain
//    HTTP clients get a "Just a moment…" 403. So this engine keeps ONE
//    real Chromium (Playwright, persistent profile in ./arena-profile)
//    logged in to the owner's Arena account, and does everything
//    inside that page:
//      - the page's own cookies (arena-auth-prod-v1 Supabase session +
//        Cloudflare clearance) authenticate every request,
//      - a fresh reCAPTCHA Enterprise v3 token is minted in-page,
//        just-in-time, for every chat (tokens live ~120 s and are
//        bound to IP + fingerprint, so they are never cached across
//        requests — the #1 failure of naive wrappers),
//      - the chat itself is an in-page fetch() to Arena's internal
//        streaming endpoint, so fingerprint/IP/cookies all match.
//  * Replies stream back as SSE lines with 3-char prefixes:
//      a0: text chunk (JSON string) · ag: reasoning chunk ·
//      ac: citations/tool chunk · ad: finish metadata ·
//      a2: image result · a3: error (JSON string)
//  * Models are scraped from the homepage's initialModels payload —
//    never hard-coded, so site changes are picked up automatically.
//  * All chats are SERIALISED through one queue: one browser, one
//    page, one conversation at a time. Correctness over speed.
//
// Login: run `npm run login` once on the machine that runs this
// server. It opens the same persistent profile in a visible browser;
// log in to Arena there and the session is reused by the server.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* reported at use */ }

const ORIGIN = 'https://arena.ai';
const PROFILE_DIR = process.env.ARENA_PROFILE_DIR || path.join(__dirname, 'arena-profile');
const HEADED = process.env.ARENA_HEADED === '1';
const DEFAULT_SITEKEY = '6Led_uYrAAAAAKjPDIF58fgFtX3t8loNAK85bW9I'; // fallback; scraped value wins

function uuidv7() {
    const ms = Date.now();
    const b = crypto.randomBytes(16);
    b[0] = (ms / 2 ** 40) & 0xff; b[1] = (ms / 2 ** 32) & 0xff; b[2] = (ms / 2 ** 24) & 0xff;
    b[3] = (ms / 2 ** 16) & 0xff; b[4] = (ms / 2 ** 8) & 0xff; b[5] = ms & 0xff;
    b[6] = 0x70 | (b[6] & 0x0f);
    b[8] = 0x80 | (b[8] & 0x3f);
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

class ArenaError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

// ---------------------------------------------------------------- browser
let contextPromise = null;
let page = null;

// Optional egress proxy for the engine browser: ARENA_PROXY wins,
// otherwise the standard HTTPS_PROXY env is honoured. Chromium cannot
// use an authenticated proxy from env vars alone, so credentials are
// passed to Playwright explicitly.
function proxyOption() {
    const raw = process.env.ARENA_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';
    if (!raw) return undefined;
    try {
        const u = new URL(raw);
        const opt = { server: `${u.protocol}//${u.hostname}:${u.port || 80}` };
        if (u.username) opt.username = decodeURIComponent(u.username);
        if (u.password) opt.password = decodeURIComponent(u.password);
        return opt;
    } catch (e) { return undefined; }
}

// Close the browser and forget cached state — used after a new Arena
// session (profile) is imported on a deployed server, so the next chat
// launches Chromium with the fresh login.
async function resetEngine() {
    try {
        if (contextPromise) {
            const ctx = await contextPromise.catch(() => null);
            if (ctx) await ctx.close().catch(() => {});
        }
    } catch (e) { /* already closed */ }
    contextPromise = null;
    page = null;
    siteData = null;
    modelsCache = null;
}

async function getPage() {
    if (!chromium) throw new ArenaError('NO_PLAYWRIGHT', 'playwright is not installed — run: npm install && npx playwright install chromium');
    if (page && !page.isClosed()) return page;
    if (!contextPromise) {
        fs.mkdirSync(PROFILE_DIR, { recursive: true });
        const proxy = proxyOption();
        contextPromise = chromium.launchPersistentContext(PROFILE_DIR, {
            headless: !HEADED,
            viewport: { width: 1366, height: 900 },
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
            ...(proxy ? { proxy } : {}),
        }).catch(err => { contextPromise = null; throw new ArenaError('BROWSER_START', `Chromium could not start: ${err.message}`); });
    }
    const ctx = await contextPromise;
    page = ctx.pages()[0] || await ctx.newPage();
    return page;
}

async function gotoArena(p) {
    if (!p.url().startsWith(ORIGIN)) {
        try {
            await p.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (err) {
            throw new ArenaError('ARENA_UNREACHABLE', `The server browser could not open arena.ai (${err.message.split('\n')[0]}). Check this machine's internet connection / ARENA_PROXY setting.`);
        }
    }
    // Cloudflare interstitial: wait a little for it to clear on its own.
    for (let i = 0; i < 10; i++) {
        const title = await p.title().catch(() => '');
        if (!/just a moment/i.test(title)) break;
        await p.waitForTimeout(2000);
    }
    const title = await p.title().catch(() => '');
    if (/just a moment/i.test(title)) {
        throw new ArenaError('CLOUDFLARE_BLOCKED', 'Cloudflare is showing a challenge page to the server browser. Run with ARENA_HEADED=1 (or under xvfb) and open the profile once via `npm run login` so the challenge can be passed.');
    }
}

// ---------------------------------------------------------------- session
async function getAuthSession(p) {
    const ctx = p.context();
    const cookies = await ctx.cookies(ORIGIN);
    let raw = '';
    const single = cookies.find(c => c.name === 'arena-auth-prod-v1');
    const part0 = cookies.find(c => c.name === 'arena-auth-prod-v1.0');
    const part1 = cookies.find(c => c.name === 'arena-auth-prod-v1.1');
    if (part0) raw = part0.value + (part1 ? part1.value : '');
    else if (single) raw = single.value;
    if (!raw) return null;
    try {
        const json = raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64').toString('utf8') : raw;
        const session = JSON.parse(json);
        return session;
    } catch (e) { return { _unparsed: true }; }
}

// ------------------------------------------------------------ auto-login
// If ARENA_EMAIL + ARENA_PASSWORD are set, the engine can log ITSELF in
// through Arena's own dialog — no manual `npm run login`, no session zip:
//   home (logged out) → "Log in" → "Your email" → "Continue with email"
//   → password field (existing accounts) → "Log In".
// The password comes only from the environment and is never logged.
// Attempts are throttled: at most one try per minute after a failure.
// Click an element three ways, hardest last: normal click, forced
// click, then a raw DOM click (fires even when an overlay intercepts
// the pointer — Arena's page has layers that eat real clicks in a
// headless browser while the element sits right there).
async function tryClick(el) {
    try { await el.click({ timeout: 2500 }); return true; } catch (e) { /* next style */ }
    try { await el.click({ force: true, timeout: 2500 }); return true; } catch (e) { /* next style */ }
    try { await el.evaluate(e => e.click()); return true; } catch (e) { return false; }
}

// Arena's logged-out page has more than one "Log in" entry (a promo
// banner and a sidebar/footer one) and they are not all <button>s — a
// strict getByRole('button') lookup misses them. Try each shape in turn.
async function clickLoginEntry(p) {
    const candidates = [
        p.getByRole('button', { name: /log in/i }),
        p.getByRole('link', { name: /log in/i }),
        p.locator('a, button').filter({ hasText: /^\s*log\s?in\s*$/i }),
        p.getByText(/^\s*log\s?in\s*$/i),
    ];
    for (const loc of candidates) {
        const el = loc.first();
        try {
            await el.waitFor({ state: 'visible', timeout: 4000 });
            await el.click();
            return true;
        } catch (e) { /* not this one — try the next shape */ }
    }
    return false;
}

let lastAutoLoginTry = 0;
let autoLoginError = null;
function autoLoginCreds() {
    const email = String(process.env.ARENA_EMAIL || '').trim();
    const password = String(process.env.ARENA_PASSWORD || '');
    return email && password ? { email, password } : null;
}
async function autoLogin(p) {
    const creds = autoLoginCreds();
    if (!creds) return false;
    if (Date.now() - lastAutoLoginTry < 60 * 1000 && autoLoginError) return false;
    lastAutoLoginTry = Date.now();
    autoLoginError = null;
    try {
        await gotoArena(p);
        // Click a Log in entry AND verify the dialog's email field really
        // appears — a click can land before React attaches its handlers,
        // or on a look-alike element, and silently do nothing. Retry
        // through the candidate shapes until the dialog is truly open.
        const emailInput = p.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
        const dialogHeading = p.getByText(/log in or create account/i).first();
        let opened = false;
        const attempts = [];
        const entries = [
            ['button-role', p.getByRole('button', { name: /log in/i })],
            ['link-role', p.getByRole('link', { name: /log in/i })],
            ['a/button-text', p.locator('a, button').filter({ hasText: /^\s*log\s?in\s*$/i })],
            ['any-text', p.getByText(/^\s*log\s?in\s*$/i)],
        ];
        for (const [name, loc] of entries) {
            const el = loc.first();
            try {
                await el.waitFor({ state: 'visible', timeout: attempts.length === 0 ? 25000 : 6000 });
                if (!(await tryClick(el))) throw new Error('all click styles failed');
                await Promise.race([
                    emailInput.waitFor({ state: 'visible', timeout: 12000 }),
                    dialogHeading.waitFor({ state: 'visible', timeout: 12000 }),
                ]);
                opened = true;
                break;
            } catch (e) {
                attempts.push(name + ' → ' + String(e && e.message || e).split('\n')[0].slice(0, 110));
            }
        }
        if (!opened) {
            throw new ArenaError('AUTO_LOGIN_FAILED', 'The Arena login dialog never opened. Attempts: ' + attempts.join(' | '));
        }
        await emailInput.waitFor({ state: 'visible', timeout: 10000 });
        const dialog = p.locator('div[role="dialog"]').last();
        const scope = (await dialog.count().catch(() => 0)) > 0 ? dialog : p;
        await emailInput.fill(creds.email);
        await scope.getByRole('button', { name: /continue with email/i }).click();
        const passInput = p.locator('input[type="password"]').first();
        try {
            await passInput.waitFor({ state: 'visible', timeout: 20000 });
        } catch (e) {
            const text = await p.evaluate(() => (document.body && document.body.innerText || '')).catch(() => '');
            if (/verify your email|verification link|create account/i.test(text)) {
                throw new ArenaError('AUTO_LOGIN_FAILED', 'Arena answered the email step with a create-account / verify-by-email-link screen, not a password field. Auto-login only works for an existing account that has a password. Log in once with `npm run login` (or the session import) for this account.');
            }
            throw new ArenaError('AUTO_LOGIN_FAILED', 'The password field never appeared after the email step. Arena may have changed its login dialog.');
        }
        await passInput.fill(creds.password);
        await scope.getByRole('button', { name: /^log in$/i }).click();
        // Success = the Supabase auth cookie shows up (checked by caller too).
        for (let i = 0; i < 30; i++) {
            if (await getAuthSession(p)) return true;
            const text = await p.evaluate(() => (document.body && document.body.innerText || '')).catch(() => '');
            if (/invalid|incorrect|wrong password|try again/i.test(text)) {
                throw new ArenaError('AUTO_LOGIN_FAILED', 'Arena rejected the email/password (ARENA_EMAIL / ARENA_PASSWORD). Check the env vars.');
            }
            await p.waitForTimeout(1000);
        }
        throw new ArenaError('AUTO_LOGIN_FAILED', 'Login was submitted but no session appeared (a captcha or an extra verification step may be blocking it).');
    } catch (err) {
        autoLoginError = err instanceof ArenaError ? err : new ArenaError('AUTO_LOGIN_FAILED', 'Auto-login failed: ' + err.message.split('\n')[0]);
        return false;
    }
}
// Return a live session, auto-logging-in first when credentials are set.
async function ensureSession(p) {
    let session = await getAuthSession(p);
    if (session) return session;
    if (await autoLogin(p)) session = await getAuthSession(p);
    return session;
}

async function loginStatus() {
    const p = await getPage();
    await gotoArena(p);
    const session = await ensureSession(p);
    if (!session) return { logged_in: false, auto_login_error: autoLoginError ? autoLoginError.message : undefined };
    const expiresAt = session.expires_at ? session.expires_at * 1000 : null;
    return { logged_in: true, expires_at: expiresAt, expired: expiresAt ? Date.now() > expiresAt : false };
}

// ---------------------------------------------------------------- models + sitekey
let modelsCache = { at: 0, models: null, sitekey: null };

const VIDEO_ARENAS = ['text-to-video', 'image-to-video', 'video-to-video'];
const IMAGE_ARENAS = ['text-to-image', 'image-edit', 'multi-image-edit'];

// Extract the homepage's embedded initialModels array from the RSC
// payload. The payload stores JSON as an escaped string, so scan with a
// bracket matcher that understands \" string delimiters instead of a
// regex that depends on which key happens to follow the array (that
// dependency is exactly what kept breaking the old scrape).
function extractInitialModels(html) {
    const key = '\\"initialModels\\":';
    const start = html.indexOf(key);
    if (start < 0) return null;
    let i = start + key.length;
    if (html[i] !== '[') return null;
    let depth = 0, inStr = false;
    for (let j = i; j < html.length; j++) {
        const c = html[j];
        if (c === '\\') {
            if (html[j + 1] === '"') inStr = !inStr;
            j++; // skip the escaped character
            continue;
        }
        if (inStr) continue;
        if (c === '[') depth++;
        else if (c === ']') {
            depth--;
            if (depth === 0) {
                const raw = html.slice(i, j + 1);
                try { const arr = JSON.parse(JSON.parse('"' + raw + '"')); return Array.isArray(arr) ? arr : null; }
                catch (e) { return null; }
            }
        }
    }
    return null;
}

async function scrapeSiteData(p) {
    if (modelsCache.models && Date.now() - modelsCache.at < 5 * 60 * 1000) return modelsCache;
    const html = await p.content();
    let sitekey = null;
    const sk = html.match(/recaptcha\/(?:enterprise|api)\.js\?render=([0-9A-Za-z_-]{8,200})/);
    if (sk) sitekey = sk[1];

    // Primary source: Arena's public model catalog. It is split into
    // per-arena sections (text, vision, text-to-image, text-to-video,
    // …) and is the ONLY place that lists every model — the homepage's
    // embedded initialModels only carries the current arena's subset,
    // which is why video/image models went missing with scraping alone.
    // Cloudflare sometimes 403-challenges this fetch while the page
    // itself loads fine, so retry before falling back.
    let models = null;
    for (let attempt = 0; attempt < 3 && !models; attempt++) {
        if (attempt > 0) await p.waitForTimeout(2500);
        try {
            const catalog = await p.evaluate(async () => {
                const res = await fetch('/nextjs-api/model-catalog');
                if (!res.ok) return null;
                return await res.json().catch(() => null);
            });
            if (Array.isArray(catalog)) {
            const byId = new Map();
            for (const section of catalog) {
                if (!section || !Array.isArray(section.models)) continue;
                for (const model of section.models) {
                    if (!model || !model.id) continue;
                    const existing = byId.get(model.id);
                    if (existing) {
                        if (section.arena && !existing._arenas.includes(section.arena)) existing._arenas.push(section.arena);
                    } else {
                        byId.set(model.id, { ...model, _arenas: section.arena ? [section.arena] : [] });
                    }
                }
            }
            if (byId.size) models = [...byId.values()];
            }
        } catch (e) { /* fall back to the page scrape below */ }
    }

    // Fallback: the homepage's embedded initialModels (subset).
    if (!models) {
        const arr = extractInitialModels(html);
        if (arr) models = arr.map(mo => ({ ...mo, _arenas: [] }));
    }

    if (Array.isArray(models)) {
        modelsCache = { at: Date.now(), models, sitekey: sitekey || modelsCache.sitekey };
    }
    return { models, sitekey: sitekey || modelsCache.sitekey || DEFAULT_SITEKEY };
}

function modelCaps(m) {
    const caps = m.capabilities || {};
    const input = caps.inputCapabilities || m.inputCapabilities || {};
    const output = caps.outputCapabilities || m.outputCapabilities || {};
    return { input, output };
}
function modalityFor(m, forceImage, forceVideo) {
    const { output } = modelCaps(m);
    if (forceVideo || output.video) return 'video';
    if (forceImage || output.image) return 'image';
    if (output.search) return 'search';
    return 'chat';
}

async function listModels() {
    const p = await getPage();
    await gotoArena(p);
    const { models } = await scrapeSiteData(p);
    if (!models) throw new ArenaError('MODELS_UNAVAILABLE', 'Could not read the model list from arena.ai (site layout may have changed).');
    return models
        .filter(m => m && m.id && (m.userSelectable !== false))
        .map(m => {
            const { input, output } = modelCaps(m);
            const arenas = m._arenas || [];
            return {
                id: m.id,
                name: m.publicName || m.id,
                organization: m.organization || null,
                accepts_images: !!input.image,
                creates_images: !!output.image || arenas.some(a => IMAGE_ARENAS.includes(a)),
                creates_video: !!output.video || arenas.some(a => VIDEO_ARENAS.includes(a)),
                arenas,
                capabilities: { input, output },
            };
        });
}

async function resolveModel(p, wanted) {
    const { models } = await scrapeSiteData(p);
    if (!models) throw new ArenaError('MODELS_UNAVAILABLE', 'Could not read the model list from arena.ai.');
    if (!wanted) {
        const first = models.find(m => m.userSelectable !== false) || models[0];
        return first;
    }
    const byId = models.find(m => m.id === wanted);
    if (byId) return byId;
    const byName = models.find(m => (m.publicName || '').toLowerCase() === String(wanted).toLowerCase());
    if (byName) return byName;
    const names = models.filter(m => m.userSelectable !== false).map(m => m.publicName || m.id).slice(0, 40).join(', ');
    throw new ArenaError('UNKNOWN_MODEL', `Unknown model "${wanted}". Available: ${names}`);
}

// ---------------------------------------------------------------- recaptcha
async function mintRecaptcha(p, sitekey, action) {
    const token = await p.evaluate(async ({ sitekey, action }) => {
        if (!window.grecaptcha || !window.grecaptcha.enterprise) {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = `https://www.google.com/recaptcha/enterprise.js?render=${sitekey}`;
                s.onload = resolve; s.onerror = () => reject(new Error('recaptcha script failed to load'));
                document.head.appendChild(s);
                setTimeout(() => reject(new Error('recaptcha script load timeout')), 15000);
            });
        }
        // ready() takes a CALLBACK — calling it bare throws
        // "Invalid listener argument" inside recaptcha's own code.
        await new Promise((resolve) => window.grecaptcha.enterprise.ready(resolve));
        return window.grecaptcha.enterprise.execute(sitekey, { action });
    }, { sitekey, action }).catch(err => { throw new ArenaError('RECAPTCHA_FAILED', `reCAPTCHA token could not be minted: ${err.message}`); });
    if (!token) throw new ArenaError('RECAPTCHA_FAILED', 'reCAPTCHA returned an empty token (the browser/IP score may be too low — a headed browser on a residential connection works best).');
    return token;
}

// ---------------------------------------------------------------- images in
// Arena image upload is a 3-step storage flow (same as the web app):
//   1. POST /api/storage/generate-upload-url {fileName, contentType}
//      -> {uploadUrl, key}            (needs the login cookies: in-page)
//   2. PUT the raw bytes to uploadUrl (presigned R2 URL: plain fetch)
//   3. POST /api/storage/get-signed-url {key} -> {url}   (in-page)
// The chat then references {name: key, contentType, url} in
// userMessage.experimental_attachments.
async function uploadImage(p, dataUrl, accessToken) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!m) throw new ArenaError('BAD_IMAGE', 'Images must be data URLs like "data:image/png;base64,...."');
    const mime = m[1];
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length) throw new ArenaError('BAD_IMAGE', 'The image data was empty.');
    if (bytes.length > 10 * 1024 * 1024) throw new ArenaError('BAD_IMAGE', 'Image is larger than Arena\'s 10 MB limit.');
    const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : '.png';
    const fileName = `upload-${uuidv7()}${ext}`;
    const step1 = await p.evaluate(async ({ fileName, mime, accessToken }) => {
        const headers = { 'Content-Type': 'application/json' };
        if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
        const res = await fetch('/api/storage/generate-upload-url', {
            method: 'POST', headers,
            body: JSON.stringify({ fileName, contentType: mime }),
        });
        return { status: res.status, data: await res.json().catch(() => null) };
    }, { fileName, mime, accessToken });
    if (step1.status !== 200 || !step1.data || !step1.data.uploadUrl || !step1.data.key) {
        throw new ArenaError('IMAGE_UPLOAD_FAILED', `Arena refused the image upload (HTTP ${step1.status}).`);
    }
    const put = await fetch(step1.data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes });
    if (!put.ok) throw new ArenaError('IMAGE_UPLOAD_FAILED', `Uploading the image bytes failed (HTTP ${put.status}).`);
    const key = String(step1.data.key).replace(/^\//, '');
    const step3 = await p.evaluate(async ({ key, accessToken }) => {
        const headers = { 'Content-Type': 'application/json' };
        if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
        const res = await fetch('/api/storage/get-signed-url', {
            method: 'POST', headers,
            body: JSON.stringify({ key }),
        });
        return { status: res.status, data: await res.json().catch(() => null) };
    }, { key, accessToken });
    if (step3.status !== 200 || !step3.data || !step3.data.url) {
        throw new ArenaError('IMAGE_UPLOAD_FAILED', `Arena did not return a download URL for the image (HTTP ${step3.status}).`);
    }
    return { name: step1.data.key, contentType: mime, url: step3.data.url };
}

// ---------------------------------------------------------------- SSE parse
function parseStream(text) {
    let reply = '', reasoning = '', error = null, finish = null; const images = []; const videos = [];
    for (const rawLine of String(text).split('\n')) {
        const line = rawLine.startsWith('data:') ? rawLine.slice(5).trim() : rawLine.trim();
        if (!line) continue;
        const prefix = line.slice(0, 3);
        const payload = line.slice(3);
        try {
            if (prefix === 'a0:') reply += JSON.parse(payload);
            else if (prefix === 'ag:') reasoning += JSON.parse(payload);
            else if (prefix === 'a3:') error = JSON.parse(payload);
            else if (prefix === 'ad:') finish = JSON.parse(payload);
            else if (prefix === 'a2:') {
                // Generated media: [{type:"image"|"video", image:<url>, url, mimeType, data?}]
                const arr = JSON.parse(payload);
                if (Array.isArray(arr)) for (const it of arr) {
                    if (!it) continue;
                    const isVideo = it.type === 'video' || String(it.mimeType || '').startsWith('video/');
                    const media = { mime_type: it.mimeType || null };
                    if (it.image) media.url = it.image; else if (it.url) media.url = it.url;
                    if (typeof it.data === 'string' && it.data) media.data_url = `data:${it.mimeType || (isVideo ? 'video/mp4' : 'image/png')};base64,${it.data}`;
                    if (media.url || media.data_url) (isVideo ? videos : images).push(media);
                }
            }
            else if (prefix === 'ak:') {
                // Generated file: {data:<base64>, mimeType}
                const obj = JSON.parse(payload);
                if (obj && typeof obj.data === 'string' && obj.data && String(obj.mimeType || 'image').startsWith('image')) {
                    images.push({ mime_type: obj.mimeType || null, data_url: `data:${obj.mimeType || 'image/png'};base64,${obj.data}` });
                }
            }
            else if (line.startsWith('{')) {
                const obj = JSON.parse(line);
                const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
                if (delta && delta.content) reply += delta.content;
            }
        } catch (e) { /* keep going: partial chunks are not fatal */ }
    }
    return { reply, reasoning, error, finish, images, videos };
}

// ---------------------------------------------------------------- chat
let queue = Promise.resolve();
function enqueue(fn) { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; }

async function chatOnce({ message, model, conversationId, images, generateImage, generateVideo }) {
    const p = await getPage();
    await gotoArena(p);
    const session = await ensureSession(p);
    if (!session) {
        if (autoLoginError) throw autoLoginError;
        throw new ArenaError('LOGIN_REQUIRED', 'No Arena login in the server browser profile. Either set ARENA_EMAIL + ARENA_PASSWORD so the server logs itself in, or run `npm run login` on this machine and log in to arena.ai once.');
    }
    const accessToken = session.access_token || null;
    const { sitekey } = await scrapeSiteData(p);
    let modelObj = await resolveModel(p, model);
    // Video creation has NO model selection: for a new video request a
    // random video model is picked from the whole catalog, whatever
    // model the caller named (or didn't). model_used in the reply says
    // which one was drawn. Follow-ups keep their conversation's model.
    const wantsVideo = !!generateVideo || !!modelCaps(modelObj).output.video || (modelObj._arenas || []).some(a => VIDEO_ARENAS.includes(a));
    if (wantsVideo && !conversationId) {
        const { models } = await scrapeSiteData(p);
        const vids = (models || []).filter(m => m.userSelectable !== false && (!!modelCaps(m).output.video || (m._arenas || []).some(a => VIDEO_ARENAS.includes(a))));
        if (generateVideo && !vids.length) {
            throw new ArenaError('VIDEO_NOT_SUPPORTED', 'No video models are available in Arena\'s catalog right now.');
        }
        if (vids.length) modelObj = vids[Math.floor(Math.random() * vids.length)];
    }
    const { input, output } = modelCaps(modelObj);
    const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
    if (imageList.length && input.image === false) {
        throw new ArenaError('IMAGE_NOT_SUPPORTED', `The model "${modelObj.publicName || modelObj.id}" does not accept image input. Pick a vision model from GET /api/models (accepts_images: true).`);
    }
    if (generateImage && output.image === false) {
        throw new ArenaError('IMAGE_NOT_SUPPORTED', `The model "${modelObj.publicName || modelObj.id}" cannot create images. Pick an image model from GET /api/models (creates_images: true).`);
    }
    if (generateVideo && !output.video && !(modelObj._arenas || []).some(a => VIDEO_ARENAS.includes(a))) {
        throw new ArenaError('VIDEO_NOT_SUPPORTED', `The model "${modelObj.publicName || modelObj.id}" cannot create videos.`);
    }
    const attachments = [];
    for (const img of imageList) attachments.push(await uploadImage(p, img, accessToken));
    const isFollowUp = !!conversationId;
    const convId = conversationId || uuidv7();
    const payload = {
        id: convId,
        ...(isFollowUp ? {} : { mode: 'direct-battle' }),
        modelAId: modelObj.id,
        userMessageId: uuidv7(),
        modelAMessageId: uuidv7(),
        userMessage: { content: message, experimental_attachments: attachments, metadata: {} },
        modality: modalityFor(modelObj, !!generateImage, !!generateVideo),
        recaptchaV3Token: await mintRecaptcha(p, sitekey || DEFAULT_SITEKEY, 'chat_submit'),
    };
    const url = isFollowUp ? `/nextjs-api/stream/post-to-evaluation/${convId}` : '/nextjs-api/stream/create-evaluation';
    const result = await p.evaluate(async ({ url, payload, accessToken }) => {
        // Prefer the token the page's own Supabase client is holding in
        // localStorage right now; fall back to the cookie-parsed one.
        let token = accessToken || null;
        let tokenSource = token ? 'cookie' : 'none';
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!/auth/i.test(k)) continue;
                const parsed = JSON.parse(localStorage.getItem(k));
                const t = parsed && (parsed.access_token || (parsed.currentSession && parsed.currentSession.access_token));
                if (t) { token = t; tokenSource = 'localStorage:' + k; break; }
            }
        } catch (e) { /* keep the cookie token */ }
        const headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        let exp = null;
        if (token) { try { exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || null; } catch (e) { /* not a JWT */ } }
        return { status: res.status, text: await res.text(), tokenSource, tokenExp: exp };
    }, { url, payload, accessToken });
    if (result.status === 401 || result.status === 403) {
        throw new ArenaError('UPSTREAM_' + result.status, `Arena rejected the request (HTTP ${result.status}) — session expired or reCAPTCHA refused. Details: ${result.text.slice(0, 200)} [token: source=${result.tokenSource || '?'}, exp=${result.tokenExp ? new Date(result.tokenExp * 1000).toISOString() : 'unknown'}]`);
    }
    if (result.status !== 200) {
        throw new ArenaError('UPSTREAM_' + result.status, `Arena returned HTTP ${result.status}: ${result.text.slice(0, 200)}`);
    }
    const parsed = parseStream(result.text);
    if (parsed.error) throw new ArenaError('ARENA_ERROR', `Arena error: ${parsed.error}`);
    if (!parsed.reply && !parsed.images.length && !parsed.videos.length) {
        throw new ArenaError('EMPTY_STREAM', 'Arena returned an empty reply (a known silent-failure mode — usually reCAPTCHA score or a stale session). Try again; if it persists, re-run `npm run login`.');
    }
    return {
        reply: parsed.reply,
        reasoning: parsed.reasoning || undefined,
        images: parsed.images,
        videos: parsed.videos,
        model_used: modelObj.publicName || modelObj.id,
        model_id: modelObj.id,
        conversation_id: convId,
    };
}

function chat(args) {
    return enqueue(async () => {
        try { return await chatOnce(args); }
        catch (err) {
            // One retry with a fresh token/page state for transient failures.
            if (err instanceof ArenaError && ['EMPTY_STREAM', 'RECAPTCHA_FAILED', 'UPSTREAM_403'].includes(err.code)) {
                const p = await getPage();
                await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
                return await chatOnce(args);
            }
            throw err;
        }
    });
}

module.exports = { chat, listModels, loginStatus, resetEngine, ArenaError, PROFILE_DIR, _test: { scrapeSiteData, parseStream, modalityFor, modelCaps, VIDEO_ARENAS, IMAGE_ARENAS, autoLogin, ensureSession, autoLoginCreds } };
