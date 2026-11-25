// 用 Cloudflare API 直接部署 worker.js（不用 wrangler，不受 github.com 网络影响）
// 用法：node scripts/deploy-worker.mjs [--dry]
import fs from 'node:fs';

const raw = fs.readFileSync('apitoken.txt', 'utf8');
const TOKEN = (raw.match(/cfut_[A-Za-z0-9]+/) || [])[0];
const ACC = (raw.match(/id[:：]\s*([0-9a-f]{32})/) || [])[1];
if (!TOKEN || !ACC) throw new Error('apitoken.txt 里没找到 token / account id');

const SCRIPT = 'github-rank';
const code = fs.readFileSync('worker.js', 'utf8');
const meta = {
  main_module: 'worker.js',
  compatibility_date: '2026-01-01',
  // 线上变量：每次部署都带上，否则会被清空（2026-11-25 踩过：REPO_OWNER/REPO_NAME 丢失导致 503）
  bindings: [
    { type: 'plain_text', name: 'REPO_OWNER', text: 'xiaoh2018' },
    { type: 'plain_text', name: 'REPO_NAME', text: 'github-rank' },
  ],
};

if (process.argv.includes('--dry')) {
  console.log('dry run: worker.js ' + code.length + ' chars, account ' + ACC.slice(0, 6) + '…');
  process.exit(0);
}

const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata');
form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACC}/workers/scripts/${SCRIPT}`,
  { method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body: form }
);
const json = await res.json();
if (!json.success) {
  console.error('deploy failed:', JSON.stringify(json.errors || json).slice(0, 600));
  process.exit(1);
}
console.log('deployed ' + SCRIPT + ' modified_on=' + (json.result && json.result.modified_on));

// 确认路由
const routes = await (
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/workers/scripts/${SCRIPT}/routes`, {
    headers: { authorization: 'Bearer ' + TOKEN },
  })
).json();
console.log('routes:', routes.success ? JSON.stringify(routes.result) : 'n/a');
