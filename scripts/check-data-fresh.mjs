// 门禁：本地 data/ 不能落后于远端（落后会骗截图、骗本地门禁），且远端数据必须新鲜
import fs from 'node:fs';

const REPO = 'xiaoh2018/github-rank';
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const metaOf = (txt) => {
  const m = String(txt || '').match(/generatedAt:\s*"([^"]+)"/);
  return m ? m[1] : '';
};
const hours = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 3600000 : NaN);
const h1 = (n) => (Number.isFinite(n) ? n.toFixed(1) + ' 小时' : '未知');

const localPath = 'data/repos-meta.js';
push('本地有 data/repos-meta.js', fs.existsSync(localPath));
const localMeta = fs.existsSync(localPath) ? metaOf(fs.readFileSync(localPath, 'utf8')) : '';
push('本地 meta 带 generatedAt', !!localMeta, localMeta);

let remoteMeta = '';
let remoteErr = '';
try {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/data/repos-meta.js?cb=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) remoteErr = 'HTTP ' + r.status;
  else remoteMeta = metaOf(await r.text());
} catch (e) {
  remoteErr = e.message;
}
push('远端 raw 可达且带 generatedAt', !!remoteMeta, remoteErr || remoteMeta);

if (localMeta && remoteMeta) {
  const lag = (Date.parse(remoteMeta) - Date.parse(localMeta)) / 3600000;
  push('本地数据不落后远端超过 3 小时（落后就 node scripts/sync-data.mjs）', lag <= 3,
    '本地落后 ' + h1(lag) + '（本地 ' + localMeta + ' / 远端 ' + remoteMeta + '）');
}
push('远端数据是新的（3 小时抓取链路还活着）', hours(remoteMeta) <= 6, '距今 ' + h1(hours(remoteMeta)));

const bad = rows.filter((r) => !r.ok).length;
for (const r of rows) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.extra ? '  → ' + r.extra : ''));
console.log(bad ? `${bad} FAILED of ${rows.length}` : `ALL OK (${rows.length})`);
process.exit(bad ? 1 : 0);