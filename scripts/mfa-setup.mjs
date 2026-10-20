#!/usr/bin/env node
/**
 * Generates a TOTP secret for one of the built-in accounts.
 *   npm run mfa:setup -- superadmin     → set SUPERADMIN_TOTP_SECRET
 *   npm run mfa:setup -- team           → set ADMIN_TOTP_SECRET
 * Add the printed key to your authenticator app, then set the env var on the server (Vercel → Environment Variables).
 */
import crypto from 'node:crypto';
import qrcode from 'qrcode-terminal';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const account = (process.argv[2] || '').toLowerCase();
const map = { superadmin: 'SUPERADMIN_TOTP_SECRET', team: 'ADMIN_TOTP_SECRET' };
if (!map[account]) {
  console.error('Usage: npm run mfa:setup -- <superadmin|team>');
  process.exit(1);
}

const secret = base32(crypto.randomBytes(20));
const uri = `otpauth://totp/${encodeURIComponent(`TokenTracer:${account}`)}?secret=${secret}&issuer=TokenTracer&algorithm=SHA1&digits=6&period=30`;

console.log(`\nAccount: ${account}\n`);
console.log('1. Scan this QR code with Google Authenticator (+ → Scan a QR code):\n');
qrcode.generate(uri, { small: true }, (qr) => {
  console.log(qr);
  console.log('   (Can\'t scan? Use "Enter a setup key" and paste the key below.)\n');
  console.log(`   Setup key: ${secret}\n`);
  console.log('2. Add this to Vercel → Settings → Environment Variables, then redeploy:\n');
  console.log(`   ${map[account]}=${secret}\n`);
  console.log('Keep the key secret — anyone with it can generate valid codes. Clear your terminal history when done.\n');
});
