import fs from 'node:fs';
const raw = fs.readFileSync('apitoken.txt', 'utf8');
const token = (raw.match(/cf[a-z]{1,4}_[A-Za-z0-9_-]{20,}/) || [])[0] || '';
const account = (raw.match(/id[:：]\s*([0-9a-f]{32})/) || [])[1] || '';
const name = 'github-rank';
const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}`, {
  headers: { authorization: 'Bearer ' + token },
});
console.log('status', r.status, r.headers.get('content-type'));
const text = await r.text();
console.log('len', text.length);
console.log('has raw ?v=', text.includes("'?v=' + encodeURIComponent(ASSET_V)"));
console.log('asset ver', (text.match(/ASSET_V\s*=\s*'([^']+)'/) || [])[1]);
