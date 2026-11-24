// lib/engine.js — stateless Arena engine for Vercel serverless functions.
//
// How it differs from the server edition (../arena.js): there is no
// persistent browser or profile on Vercel, so EVERY request:
//   1. launches a fresh serverless Chromium (@sparticuz/chromium),
//   2. injects the Arena login from the ARENA_SESSION_B64 env var
//      (a Playwright storageState export of the user's logged-in browser —
//      make it with `npm run session-for-vercel` in the main project),
//   3. optionally routes the browser through ARENA_PROXY (residential —
//      strongly recommended; Arena distrusts Vercel/AWS datacenter IPs),
//   4. runs the exact same in-page protocol as the server edition
//      (catalog fetch, just-in-time reCAPTCHA mint, create-evaluation POST,
//      SSE parse), then closes the browser.
// Video creation is refused: Arena takes ~10 minutes to generate a video and
// Vercel kills a request long before that (300 s max even on Pro).
const crypto = require('crypto');

const ORIGIN = 'https://arena.ai';
const DEFAULT_SITEKEY = '6Led_uYrAAAAAKjPDIF58fgFtX3t8loNAK85bW9I';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VIDEO_ARENAS = ['text-to-video', 'image-to-video', 'video-to-video'];
const IMAGE_ARENAS = ['text-to-image', 'image-edit', 'multi-image-edit'];

class ArenaError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

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

function loadSession() {
    const b64 = String(process.env.ARENA_SESSION_B64 || '').trim();
    if (!b64) throw new ArenaError('NO_SESSION', 'ARENA_SESSION_B64 is not set on this deployment. Create it with `npm run session-for-vercel` in the main arena-wrapper project (after `npm run login`) and paste it into the Vercel project env vars.');
    try {
        const state = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        if (!state || !Array.isArray(state.cookies)) throw new Error('bad shape');
        return state;
    } catch (e) {
        throw new ArenaError('NO_SESSION', 'ARENA_SESSION_B64 is set but is not a valid session export. Re-run `npm run session-for-vercel` and paste the fresh value.');
    }
}

function proxyOption() {
    const raw = process.env.ARENA_PROXY || process.env.HTTPS_PROXY || '';
    if (!raw) return undefined;
    try {
        const u = new URL(raw);
        const opt = { server: `${u.protocol}//${u.hostname}:${u.port || 80}` };
        if (u.username) opt.username = decodeURIComponent(u.username);
        if (u.password) opt.password = decodeURIComponent(u.password);
        return opt;
    } catch (e) { return undefined; }
}

async function withPage(fn) {
    const session = loadSession();
    const sparticuz = require('@sparticuz/chromium');
    const { chromium } = require('playwright-core');
    const executablePath = await sparticuz.executablePath();
    const browser = await chromium.launch({
        executablePath,
        args: [...sparticuz.args, '--no-sandbox', '--disable-dev-shm-usage'],
        headless: true,
        proxy: proxyOption(),
    });
    try {
        const context = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
        if (session.cookies.length) await context.addCookies(session.cookies);
        // Restore localStorage too (Supabase keeps parts of the session there).
        const origins = (session.origins || []).filter(o => o && o.origin === ORIGIN && Array.isArray(o.localStorage) && o.localStorage.length);
        if (origins.length) {
            const items = origins[0].localStorage;
            await context.addInitScript((items) => {
                try { for (const it of items) localStorage.setItem(it.name, it.value); } catch (e) {}
            }, items);
        }
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        try {
            await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (err) {
            throw new ArenaError('ARENA_UNREACHABLE', `The serverless browser could not open arena.ai (${err.message.split('\n')[0]}). If ARENA_PROXY is set, check the proxy works.`);
        }
        for (let i = 0; i < 8; i++) {
            const title = await page.title().catch(() => '');
            if (!/just a moment/i.test(title)) break;
            await page.waitForTimeout(2000);
        }
        const title = await page.title().catch(() => '');
        if (/just a moment/i.test(title)) {
            throw new ArenaError('CLOUDFLARE_BLOCKED', 'Cloudflare is challenging the serverless browser. A residential ARENA_PROXY usually fixes this; without one, Vercel datacenter IPs are often blocked.');
        }
        return await fn(page);
    } finally {
        await browser.close().catch(() => {});
    }
}

// ------------------------------------------------------------ site data
async function scrapeSiteData(p) {
    const html = await p.content();
    let sitekey = null;
    const sk = html.match(/recaptcha\/(?:enterprise|api)\.js\?render=([0-9A-Za-z_-]{8,200})/);
    if (sk) sitekey = sk[1];
    let models = null;
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
    } catch (e) { /* fall back below */ }
    if (!models) {
        const m = html.match(/\\"initialModels\\":(\[.*?\]),\\"initialModel[A-Z]Id/s);
        if (m) {
            try { models = JSON.parse(JSON.parse('"' + m[1].replace(/"/g, '\\"') + '"')); } catch (e) { /* ignore */ }
        }
        if (Array.isArray(models)) models = models.map(mo => ({ ...mo, _arenas: [] }));
    }
    return { models, sitekey: sitekey || DEFAULT_SITEKEY };
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

async function getAuthSession(p) {
    const cookies = await p.context().cookies(ORIGIN);
    let raw = '';
    const single = cookies.find(c => c.name === 'arena-auth-prod-v1');
    const part0 = cookies.find(c => c.name === 'arena-auth-prod-v1.0');
    const part1 = cookies.find(c => c.name === 'arena-auth-prod-v1.1');
    if (part0) raw = part0.value + (part1 ? part1.value : '');
    else if (single) raw = single.value;
    if (!raw) return null;
    try {
        const json = raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64').toString('utf8') : raw;
        return JSON.parse(json);
    } catch (e) { return { _unparsed: true }; }
}

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
        await window.grecaptcha.enterprise.ready();
        return window.grecaptcha.enterprise.execute(sitekey, { action });
    }, { sitekey, action }).catch(err => { throw new ArenaError('RECAPTCHA_FAILED', `reCAPTCHA token could not be minted: ${err.message}`); });
    if (!token) throw new ArenaError('RECAPTCHA_FAILED', 'reCAPTCHA returned an empty token — the serverless browser/IP score is likely too low. Setting ARENA_PROXY to a residential proxy is the main fix.');
    return token;
}

async function uploadImage(p, dataUrl) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!m) throw new ArenaError('BAD_IMAGE', 'Images must be data URLs like "data:image/png;base64,...."');
    const mime = m[1];
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length) throw new ArenaError('BAD_IMAGE', 'The image data was empty.');
    if (bytes.length > 10 * 1024 * 1024) throw new ArenaError('BAD_IMAGE', 'Image is larger than Arena\'s 10 MB limit.');
    const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : mime === 'image/gif' ? '.gif' : '.png';
    const fileName = `upload-${uuidv7()}${ext}`;
    const step1 = await p.evaluate(async ({ fileName, mime }) => {
        const res = await fetch('/api/storage/generate-upload-url', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName, contentType: mime }),
        });
        return { status: res.status, data: await res.json().catch(() => null) };
    }, { fileName, mime });
    if (step1.status !== 200 || !step1.data || !step1.data.uploadUrl || !step1.data.key) {
        throw new ArenaError('IMAGE_UPLOAD_FAILED', `Arena refused the image upload (HTTP ${step1.status}).`);
    }
    const put = await fetch(step1.data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes });
    if (!put.ok) throw new ArenaError('IMAGE_UPLOAD_FAILED', `Uploading the image bytes failed (HTTP ${put.status}).`);
    const key = String(step1.data.key).replace(/^\//, '');
    const step3 = await p.evaluate(async ({ key }) => {
        const res = await fetch('/api/storage/get-signed-url', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
        });
        return { status: res.status, data: await res.json().catch(() => null) };
    }, { key });
    if (step3.status !== 200 || !step3.data || !step3.data.url) {
        throw new ArenaError('IMAGE_UPLOAD_FAILED', `Arena did not return a download URL for the image (HTTP ${step3.status}).`);
    }
    return { name: step1.data.key, contentType: mime, url: step3.data.url };
}

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
        } catch (e) { /* partial chunks are not fatal */ }
    }
    return { reply, reasoning, error, finish, images, videos };
}

function resolveModel(models, wanted) {
    if (!wanted) return models.find(m => m.userSelectable !== false) || models[0];
    const byId = models.find(m => m.id === wanted);
    if (byId) return byId;
    const byName = models.find(m => (m.publicName || '').toLowerCase() === String(wanted).toLowerCase());
    if (byName) return byName;
    const names = models.filter(m => m.userSelectable !== false).map(m => m.publicName || m.id).slice(0, 40).join(', ');
    throw new ArenaError('UNKNOWN_MODEL', `Unknown model "${wanted}". Available: ${names}`);
}

// ------------------------------------------------------------ public API
async function listModels() {
    return withPage(async (p) => {
        const { models } = await scrapeSiteData(p);
        if (!models) throw new ArenaError('MODELS_UNAVAILABLE', 'Could not read the model list from arena.ai.');
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
    });
}

async function chat({ message, model, conversationId, images, generateImage, generateVideo }) {
    if (generateVideo) {
        throw new ArenaError('VIDEO_ON_VERCEL', 'Video creation takes ~10 minutes on Arena — longer than Vercel lets any request run (300 s max). Use the server edition (Render/VPS) for video; text, vision and image creation work here.');
    }
    return withPage(async (p) => {
        const session = await getAuthSession(p);
        if (!session) throw new ArenaError('LOGIN_REQUIRED', 'The Arena session in ARENA_SESSION_B64 is missing or expired. Re-run `npm run session-for-vercel` in the main project and update the env var.');
        const { models, sitekey } = await scrapeSiteData(p);
        if (!models) throw new ArenaError('MODELS_UNAVAILABLE', 'Could not read the model list from arena.ai.');
        const modelObj = resolveModel(models, model);
        const { input, output } = modelCaps(modelObj);
        const isVideoModel = !!output.video || (modelObj._arenas || []).some(a => VIDEO_ARENAS.includes(a));
        if (isVideoModel) {
            throw new ArenaError('VIDEO_ON_VERCEL', `"${modelObj.publicName || modelObj.id}" is a video model — video cannot run on Vercel (request time limit). Pick a text or image model.`);
        }
        const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
        if (imageList.length && input.image === false) {
            throw new ArenaError('IMAGE_NOT_SUPPORTED', `The model "${modelObj.publicName || modelObj.id}" does not accept image input. Pick a vision model (accepts_images: true).`);
        }
        if (generateImage && output.image === false) {
            throw new ArenaError('IMAGE_NOT_SUPPORTED', `The model "${modelObj.publicName || modelObj.id}" cannot create images. Pick an image model (creates_images: true).`);
        }
        const attachments = [];
        for (const img of imageList) attachments.push(await uploadImage(p, img));
        const isFollowUp = !!conversationId;
        const convId = conversationId || uuidv7();
        const payload = {
            id: convId,
            ...(isFollowUp ? {} : { mode: 'direct-battle' }),
            modelAId: modelObj.id,
            userMessageId: uuidv7(),
            modelAMessageId: uuidv7(),
            userMessage: { content: message, experimental_attachments: attachments, metadata: {} },
            modality: modalityFor(modelObj, !!generateImage, false),
            recaptchaV3Token: await mintRecaptcha(p, sitekey || DEFAULT_SITEKEY, 'chat_submit'),
        };
        const url = isFollowUp ? `/nextjs-api/stream/post-to-evaluation/${convId}` : '/nextjs-api/stream/create-evaluation';
        const result = await p.evaluate(async ({ url, payload }) => {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                body: JSON.stringify(payload),
            });
            return { status: res.status, text: await res.text() };
        }, { url, payload });
        if (result.status === 401 || result.status === 403) {
            throw new ArenaError('UPSTREAM_' + result.status, `Arena rejected the request (HTTP ${result.status}) — session expired or reCAPTCHA refused (serverless browsers score low; a residential ARENA_PROXY helps). Details: ${result.text.slice(0, 200)}`);
        }
        if (result.status !== 200) {
            throw new ArenaError('UPSTREAM_' + result.status, `Arena returned HTTP ${result.status}: ${result.text.slice(0, 200)}`);
        }
        const parsed = parseStream(result.text);
        if (parsed.error) throw new ArenaError('ARENA_ERROR', `Arena error: ${parsed.error}`);
        if (!parsed.reply && !parsed.images.length) {
            throw new ArenaError('EMPTY_STREAM', 'Arena returned an empty reply (a known silent-failure mode — usually reCAPTCHA score or a stale session). Try again; if it persists, refresh ARENA_SESSION_B64 and check ARENA_PROXY.');
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
    });
}

module.exports = { chat, listModels, ArenaError };
