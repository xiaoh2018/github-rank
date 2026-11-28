import fs from 'node:fs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => {
  rows.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

const getText = async (p) => (await (await fetch(BASE + p)).text());

const status = await (await fetch(BASE + '/api/status')).json().catch(() => ({}));
const health = await (await fetch(BASE + '/api/health')).json().catch(() => ({}));
const home = await getText('/');
const admin = await getText('/admin');

const vStatus = (status && (status.version || (status.status && status.status.version))) || '';
const vHealth = (health && health.version) || '';
const vHome = (/bundle\.js\?v=([A-Za-z0-9._-]+)/.exec(home) || [])[1] || '';
const vAdmin = (/md\.js\?v=([A-Za-z0-9._-]+)/.exec(admin) || [])[1] || '';

push('/api/status 有 version 字段', /^v\d+$/.test(vStatus), vStatus || '(无)');
push('/api/health 的 version 与之一致', vHealth === vStatus, { health: vHealth, status: vStatus });
push('首页 bundle 地址里的版本一致', vHome === vStatus, { home: vHome, status: vStatus });
push('后台 md.js 的版本一致', vAdmin === vStatus, { admin: vAdmin, status: vStatus });

if (!REMOTE) {
  const src = fs.readFileSync('worker.js', 'utf8');
  const vSrc = (/const ASSET_V = '([^']+)'/.exec(src) || [])[1] || '';
  push('源码里的 ASSET_V 一致（发版脚本没漏改）', vSrc === vStatus, { src: vSrc, status: vStatus });
  const adm = admin.includes("healthRow('Worker 版本'");
  push('后台有「资源版本」一致性一行', admin.includes("'资源版本'") && admin.includes('强刷一下'), '');
  push('后台「站点体检」把它显示出来', adm, '');
}

const bad = rows.filter((x) => !x.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + ' of ' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE + (REMOTE ? ' (REMOTE)' : ''));
process.exit(bad.length ? 1 : 0);