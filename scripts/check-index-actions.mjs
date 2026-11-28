// 收录记录里的「动作」：推 IndexNow（单条）、加到批量框、重查
// 用法：node scripts/check-index-actions.mjs   （PROBE_BASE=线上地址 时只跑只读部分）
import { openCdp } from './lib/cdp.mjs';

const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const REMOTE = !!process.env.PROBE_BASE;
const PW = process.env.ADMIN_PW || 'dev';
const rows = [];
const ok = (name, pass, extra = '') => rows.push({ name, ok: !!pass, extra: String(extra).slice(0, 160) });
const post = (p, body) =>
  fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

// ---------- 接口 ----------
{
  const r = await post('/api/index-push', {});
  ok('不带密码推 → 403', r.status === 403, 'HTTP ' + r.status);

  const r2 = await post('/api/index-push', { password: 'wrong-pw', url: '/' });
  ok('密码错 → 403', r2.status === 403, 'HTTP ' + r2.status);
}

// 线上没有后台口令（ADMIN_PW 是 Cloudflare 环境变量），需要口令的断言只在本地跑
if (REMOTE) {
  for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
  const bad = rows.filter((r) => !r.ok).length;
  console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  [线上只验「必须带口令」]' : bad + ' FAILED of ' + rows.length);
  process.exit(bad === 0 ? 0 : 1);
}

{
  const r3 = await post('/api/index-push', { password: PW, url: '' });
  ok('不给地址 → 400 并说清', r3.status === 400 && /要推哪一条/.test((r3.json && r3.json.error) || ''), (r3.json && r3.json.error) || '');

  const r4 = await post('/api/index-push', { password: PW, url: 'https://example.com/x' });
  ok('别站地址 → 400（只能推本站）', r4.status === 400 && /只能推本站/.test((r4.json && r4.json.error) || ''), (r4.json && r4.json.error) || '');

  const r5 = await post('/api/index-push', { password: PW, url: '/articles', dry: true });
  const j5 = r5.json || {};
  ok('演练模式返回 host / key / keyLocation', j5.ok === true && j5.dry === true && !!j5.host && !!j5.key && !!j5.keyLocation, JSON.stringify(j5).slice(0, 120));
  ok('演练模式的 keyLocation 指向 /<key>.txt', typeof j5.keyLocation === 'string' && j5.keyLocation.endsWith('/' + j5.key + '.txt'), j5.keyLocation);
  ok('演练模式把相对地址补成绝对地址', /^https?:\/\/[^/]+\/articles$/.test(j5.url || ''), j5.url);
  ok('演练模式真的没发请求（status=0 / ms=0）', j5.status === 0 && j5.ms === 0 && /演练/.test(j5.note || ''), j5.note);
}

// ---------- 造两条记录，再在后台点按钮 ----------
await post('/api/index-log', { password: PW, action: 'clear' });
await post('/api/index-check', { password: PW, url: '/articles' });
await post('/api/index-check', { password: PW, url: '/nope-acts-404' });

const cdp = await openCdp({ width: 1440, height: 900 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.js(`sessionStorage.setItem('adminPw', ${JSON.stringify(PW)})`);
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2600));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="submit"]');if(n)n.click();return 1})()`);
  await new Promise((r) => setTimeout(r, 600));
  const opened = await cdp.js(`(function(){
    var w = document.getElementById('ickLogWrap');
    if (!w) return 'no-wrap';
    w.open = true;
    w.dispatchEvent(new Event('toggle'));
    return 'ok';
  })()`);
  ok('记录块能展开', opened === 'ok', opened);
  await new Promise((r) => setTimeout(r, 1500));

  const head = await cdp.js(`(function(){
    var b = document.getElementById('ickLogBox');
    if (!b) return '';
    var ths = b.querySelectorAll('tr:first-child th');
    return Array.prototype.map.call(ths, function (t) { return t.textContent; }).join('|');
  })()`);
  ok('记录表多了「动作」列', /动作/.test(head), head);

  const buckets = await cdp.js(`(function(){
    var b = document.getElementById('ickLogBox');
    if (!b) return null;
    var out = { push: 0, sm: 0, re: 0, rows: 0, pushOn404: 0, smPaths: [] };
    Array.prototype.forEach.call(b.querySelectorAll('tr'), function (tr) {
      var cells = tr.querySelectorAll('td');
      if (!cells.length) return;
      out.rows++;
      var path = cells[1].textContent;
      var status = cells[2].textContent;
      var push = tr.querySelector('[data-ickpush]');
      var sm = tr.querySelector('[data-icksm]');
      var re = tr.querySelector('[data-ickre]');
      if (push) out.push++;
      if (sm) { out.sm++; out.smPaths.push(path); }
      if (re) out.re++;
      if (push && /^404/.test(status)) out.pushOn404++;
    });
    return out;
  })()`);
  ok('有记录行可看', buckets && buckets.rows >= 2, JSON.stringify(buckets));
  ok('200 的行有「推 IndexNow」', buckets && buckets.push >= 1, JSON.stringify(buckets && buckets.push));
  ok('404 的行不给「推 IndexNow」', buckets && buckets.pushOn404 === 0, JSON.stringify(buckets && buckets.pushOn404));
  ok('每行都有「重查」', buckets && buckets.re === buckets.rows, JSON.stringify(buckets && { re: buckets.re, rows: buckets.rows }));
  ok('不在 sitemap 的行有「加到批量框」', buckets && buckets.sm >= 1 && buckets.smPaths.join(',').indexOf('/nope-acts-404') >= 0, JSON.stringify(buckets && buckets.smPaths));

  // 点「加到批量框」
  const addRes = await cdp.js(`(function(){
    var b = document.getElementById('ickLogBox');
    var btn = b ? b.querySelector('[data-icksm]') : null;
    if (!btn) return 'no-btn';
    var path = btn.getAttribute('data-icksm');
    btn.click();
    var ta = document.getElementById('ickBatch');
    var msg = document.getElementById('ickActMsg');
    return JSON.stringify({ path: path, value: ta ? ta.value : '', msg: msg ? msg.textContent : '' });
  })()`);
  const addObj = JSON.parse(String(addRes));
  ok('点「加到批量框」把地址填进批量框', addObj.value.indexOf(addObj.path) >= 0, addObj.value.slice(0, 80));
  ok('点完给出人话提示', /批量框/.test(addObj.msg || ''), addObj.msg);

  // 390：动作列不把整页撑出横向滚动
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise((r) => setTimeout(r, 800));
  const wide = await cdp.js(`(function(){
    return JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth });
  })()`);
  const w = JSON.parse(wide);
  ok('390 下整页不横向溢出', w.sw <= w.cw + 1, wide);
} finally {
  await cdp.close();
}

for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
const bad = rows.filter((r) => !r.ok).length;
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);