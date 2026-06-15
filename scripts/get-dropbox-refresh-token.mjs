/**
 * Script untuk generate DROPBOX_REFRESH_TOKEN
 * 
 * Cara pakai:
 * 1. node scripts/get-dropbox-refresh-token.mjs
 * 2. Buka URL yang diberikan di browser
 * 3. Login Dropbox dan izinkan akses
 * 4. Copy "authorization code" dari URL redirect
 * 5. Paste ke terminal saat diminta
 * 6. Copy DROPBOX_REFRESH_TOKEN yang tampil ke .env kamu
 */

import readline from 'readline';
import https from 'https';
import querystring from 'querystring';

const CLIENT_ID = process.env.DROPBOX_CLIENT_ID;
const CLIENT_SECRET = process.env.DROPBOX_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ ERROR: Set DROPBOX_CLIENT_ID dan DROPBOX_CLIENT_SECRET di .env terlebih dahulu');
  console.error('   Atau jalankan: DROPBOX_CLIENT_ID=xxx DROPBOX_CLIENT_SECRET=yyy node scripts/get-dropbox-refresh-token.mjs');
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Step 1: Generate authorization URL
const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&token_access_type=offline`;

console.log('\n=== Dropbox Refresh Token Generator ===\n');
console.log('1️⃣  Buka URL berikut di browser kamu:\n');
console.log(`   ${authUrl}\n`);
console.log('2️⃣  Login ke Dropbox dan klik "Allow"');
console.log('3️⃣  Setelah redirect, copy "code" dari URL (contoh: ?code=XXXX)\n');

rl.question('Paste authorization code di sini: ', (code) => {
  if (!code.trim()) {
    console.error('❌ Code tidak boleh kosong');
    rl.close();
    process.exit(1);
  }

  // Step 2: Exchange code for tokens
  const postData = querystring.stringify({
    code: code.trim(),
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const options = {
    hostname: 'api.dropbox.com',
    path: '/oauth2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.error) {
          console.error(`\n❌ Error: ${result.error_description || result.error}`);
          rl.close();
          return;
        }

        console.log('\n✅ Berhasil! Tambahkan ke file .env kamu:\n');
        console.log(`DROPBOX_REFRESH_TOKEN="${result.refresh_token}"`);
        console.log('\n⚠️  Hapus atau comment DROPBOX_ACCESS_TOKEN dari .env (sudah tidak diperlukan)');
        console.log('\nDone! Restart server kamu setelah update .env\n');
      } catch (e) {
        console.error('❌ Gagal parse response:', data);
      }
      rl.close();
    });
  });

  req.on('error', (e) => {
    console.error('❌ Request error:', e.message);
    rl.close();
  });

  req.write(postData);
  req.end();
});
