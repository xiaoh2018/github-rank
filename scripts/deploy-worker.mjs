// 用 Cloudflare API 直接部署 worker.js（不用 wrangler：不受 github.com 网络影响，
// 而且能显式带上全部变量/绑定——wrangler 或 API 部署都会「整体替换」绑定，
// 少写一个变量就把线上清空，2026-11-25 踩过一次 REPO_OWNER/REPO_NAME 丢失导致全站 503）。
//
// 用法：
//   node scripts/deploy-worker.mjs          # 本地：读 apitoken.txt
//   node scripts/deploy-worker.mjs --dry    # 只看要不要发，不发
//   CF_TOKEN=xxx CF_ACCOUNT=yyy node scripts/deploy-worker.mjs   # CI：从环境变量取
import fs from 'node:fs';

function readTokenFile() {
  try {
    const raw = fs.readFileSync('apitoken.txt', 'utf8');
    return {
      token: (raw.match(/cf[a-z]{1,4}_[A-Za-z0-9_-]{20,}/) || [])[0] || '',
      account: (raw.match(/id[:：]\s*([0-9a-f]{32})/) || [])[1] || '',
    };
  } catch (e) {
    return { token: '', account: '' };
  }
}

const file = readTokenFile();
const TOKEN = process.env.CF_TOKEN || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || file.token;
const ACC = process.env.CF_ACCOUNT || process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || file.account;
if (!TOKEN || !ACC) {
  console.error('没找到 Cloudflare 凭据：设置 CF_TOKEN / CF_ACCOUNT 环境变量，或把 token 与 account id 写进 apitoken.txt');
  process.exit(1);
}

const SCRIPT = process.env.CF_SCRIPT || 'github-rank';
const OWNER = process.env.REPO_OWNER || 'xiaoh2018';
const REPO = process.env.REPO_NAME || 'github-rank';
const code = fs.readFileSync('worker.js', 'utf8');

const meta = {
  main_module: 'worker.js',
  compatibility_date: '2026-01-01',
  // 每次部署都必须带全：Cloudflare 用这里的内容整体替换绑定，不是合并。
  bindings: [
    { type: 'ai', name: 'AI' },
    { type: 'plain_text', name: 'REPO_OWNER', text: OWNER },
    { type: 'plain_text', name: 'REPO_NAME', text: REPO },
  ],
};

if (process.argv.includes('--dry')) {
  console.log('dry run: worker.js ' + code.length + ' chars, account ' + ACC.slice(0, 6) + '…, bindings ' + meta.bindings.map((b) => b.name).join(','));
  process.exit(0);
}

const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata');
form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACC}/workers/scripts/${SCRIPT}`,
  { method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body: form }
);
const out = await res.json();
if (!out.success) {
  console.error('deploy failed:', JSON.stringify(out.errors || out).slice(0, 900));
  process.exit(1);
}
console.log('deployed ' + SCRIPT + ' modified_on=' + (out.result && out.result.modified_on));

const routes = await (
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/workers/scripts/${SCRIPT}/routes`, {
    headers: { authorization: 'Bearer ' + TOKEN },
  })
).json();
console.log('routes:', routes.success ? JSON.stringify(routes.result) : 'n/a');

// 部署后自检：变量是否真的生效（防止又被清空）
const probe = await fetch(`https://${(process.env.SITE_HOST || 'github.661026.xyz')}/api/status?deploycheck=${Date.now()}`, {
  headers: { 'cache-control': 'no-cache' },
}).then((r) => r.json()).catch(() => null);
if (probe) {
  console.log('post-deploy: configured=' + probe.configured + ' ai=' + !!(probe.translator && probe.translator.ai));
  if (!probe.configured) {
    console.error('部署后 configured=false —— 变量又没生效，检查 bindings');
    process.exit(2);
  }
}
