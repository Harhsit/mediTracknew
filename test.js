// test.js — run the four wrapper tests THROUGH the real HTTP API.
//
// Before running:
//   1. npm run login            (once — log in to arena.ai)
//   2. ADMIN_PASSWORD=... ARENA_API_KEY=arena-yourkey npm start
//   3. API_KEY=arena-yourkey node test.js
//
// It calls POST /api/chat exactly like your own apps would and prints
// PASS/FAIL per test with the actual reply / media it got back.
const zlib = require('zlib');

const BASE = process.env.BASE || 'http://localhost:3100';
const KEY = process.env.API_KEY || process.env.ARENA_API_KEY || '';
if (!KEY) { console.error('Set API_KEY (your fixed key or a created key) first.'); process.exit(1); }

// A solid-red 600x600 PNG, built in code (same test image as the UI test).
function redSquareDataUrl() {
    const w = 600, h = 600;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
    for (let i = 0; i < w; i++) { row[1 + i * 3] = 255; row[1 + i * 3 + 1] = 0; row[1 + i * 3 + 2] = 0; }
    const raw = Buffer.concat(Array(h).fill(row));
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
    return 'data:image/png;base64,' + png.toString('base64');
}

async function chat(body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(BASE + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        return await res.json();
    } finally { clearTimeout(t); }
}

function show(name, ok, detail) {
    console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    return ok;
}

(async () => {
    let allOk = true;
    console.log(`Testing the Arena wrapper at ${BASE}\n`);

    // T1 — text with GPT
    try {
        const d = await chat({ message: 'What is 2+2? Answer with just the number', model: 'gpt-6-luna-max' }, 180000);
        allOk = show('T1  text · gpt-6-luna-max', d.status === 'success' && /4/.test(d.reply || ''), `reply: ${JSON.stringify(d.reply)} (model_used: ${d.model_used || '?'})`) && allOk;
        if (d.status !== 'success') console.log('     error:', d.code, d.message);
    } catch (e) { allOk = show('T1  text · gpt-6-luna-max', false, e.message) && allOk; }

    // T1b — text with Argon
    try {
        const d = await chat({ message: 'What is 3+3? Answer with just the number', model: 'gemini-4-argon-high' }, 180000);
        allOk = show('T1b text · gemini-4-argon-high', d.status === 'success' && /6/.test(d.reply || ''), `reply: ${JSON.stringify(d.reply)} (model_used: ${d.model_used || '?'})`) && allOk;
        if (d.status !== 'success') console.log('     error:', d.code, d.message);
    } catch (e) { allOk = show('T1b text · gemini-4-argon-high', false, e.message) && allOk; }

    // T2 — image input (vision)
    try {
        const d = await chat({ message: 'What is in this image? Answer in one short sentence', model: 'gpt-6-luna-max', image: redSquareDataUrl() }, 240000);
        allOk = show('T2  vision · image input', d.status === 'success' && /red/i.test(d.reply || ''), `reply: ${JSON.stringify(d.reply)}`) && allOk;
        if (d.status !== 'success') console.log('     error:', d.code, d.message);
    } catch (e) { allOk = show('T2  vision · image input', false, e.message) && allOk; }

    // T3 — image creation
    try {
        const d = await chat({ message: 'A red bicycle on a beach at sunset', model: 'gemini-3.1-flash-lite-image (nano-banana-2-lite)', generateImage: true }, 300000);
        const img = (d.images || [])[0];
        allOk = show('T3  image creation', d.status === 'success' && !!img, img ? `image: ${(img.url || img.data_url || '').slice(0, 90)}…` : `no image returned`) && allOk;
        if (d.status !== 'success') console.log('     error:', d.code, d.message);
    } catch (e) { allOk = show('T3  image creation', false, e.message) && allOk; }

    // T4 — video creation (random model, none selected)
    try {
        console.log('     T4 can take up to ~10 minutes (video generation)…');
        const d = await chat({ message: 'A drone shot flying over a beach at sunset', generateVideo: true }, 720000);
        const vid = (d.videos || [])[0];
        allOk = show('T4  video creation · random model', d.status === 'success' && !!vid, vid ? `model_used: ${d.model_used} · video: ${(vid.url || vid.data_url || '').slice(0, 90)}…` : 'no video returned') && allOk;
        if (d.status !== 'success') console.log('     error:', d.code, d.message);
    } catch (e) { allOk = show('T4  video creation · random model', false, e.message) && allOk; }

    console.log(allOk ? '\n🎉 All tests passed through the wrapper.' : '\nSome tests failed — send the error codes above to Muse for a fix.');
    process.exit(allOk ? 0 : 1);
})().catch(e => { console.error('Test runner crashed:', e.message); process.exit(1); });
