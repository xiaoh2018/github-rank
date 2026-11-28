import { openCdp } from './lib/cdp.mjs';

const REMOTE = !!process.env.PROBE_BASE;
const base = REMOTE ? process.env.PROBE_BASE.replace(/\/+$/, '') : 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PW || 'dev';
const rows = [];
function ok(name, cond, extra) {
  rows.push({ name, ok: !!cond, extra: extra === undefined ? '' : String(extra) });
}
async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ---------- 接口 ----------
{
  const r = await fetch(base + '/api/index-cron');
  const j = await r.json().catch(() => null);
  ok('不带令牌调定时接口 → 400/403', r.status === 400 || r.status === 403, 'HTTP ' + r.status + ' ' + ((j && j.error) || ''));
}

if (REMOTE) {
  for (const x of rows) console.log((x.ok ? 'OK   ' : 'FAIL ') + x.name + (x.extra ? '  [' + x.extra + ']' : ''));
  const bad = rows.filter((x) => !x.ok).length;
  console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  [线上只验必须带令牌]' : bad + ' FAILED of ' + rows.length);
  process.exit(bad === 0 ? 0 : 1);
}

{
  const r = await post('/api/index-cron', { password: PW });
  const j = r.json || {};
  ok('带口令能跑（200）', r.status === 200 && j.ok === true, 'HTTP ' + r.status);
  ok('至少查了 1 条', Number(j.checked) >= 1, j.checked);
  ok('每条结果都有 path 与 status', Array.isArray(j.items) && j.items.every((x) => typeof x.path === 'string' && (x.error || typeof x.status === 'number')), JSON.stringify((j.items || [])[0]));
  ok('返回里带今天的摘要', !!(j.summary && typeof j.summary.today === 'number'), j.summary && j.summary.today);
}

{
  const r = await post('/api/index-log', { password: PW });
  const j = r.json || {};
  const d = j.daily || [];
  ok('日志里带 7 天趋势', Array.isArray(d) && d.length === 7, d.length);
  ok('趋势每天有 月/日 与 次数', d.every((x) => /^\d{1,2}\/\d{1,2}$/.test(x.label) && typeof x.checks === 'number'), JSON.stringify(d[d.length - 1]));
  ok('最后一天就是今天（查过 ≥1 次）', d.length === 7 && d[6].checks >= 1, d.length === 7 ? d[6].checks : '');
}

// ---------- 后台 UI ----------
const cdp = await openCdp({ width: 1440, height: 900 });
try {
  await cdp.send('Page.navigate', { url: base + '/admin' });
  await new Promise((r) => setTimeout(r, 1600));
  const html = await cdp.js("document.documentElement.outerHTML");
  ok('后台有「定时自查」卡片', html.includes('id="cronWrap"') && html.includes('id="cronSnippet"'), '');
  ok('卡片里写明定时接口', html.includes('/api/index-cron'), '');

  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.send('Page.navigate', { url: base + '/admin' });
  await new Promise((r) => setTimeout(r, 2600));
  await cdp.js("(function(){var n=document.querySelector('.side [data-tab=\"submit\"]');if(n)n.click();return 1})()");
  await new Promise((r) => setTimeout(r, 600));
  const snip = await cdp.js(`(function(){
    var w = document.getElementById('cronWrap');
    if (w) { w.open = true; }
    var p = document.getElementById('cronSnippet');
    return { has: !!w, open: !!(w && w.open), text: p ? String(p.textContent || '') : '' };
  })()`);
  ok('展开后能看到配置片段', snip.has === true && snip.open === true && snip.text.length > 40, snip.text.length);
  ok('片段里有 schedule 与 cron 表达式', /schedule/.test(snip.text) && /cron:\s*0 1 \* \* \*/.test(snip.text), '');
  ok('片段里的地址是本站', snip.text.indexOf(base) >= 0, base);

  const clicked = await cdp.js(`(function(){
    var b = document.getElementById('cronRun');
    if (b) b.click();
    return !!b;
  })()`);
  await new Promise((r) => setTimeout(r, 3500));
  const msg = await cdp.js("(function(){var m=document.getElementById('cronMsg');return m?String(m.textContent||''):''})()");
  ok('点「现在跑一次」有结果反馈', clicked === true && /跑了|没跑成/.test(msg), msg.slice(0, 60));
} finally {
  await cdp.close();
}

for (const x of rows) console.log((x.ok ? 'OK   ' : 'FAIL ') + x.name + (x.extra ? '  [' + x.extra + ']' : ''));
const bad = rows.filter((x) => !x.ok).length;
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);