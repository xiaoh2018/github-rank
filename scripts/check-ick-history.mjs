import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const PW = 'dev';
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const adm = await (await fetch(BASE + '/admin')).text();
  push('后台有「每条路径的历史」计算', adm.includes('ickPathHistory') && adm.includes('共记 '));
  push('历史里含「连续 N 次有问题」的判断', adm.includes('现在连续 ') && adm.includes('最近一次是好的'));
  finish();
}

const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ password: PW }, b)) })).json();
await post('/api/index-log', { action: 'clear' });
await post('/api/index-check', { url: BASE + '/articles' });
await post('/api/index-check', { url: BASE + '/nope-hist-404' });
await post('/api/index-check', { url: BASE + '/nope-hist-404' });
await post('/api/index-check', { url: BASE + '/articles' });

const cdp = await openCdp({ width: 1440, height: 1000 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1400));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2800));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="submit"]');if(n)n.click();return 1})()`);
  await new Promise((r) => setTimeout(r, 500));
  await cdp.js(`(function(){var w=document.getElementById('ickLogWrap');if(w&&!w.open){w.open=true;w.dispatchEvent(new Event('toggle'));}return 1})()`);
  await new Promise((r) => setTimeout(r, 1600));

  const map = await cdp.js(`(function(){
    var out = {};
    var btns = [].slice.call(document.querySelectorAll('#ickLogBox [data-ickdetail]'));
    btns.forEach(function (b) {
      var tr = b.closest('tr');
      var p = tr ? (tr.querySelectorAll('td')[1] || {}).textContent : '';
      b.click();
      var drow = document.getElementById('ickDet' + b.getAttribute('data-ickdetail'));
      var hist = drow ? (drow.querySelector('.ick-hist') || {}).textContent : '';
      out[String(p).trim()] = hist || '';
      b.click();
    });
    return out;
  })()`);

  const bad = Object.keys(map).find((k) => k.indexOf('nope-hist-404') >= 0);
  const good = Object.keys(map).find((k) => k === '/articles');
  push('坏路径的详情里带历史', !!bad && /历史：共记 2 次/.test(map[bad] || ''), bad ? map[bad] : 'no-row');
  push('坏路径写明「出问题 2 次」且「连续 2 次有问题」', !!bad && /出问题 2 次/.test(map[bad] || '') && /连续 2 次有问题/.test(map[bad] || ''), bad ? map[bad] : '');
  push('好路径写明「出问题 0 次」与「最近一次是好的」', !!good && /出问题 0 次/.test(map[good] || '') && /最近一次是好的/.test(map[good] || ''), good ? map[good] : '');
  push('历史里给出「最近三次」的时间线', !!good && /最近三次：/.test(map[good] || ''), good ? map[good] : '');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 300));
  const w2 = await cdp.js(`({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})`);
  push('390 下不横向溢出', w2.sw <= w2.cw + 1, JSON.stringify(w2));
} finally {
  await cdp.close();
}
finish();

function finish() {
  let bad = 0;
  for (const r of rows) {
    if (!r.ok) bad++;
    console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '  → ' + r.detail : ''));
  }
  console.log('');
  console.log(bad ? bad + ' FAILED of ' + rows.length : 'ALL OK (' + rows.length + ')  @' + BASE + (REMOTE ? ' (REMOTE)' : ''));
  process.exit(bad ? 1 : 0);
}