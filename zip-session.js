// zip-session.js — package your local Arena login for a deployed server.
//
//   npm run login             (once, on YOUR computer — log in to arena.ai)
//   npm run export-session    → creates arena-profile.zip next to this file
//
// Then on the deployed site: open the dashboard, log in as admin, and use
// "Import Arena session" to upload arena-profile.zip. The server extracts it
// into its browser profile and chats as your logged-in Arena account.
// Your Arena password never leaves your computer — only the browser session.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const PROFILE_DIR = process.env.ARENA_PROFILE_DIR || path.join(__dirname, 'arena-profile');
const OUT = path.join(__dirname, 'arena-profile.zip');
// Caches and lock files are large and useless to ship.
const SKIP = /(^|\/)(Cache|Code Cache|GPUCache|GrShaderCache|ShaderCache|Crashpad|BrowserMetrics|SingletonLock|SingletonCookie|SingletonSocket)(\/|$)/;

function walk(dir, base, out) {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = path.join(base, name).split(path.sep).join('/');
        if (SKIP.test(rel)) continue;
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full, rel, out);
        else if (st.isFile()) out.push({ full, rel });
    }
}

if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`No profile found at ${PROFILE_DIR}\nRun "npm run login" first and log in to arena.ai.`);
    process.exit(1);
}
const files = [];
walk(PROFILE_DIR, '', files);
if (!files.some(f => /Local State|Cookies/.test(f.rel))) {
    console.error('The profile does not look like a logged-in Chromium profile (no Local State / Cookies). Run "npm run login" again.');
    process.exit(1);
}
const zip = new AdmZip();
for (const f of files) zip.addLocalFile(f.full, path.dirname(f.rel) === '.' ? '' : path.dirname(f.rel), path.basename(f.rel));
zip.writeZip(OUT);
const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`✅ Exported ${files.length} files (${mb} MB) → ${OUT}`);
console.log('Now open your deployed dashboard → log in as admin → "Import Arena session" → choose this zip.');
