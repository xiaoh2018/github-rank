import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const PW = process.env.ADMIN_PW || 'dev';
const SITE = 'https://github.661026.xyz';

const rows = [];
const push = (label, ok, detail) => {
  rows.push({ label, ok, detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail !== undefined && detail !== '' ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
};

if (REMOTE) {
  const r = await fetch(BASE + '/admin');
  const t = await r.text();
  push('推送也留痕（后台有「推送 · 」标注）', t.includes("e.kind === 'push'"), '');
  const ones = rows.filter((x) => !x.ok);
  console.log('\n' + (ones.length ? 'FAILED ' + ones.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE + ' (REMOTE)');
  process.exit(ones.length ? 1 : 0);
}

const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, j };
};

let r = await post('/api/index-log', { password: PW, action: 'clear' });
push('清空记录', r.status === 200 && r.j && r.j.total === 0, r.j && r.j.total);

r = await post('/api/index-push', { password: PW, url: SITE + '/articles' });
const st = (r.j && r.j.status) || 0;
push('真推一次 IndexNow（会真的发一个请求）', r.status === 200 || r.status === 502, { http: r.status, status: st });

r = await post('/api/index-log', { password: PW });
const list = (r.j && r.j.entries) || [];
const e = list[0] || {};
push('记录里多了一条', list.length === 1, list.length);
push('它标成推送（kind=push）', e.kind === 'push', e.kind);
push('路径认得出来', e.path === '/articles', e.path);
push('状态跟接口返回一致', Number(e.status) === Number(st), { logged: e.status, response: st });
push('首次没有对照（deltaSitemap=null）', e.deltaSitemap === null, e.deltaSitemap);
push('推送不算进「今天查了」（摘要只数查询）', r.j && r.j.summary && r.j.summary.today === 0, r.j && r.j.summary && r.j.summary.today);

const cdp = await openCdp({ width: 1440, height: 900 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((x) => setTimeout(x, 1400));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((x) => setTimeout(x, 2500));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="submit"]'); if(n) n.click(); return 1})()`);
  await new Promise((x) => setTimeout(x, 400));
  await cdp.js(`(function(){var w=document.getElementById('ickLogWrap'); w.open=true; w.dispatchEvent(new Event('toggle')); return 1})()`);
  await new Promise((x) => setTimeout(x, 1500));
  const txt = await cdp.js("(function(){var b=document.getElementById('ickLogBox');return b?b.textContent:''})()");
  push('表格里写着「推送 · 」', String(txt).includes('推送 · '), String(txt).slice(0, 80));
  const ov = await cdp.js('({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})');
  push('300 以上不出横向溢出', ov.sw <= ov.cw + 1, ov);
} finally {
  await cdp.close();
  await post('/api/index-log', { password: PW, action: 'clear' });
}

const bad = rows.filter((x) => !x.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + ' of ' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE);
process.exit(bad.length ? 1 : 0);