import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => {
  rows.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

if (REMOTE) {
  const adm = await (await fetch(BASE + '/admin')).text();
  push('后台有「详情」按钮与说明文案', adm.includes('ickDetailText') && adm.includes("data-ickdetail") && adm.includes('完整地址'), '');
  push('详情行有样式（窄屏也能看）', adm.includes('tr.ick-det td'), '');
  const bad0 = rows.filter((x) => !x.ok);
  console.log('\n' + (bad0.length ? 'FAILED ' + bad0.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE + ' (REMOTE)');
  process.exit(bad0.length ? 1 : 0);
}

const PW = 'dev';
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
await post('/api/index-log', { password: PW, action: 'clear' });
await post('/api/index-check', { password: PW, url: BASE + '/nope-det-404' });
await post('/api/index-check', { password: PW, url: BASE + '/articles' });

const cdp = await openCdp({ width: 1440, height: 900 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1400));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2600));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="submit"]'); if(n) n.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 400));
  await cdp.js(`(function(){var w=document.getElementById('ickLogWrap'); if(w&&!w.open){w.open=true; w.dispatchEvent(new Event('toggle'));} return 1})()`);
  await new Promise((r) => setTimeout(r, 1500));

  const before = await cdp.js(`(function(){
    var b=document.querySelector('#ickLogBox [data-ickdetail]');
    var d=b?document.getElementById('ickDet'+b.getAttribute('data-ickdetail')):null;
    return {btn:b?b.textContent:'none', exp:b?b.getAttribute('aria-expanded'):'none', hidden:d?d.hidden:null};
  })()`);
  push('每行有「详情」按钮、默认收起', before.btn === '详情' && before.exp === 'false' && before.hidden === true, before);

  await cdp.js(`(function(){document.querySelector('#ickLogBox [data-ickdetail]').click();return 1})()`);
  await new Promise((r) => setTimeout(r, 300));
  const after = await cdp.js(`(function(){
    var b=document.querySelector('#ickLogBox [data-ickdetail]');
    var d=document.getElementById('ickDet'+b.getAttribute('data-ickdetail'));
    var t=d?d.textContent:'';
    return {btn:b.textContent, exp:b.getAttribute('aria-expanded'), hidden:d.hidden, text:t.slice(0,220),
      has:['完整地址','状态码','noindex','canonical','sitemap','上次提交','记录时间'].filter(function(k){return t.indexOf(k)>=0}).length};
  })()`);
  push('点开显示七项事实', after.hidden === false && after.has === 7, after.has + ' 项');
  push('按钮变「收起」且 aria-expanded=true', after.btn === '收起' && after.exp === 'true', after);
  push('文案里带完整地址（可复制去打开）', /完整地址：https?:\/\//.test(after.text), after.text.slice(0, 60));

  await cdp.js(`(function(){document.querySelector('#ickLogBox [data-ickdetail]').click();return 1})()`);
  await new Promise((r) => setTimeout(r, 250));
  const closed = await cdp.js(`(function(){
    var b=document.querySelector('#ickLogBox [data-ickdetail]');
    var d=document.getElementById('ickDet'+b.getAttribute('data-ickdetail'));
    return {btn:b.textContent, hidden:d.hidden};
  })()`);
  push('再点一下收起', closed.hidden === true && closed.btn === '详情', closed);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1300));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2400));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="submit"]'); if(n) n.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 300));
  await cdp.js(`(function(){var w=document.getElementById('ickLogWrap'); if(w&&!w.open){w.open=true; w.dispatchEvent(new Event('toggle'));} return 1})()`);
  await new Promise((r) => setTimeout(r, 1200));
  const m390 = await cdp.js(`(function(){
    document.querySelector('#ickLogBox [data-ickdetail]').click();
    var d=document.querySelector('#ickLogBox tr.ick-det');
    var r=d.getBoundingClientRect();
    return {hidden:d.hidden, w:Math.round(r.width), sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth};
  })()`);
  push('390 下详情也能展开且不溢出', m390.hidden === false && m390.sw <= m390.cw + 1, m390);
} finally {
  await cdp.close();
}

const bad = rows.filter((x) => !x.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + ' of ' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE);
process.exit(bad.length ? 1 : 0);