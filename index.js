// index.js — Arena AI wrapper: a local API-key server for arena.ai.
//
// Same shape as the DuckAI wrapper: users/apps call POST /api/chat
// with an API key created on the dashboard (or the one fixed key),
// pick a model per request, and get a plain JSON reply. The Arena
// engine (arena.js) does the logged-in browser work behind it.
//
// Environment variables:
//   PORT                server port (default 3100)
//   ARENA_API_KEY       one fixed API key that always works
//   ADMIN_USERNAME      dashboard admin username (default "admin")
//   ADMIN_PASSWORD      dashboard admin password (REQUIRED for key admin)
//   ALLOW_KEYLESS_CHAT  "true" = key optional when no key is sent
//   ARENA_HEADED        "1" = run the engine browser visibly
//   ARENA_PROFILE_DIR   where the browser profile/login lives

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const arena = require('./arena');

const app = express();
app.use(cors());
// The session-import route carries a big base64 zip, so it skips this parser
// and uses its own (400mb) one.
const jsonParser = express.json({ limit: '25mb' });
app.use((req, res, next) => { if (req.path === '/api/admin/import-session') return next(); jsonParser(req, res, next); });

const PORT = parseInt(process.env.PORT || '3100', 10);
// DATA_DIR: where keys.json lives. On a deployed host point this at a
// persistent disk (e.g. /data on Render) so created keys survive restarts.
// The Arena browser profile defaults to ARENA_PROFILE_DIR, else ./arena-profile.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const FIXED_KEY = String(process.env.ARENA_API_KEY || '').trim();
const ALLOW_KEYLESS = process.env.ALLOW_KEYLESS_CHAT === 'true';
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');

// ---------------------------------------------------------------- keys
function loadKeys() {
    try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (e) { return []; }
}
function saveKeys(keys) { fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2)); }
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }
function maskKeyRecord(r) { return { id: r.id, label: r.label, last4: r.last4, created_at: r.created_at, revoked: !!r.revoked }; }

function checkApiKey(req) {
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = bearer || String(req.headers['x-api-key'] || '').trim();
    if (!key) return ALLOW_KEYLESS ? 'keyless' : null;
    if (FIXED_KEY && key === FIXED_KEY) return 'fixed';
    const rec = loadKeys().find(k => k.hash === hashKey(key) && !k.revoked);
    return rec ? rec.id : null;
}
function requireKey(req, res, next) {
    const who = checkApiKey(req);
    if (!who) return res.status(401).json({ status: 'error', message: 'Unauthorized! Galat ya missing API Key hai.' });
    req.keyOwner = who;
    next();
}

// ---------------------------------------------------------------- admin
const sessions = new Map(); // sid -> { username, at }
const loginFails = { count: 0, until: 0 };
function adminSession(req) {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/arena_admin=([a-f0-9]{48})/);
    if (!m) return null;
    const s = sessions.get(m[1]);
    if (!s || Date.now() - s.at > 12 * 3600 * 1000) return null;
    return s;
}
function requireAdmin(req, res, next) {
    if (!adminSession(req)) return res.status(401).json({ status: 'error', message: 'Admin login required' });
    next();
}

app.get('/api/admin/status', (req, res) => {
    res.json({ status: 'success', logged_in: !!adminSession(req), admin_configured: !!ADMIN_PASSWORD });
});
app.post('/api/admin/login', (req, res) => {
    if (!ADMIN_PASSWORD) return res.status(503).json({ status: 'error', message: 'Admin is not configured on this server (ADMIN_PASSWORD is not set).' });
    if (Date.now() < loginFails.until) return res.status(429).json({ status: 'error', message: 'Too many wrong tries. Wait a bit and try again.' });
    const { username, password } = req.body || {};
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        loginFails.count = 0;
        const sid = crypto.randomBytes(24).toString('hex');
        sessions.set(sid, { username, at: Date.now() });
        res.setHeader('Set-Cookie', `arena_admin=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 3600}`);
        return res.json({ status: 'success', username: ADMIN_USERNAME });
    }
    loginFails.count++;
    if (loginFails.count >= 5) { loginFails.until = Date.now() + 5 * 60 * 1000; loginFails.count = 0; }
    return res.status(401).json({ status: 'error', message: 'Wrong username or password.' });
});
app.post('/api/admin/logout', (req, res) => {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/arena_admin=([a-f0-9]{48})/);
    if (m) sessions.delete(m[1]);
    res.setHeader('Set-Cookie', 'arena_admin=; HttpOnly; Path=/; Max-Age=0');
    res.json({ status: 'success' });
});
app.get('/api/admin/master-key', requireAdmin, (req, res) => {
    if (!FIXED_KEY) return res.json({ status: 'success', configured: false });
    res.json({ status: 'success', configured: true, api_key: FIXED_KEY, masked_key: '...' + FIXED_KEY.slice(-4), last4: FIXED_KEY.slice(-4) });
});
app.get('/api/admin/arena-status', requireAdmin, async (req, res) => {
    try { res.json({ status: 'success', ...(await arena.loginStatus()) }); }
    catch (err) { res.json({ status: 'success', logged_in: false, error: err.message }); }
});

// Import an Arena login session into the server's browser profile.
// On your own computer: `npm run login` once, then `npm run export-session`
// makes arena-profile.zip. Upload that zip here (admin only) and the deployed
// server picks up the login — no Arena password ever touches the server.
// Body: { zip_b64: "<base64 zip>" } (sent by the dashboard's import button).
app.post('/api/admin/import-session', express.json({ limit: '400mb' }), requireAdmin, async (req, res) => {
    const b64 = String((req.body || {}).zip_b64 || '');
    if (!b64) return res.status(400).json({ status: 'error', code: 'NO_FILE', message: 'No session file received.' });
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (e) { return res.status(400).json({ status: 'error', code: 'BAD_FILE', message: 'Session file is not valid base64.' }); }
    if (buf.length < 1000) return res.status(400).json({ status: 'error', code: 'BAD_FILE', message: 'Session file is too small to be a profile zip.' });
    let AdmZip;
    try { AdmZip = require('adm-zip'); } catch (e) { return res.status(500).json({ status: 'error', code: 'NO_UNZIP', message: 'adm-zip is not installed on the server — run npm install.' }); }
    try {
        const zip = new AdmZip(buf);
        const entries = zip.getEntries();
        if (!entries.some(e => /Local Storage|Cookies|Local State/.test(e.entryName))) {
            return res.status(400).json({ status: 'error', code: 'BAD_FILE', message: 'This zip does not look like an arena-profile export (no Local State / Cookies / Local Storage inside).' });
        }
        await arena.resetEngine().catch(() => {});
        fs.rmSync(arena.PROFILE_DIR, { recursive: true, force: true });
        fs.mkdirSync(arena.PROFILE_DIR, { recursive: true });
        zip.extractAllTo(arena.PROFILE_DIR, true);
        // The zip may wrap the profile in a top-level folder — flatten it.
        const inner = path.join(arena.PROFILE_DIR, 'arena-profile');
        if (fs.existsSync(inner) && fs.statSync(inner).isDirectory()) {
            for (const name of fs.readdirSync(inner)) fs.renameSync(path.join(inner, name), path.join(arena.PROFILE_DIR, name));
            fs.rmdirSync(inner);
        }
        res.json({ status: 'success', message: 'Arena session imported. The next chat will start the browser with this login.', files: entries.length });
    } catch (err) {
        res.status(500).json({ status: 'error', code: 'IMPORT_FAILED', message: 'Import failed: ' + err.message });
    }
});

// ---------------------------------------------------------------- key CRUD (admin)
app.post('/api/keys', requireAdmin, (req, res) => {
    const label = String((req.body && req.body.label) || 'Untitled key').slice(0, 80);
    const key = 'arena-' + crypto.randomBytes(24).toString('base64url');
    const rec = { id: crypto.randomBytes(8).toString('hex'), label, hash: hashKey(key), last4: key.slice(-4), created_at: new Date().toISOString(), revoked: false };
    const keys = loadKeys(); keys.push(rec); saveKeys(keys);
    res.json({ status: 'success', ...maskKeyRecord(rec), api_key: key });
});
app.get('/api/keys', requireAdmin, (req, res) => {
    res.json({ status: 'success', keys: loadKeys().map(maskKeyRecord) });
});
app.delete('/api/keys/:id', requireAdmin, (req, res) => {
    const keys = loadKeys();
    const rec = keys.find(k => k.id === req.params.id);
    if (!rec) return res.status(404).json({ status: 'error', message: 'Key not found' });
    rec.revoked = true; saveKeys(keys);
    res.json({ status: 'success', ...maskKeyRecord(rec) });
});

// ---------------------------------------------------------------- models + chat
app.get('/api/models', async (req, res) => {
    try {
        const models = await arena.listModels();
        res.json({ status: 'success', source: 'arena.ai-live', models });
    } catch (err) {
        res.status(502).json({ status: 'error', code: err.code || 'MODELS', message: err.message });
    }
});

app.post('/api/chat', requireKey, async (req, res) => {
    const { message, model, conversation_id, image, images, generateImage, generateVideo } = req.body || {};
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ status: 'error', message: 'Body must include a "message" string.' });
    }
    const imageList = [];
    if (typeof image === 'string' && image) imageList.push(image);
    if (Array.isArray(images)) for (const im of images) if (typeof im === 'string' && im) imageList.push(im);
    for (const im of imageList) {
        if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(im)) {
            return res.status(400).json({ status: 'error', code: 'BAD_IMAGE', message: 'Images must be data URLs like "data:image/png;base64,...."' });
        }
    }
    const started = Date.now();
    try {
        const out = await arena.chat({ message, model: model || undefined, conversationId: conversation_id || undefined, images: imageList, generateImage: !!generateImage, generateVideo: !!generateVideo });
        console.log(`[arena] chat ok model=${out.model_used} images_in=${imageList.length} images_out=${(out.images || []).length} in ${Date.now() - started}ms (key: ${req.keyOwner})`);
        res.json({ status: 'success', ...out });
    } catch (err) {
        const code = err.code || 'ERROR';
        console.error(`[arena] chat failed (${code}) in ${Date.now() - started}ms: ${err.message}`);
        const http = ['UNKNOWN_MODEL', 'IMAGE_NOT_SUPPORTED', 'VIDEO_NOT_SUPPORTED', 'BAD_IMAGE'].includes(code) ? 400 : code === 'LOGIN_REQUIRED' ? 503 : 502;
        res.status(http).json({ status: 'error', code, message: err.message });
    }
});

// ---------------------------------------------------------------- pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'home.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.listen(PORT, () => {
    console.log(`Arena AI wrapper running on port ${PORT}`);
    console.log(`  Home:      http://localhost:${PORT}/`);
    console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`  Fixed key: ${FIXED_KEY ? 'configured' : 'not set (ARENA_API_KEY)'} · Admin: ${ADMIN_PASSWORD ? 'configured' : 'NOT configured (ADMIN_PASSWORD)'} · Keyless chat: ${ALLOW_KEYLESS ? 'ON' : 'off'}`);
    console.log('  First time? Run `npm run login` and log in to arena.ai in the window that opens.');
});
