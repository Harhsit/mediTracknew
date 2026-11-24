// session-for-vercel.js — export your Arena login for the Vercel edition.
//
//   npm run login              (once — log in to arena.ai in this profile)
//   npm run session-for-vercel → prints one long base64 string
//
// Paste that string as the ARENA_SESSION_B64 environment variable in your
// Vercel project (Settings → Environment Variables), then redeploy.
// The Vercel function injects these cookies into its serverless browser on
// every request — that is how a stateless host carries your login.
// Note: Arena rotates its session over time; if the Vercel site starts
// answering LOGIN_REQUIRED, run this again and update the env var.
const fs = require('fs');
const path = require('path');

const PROFILE_DIR = process.env.ARENA_PROFILE_DIR || path.join(__dirname, 'arena-profile');
const OUT = path.join(__dirname, 'arena-session.txt');

(async () => {
    if (!fs.existsSync(PROFILE_DIR)) {
        console.error(`No profile at ${PROFILE_DIR} — run "npm run login" first.`);
        process.exit(1);
    }
    const { chromium } = require('playwright');
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        args: ['--no-sandbox'],
        viewport: { width: 1366, height: 900 },
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://arena.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000); // let Supabase refresh/settle the session
    const cookies = await ctx.cookies('https://arena.ai');
    const hasAuth = cookies.some(c => c.name.startsWith('arena-auth-prod-v1'));
    if (!hasAuth) {
        console.error('This profile has NO Arena login (no arena-auth cookie). Run "npm run login" and sign in first.');
        await ctx.close();
        process.exit(1);
    }
    const state = await ctx.storageState();
    await ctx.close();
    const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
    fs.writeFileSync(OUT, b64);
    console.log(`✅ Session exported (${state.cookies.length} cookies, ${(b64.length / 1024).toFixed(0)} KB base64)`);
    console.log(`Saved to ${OUT} — copy its whole contents into Vercel as ARENA_SESSION_B64, then redeploy.`);
    console.log('Keep that file private: it is your logged-in session.');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
