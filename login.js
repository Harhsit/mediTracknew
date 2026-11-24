// login.js — one-time Arena login for this wrapper.
// Opens a VISIBLE Chromium window using the same persistent profile
// the server uses (./arena-profile). Log in to arena.ai there
// (Google or email). This script waits until the Arena session
// cookie appears, then saves and exits. The server reuses the
// profile afterwards — you only redo this when the session dies.
const { chromium } = require('playwright');
const path = require('path');

const PROFILE_DIR = process.env.ARENA_PROFILE_DIR || path.join(__dirname, 'arena-profile');

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

(async () => {
    const proxy = proxyOption();
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1280, height: 850 },
        args: ['--no-sandbox'],
        ...(proxy ? { proxy } : {}),
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://arena.ai/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    console.log('\n==============================================================');
    console.log('A browser window is open on arena.ai.');
    console.log('Log in there with your Arena account (Google or email).');
    console.log('Waiting for the login to appear (up to 10 minutes)…');
    console.log('==============================================================\n');
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
        const cookies = await ctx.cookies('https://arena.ai');
        const has = cookies.some(c => c.name.startsWith('arena-auth-prod-v1'));
        if (has) {
            console.log('✅ Arena login detected and saved in the profile.');
            console.log('You can now start the server:  npm start');
            await ctx.close();
            process.exit(0);
        }
        await new Promise(r => setTimeout(r, 3000));
    }
    console.log('⏰ No login detected within 10 minutes. Run this again when ready.');
    await ctx.close();
    process.exit(1);
})().catch(e => { console.error('Login helper failed:', e.message); process.exit(1); });
