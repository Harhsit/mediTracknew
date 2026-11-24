// POST /api/chat — Vercel serverless function (Node runtime).
// Same request/response shape as the server edition:
//   { message, model?, conversation_id?, image?, images?, generateImage? }
//   -> { status:'success', reply, images, model_used, model_id, conversation_id }
// Auth: the fixed key in ARENA_API_KEY (Authorization: Bearer <key> or
// "api_key" in the body). ALLOW_KEYLESS_CHAT=true makes the key optional
// when none is sent. Created keys are NOT supported here (no disk on
// Vercel) — the fixed key is the way, same as the Duck wrapper on Vercel.
const { chat, ArenaError } = require('../lib/engine');

const FIXED_KEY = String(process.env.ARENA_API_KEY || '').trim();
const ALLOW_KEYLESS = process.env.ALLOW_KEYLESS_CHAT === 'true';
const BAD_IMAGE_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/;

function httpForCode(code) {
    if (['UNKNOWN_MODEL', 'IMAGE_NOT_SUPPORTED', 'VIDEO_ON_VERCEL', 'BAD_IMAGE'].includes(code)) return 400;
    if (['NO_SESSION', 'LOGIN_REQUIRED'].includes(code)) return 503;
    return 502;
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ status: 'error', code: 'METHOD', message: 'Use POST.' }); return; }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const auth = String(req.headers.authorization || '');
    const sentKey = (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : String(body.api_key || '')).trim();
    if (!sentKey) {
        if (!ALLOW_KEYLESS) { res.status(401).json({ status: 'error', code: 'NO_KEY', message: 'API key required (Authorization: Bearer <key>).' }); return; }
    } else if (!FIXED_KEY || sentKey !== FIXED_KEY) {
        res.status(401).json({ status: 'error', code: 'BAD_KEY', message: 'Invalid API key.' }); return;
    }

    const message = String(body.message || '').trim();
    if (!message) { res.status(400).json({ status: 'error', code: 'NO_MESSAGE', message: 'Field "message" is required.' }); return; }
    if (body.generateVideo) {
        res.status(400).json({ status: 'error', code: 'VIDEO_ON_VERCEL', message: 'Video creation takes ~10 minutes on Arena — longer than Vercel lets any request run. Use the server edition (Render/VPS) for video.' });
        return;
    }
    const images = [];
    if (body.image) images.push(body.image);
    if (Array.isArray(body.images)) images.push(...body.images);
    for (const img of images) {
        if (typeof img !== 'string' || !BAD_IMAGE_RE.test(img)) {
            res.status(400).json({ status: 'error', code: 'BAD_IMAGE', message: 'Images must be data URLs like "data:image/png;base64,...."' });
            return;
        }
    }

    try {
        const out = await chat({
            message,
            model: body.model || undefined,
            conversationId: body.conversation_id || undefined,
            images,
            generateImage: !!body.generateImage,
            generateVideo: false,
        });
        res.status(200).json({ status: 'success', ...out });
    } catch (err) {
        const code = err instanceof ArenaError ? err.code : 'INTERNAL';
        res.status(httpForCode(code)).json({ status: 'error', code, message: err.message || 'Unknown error' });
    }
};
