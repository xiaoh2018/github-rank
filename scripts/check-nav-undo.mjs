import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const adm = await (await fetch(BASE + '/admin')).text();
  push('导航删除会提示「已从「分类」移除「站点」」', adm.includes('已从「') && adm.includes('移除「'));
  push('撤销把站点插回原分组原位置', adm.includes('navState.groups[g].items.splice(i, 0, nItem)'));
  finish();
}

const cdp = await openCdp({ width: 1440, height: 950 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1400));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2800));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="nav"]'); if(n) n.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 1200));

  const names = () => cdp.js(`Array.prototype.map.call(document.querySelectorAll('#navAdmin [data-idel]'), function(b){ var tr=b.closest('tr'); var i=tr?tr.querySelector('input[data-f="name"]'):null; return i?i.value:''; })`);

  const n0 = await names();
  push('导航面板有若干站点', n0.length >= 2, n0.length + ' 条');

  const first = n0[0];
  await cdp.js(`(function(){document.querySelector('#navAdmin [data-idel]').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 500));
  const n1 = await names();
  push('删除后少一条', n1.length === n0.length - 1, n1.length + '/' + n0.length);

  const bar = await cdp.js(`(function(){var b=document.getElementById('undoBar'); if(!b) return null; return {shown: getComputedStyle(b).display !== 'none', text: b.textContent}})()`);
  push('撤销条出现且写明从哪个分类移除谁', bar && bar.shown && /已从「/.test(bar.text) && /移除「/.test(bar.text), bar ? bar.text : 'null');

  await cdp.js(`(function(){document.getElementById('undoGo').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 600));
  const n2 = await names();
  push('撤销后回到原数量', n2.length === n0.length, n2.length + '/' + n0.length);
  push('撤销后回到原位置（第一条还是原来那条）', n2[0] === first, n2[0]);

  const toast = await cdp.js(`(function(){var t=document.getElementById('toast'); return t? t.textContent : ''})()`);
  push('撤销后提示仍要「保存导航」', /保存导航/.test(toast), toast);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 300));
  const w = await cdp.js(`({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})`);
  push('390 下不横向溢出', w.sw <= w.cw + 1, JSON.stringify(w));
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