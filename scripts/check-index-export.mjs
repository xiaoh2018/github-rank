// 收录记录要能导出：把「挂着的地址」复制走 / 存成 CSV，空记录时给「先查一次」的入口。
import { openCdp } from './lib/cdp.mjs';

const REMOTE = process.env.PROBE_BASE || '';
const BASE = REMOTE || 'http://127.0.0.1:8123';
const PW = process.env.ADMIN_PW || 'dev';
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail });

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { j = { raw: t }; }
  return { status: r.status, json: j };
};

if (REMOTE) {
  const html = await (await fetch(BASE + '/admin')).text();
  push('后台有「复制挂着的地址」按钮', html.includes('id="ickLogCopy"'), '');
  push('后台有「下载 CSV」按钮', html.includes('id="ickLogCsv"'), '');
  push('后台导出了 __ickBadUrls / __ickCsv', html.includes('__ickBadUrls') && html.includes('__ickCsv'), '');
  push('空记录时有「先查一次首页」入口', html.includes('data-ickfirst'), '');
  const f0 = rows.filter((r) => !r.ok);
  for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label);
  if (f0.length) { console.log('\n' + f0.length + ' FAILED of ' + rows.length); process.exit(1); }
  console.log('\nALL OK (' + rows.length + ')  @' + BASE + ' (REMOTE)');
  process.exit(0);
}

// 接口：先清空，再造一条坏的
let r = await post('/api/index-log', { password: PW, action: 'clear' });
push('清空记录', r.status === 200 && r.json && r.json.total === 0, JSON.stringify(r.json && r.json.total));

r = await post('/api/index-check', { password: PW, url: BASE + '/nope-export-404' });
push('查一条 404（写进记录）', r.status === 200 && r.json && r.json.status === 404, JSON.stringify(r.json && r.json.status));

r = await post('/api/index-log', { password: PW });
const entries = (r.json && r.json.entries) || [];
push('记录里有这条 404', entries.some((e) => e.path === '/nope-export-404'), 'n=' + entries.length);
const open = ((r.json && r.json.summary && r.json.summary.openIssues) || []).map((o) => o.path);
push('summary 把它算成「挂着」', open.includes('/nope-export-404'), JSON.stringify(open).slice(0, 80));

const cdp = await openCdp({ width: 1440, height: 900 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((res) => setTimeout(res, 1400));
  await cdp.js("sessionStorage.setItem('adminPw','" + PW + "')");
  await cdp.js('location.reload()');
  await new Promise((res) => setTimeout(res, 2500));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="submit"]'); if(n) n.click(); return 1})()`);
  await new Promise((res) => setTimeout(res, 600));
  const opened = await cdp.js(`(function(){
    var w=document.getElementById('ickLogWrap'); if(w){ w.open=true; w.dispatchEvent(new Event('toggle')); }
    return {copy: !!document.getElementById('ickLogCopy'), csv: !!document.getElementById('ickLogCsv')};
  })()`);
  push('两个导出按钮都在', opened.copy && opened.csv, JSON.stringify(opened));

  // 等 loadIckLog 把数据画出来
  let got = null;
  for (let i = 0; i < 20; i++) {
    got = await cdp.js('window.__ickRows ? window.__ickRows.length : -1');
    if (got > 0) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  push('面板拿到记录（__ickRows）', got > 0, 'rows=' + got);

  const bad = await cdp.js('window.__ickBadUrls()');
  const badTxt = Array.isArray(bad) ? bad.join(' ') : String(bad);
  push('__ickBadUrls 只给挂着的、且是绝对地址', badTxt.includes('/nope-export-404') && badTxt.includes(BASE), badTxt.slice(0, 120));

  const csv = await cdp.js('window.__ickCsv()');
  const lines = String(csv).split('\r\n');
  push('CSV 有 BOM（Excel 打开中文不乱码）', String(csv).charCodeAt(0) === 0xfeff, 'first=' + String(csv).charCodeAt(0));
  push('CSV 表头 8 列', lines[0].replace(/^\ufeff/, '').split(',').length === 8, lines[0].slice(0, 60));
  push('CSV 里有那条 404', String(csv).includes('/nope-export-404'), '');

  await cdp.js("document.getElementById('ickLogCsv').click()");
  await new Promise((res) => setTimeout(res, 400));
  const msg1 = await cdp.js("(document.getElementById('ickActMsg')||{}).textContent || ''");
  push('下载后给反馈', /已下载 CSV/.test(msg1), msg1);

  await cdp.js("document.getElementById('ickLogCopy').click()");
  await new Promise((res) => setTimeout(res, 500));
  const msg2 = await cdp.js("(document.getElementById('ickActMsg')||{}).textContent || ''");
  push('复制后给反馈（几条）', /已复制 \d+ 条地址/.test(msg2), msg2);

  // 空态 + 「先查一次首页」
  await post('/api/index-log', { password: PW, action: 'clear' });
  await cdp.js('window.__loadIckLog()');
  await new Promise((res) => setTimeout(res, 800));
  const emptyTxt = await cdp.js("(document.getElementById('ickLogBox')||{}).textContent || ''");
  push('清空后是空态文案', /还没有查询记录/.test(emptyTxt), emptyTxt.slice(0, 40));
  const hasFirst = await cdp.js("!!document.querySelector('[data-ickfirst]')");
  push('空态有「先查一次首页」按钮', hasFirst, '');
  if (hasFirst) {
    await cdp.js("document.querySelector('[data-ickfirst]').click()");
    await new Promise((res) => setTimeout(res, 1800));
    const after = await post('/api/index-log', { password: PW });
    const n2 = (after.json && after.json.entries) || [];
    push('点它会真的查一次并留下记录', n2.length >= 1 && n2.some((e) => e.path === '/'), 'n=' + n2.length);
  } else {
    push('点它会真的查一次并留下记录', false, 'no button');
  }

  const ov = await cdp.js('JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})');
  const o = JSON.parse(ov);
  push('1440 下不横向溢出', o.sw <= o.cw + 1, ov);
} finally {
  await cdp.close();
  await post('/api/index-log', { password: PW, action: 'clear' });
}

const failed = rows.filter((x) => !x.ok);
for (const x of rows) console.log((x.ok ? 'OK   ' : 'FAIL ') + x.label + (x.detail ? '  → ' + x.detail : ''));
if (failed.length) {
  console.log('\n' + failed.length + ' FAILED of ' + rows.length);
  process.exit(1);
}
console.log('\nALL OK (' + rows.length + ')  @' + BASE);