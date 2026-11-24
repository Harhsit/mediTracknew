// GET /api/models — the live Arena model catalog (same shape as the server
// edition). Cached at the edge for 5 minutes: listing models launches a
// browser, so don't pay that cost on every call.
const { listModels, ArenaError } = require('../lib/engine');

module.exports = async (req, res) => {
    if (req.method !== 'GET') { res.status(405).json({ status: 'error', code: 'METHOD', message: 'Use GET.' }); return; }
    try {
        const models = await listModels();
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        res.status(200).json({ status: 'success', models });
    } catch (err) {
        const code = err instanceof ArenaError ? err.code : 'INTERNAL';
        const http = code === 'NO_SESSION' || code === 'LOGIN_REQUIRED' ? 503 : 502;
        res.status(http).json({ status: 'error', code, message: err.message || 'Unknown error' });
    }
};
