import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const html = await (await fetch(BASE + '/')).text();
  const st = await (await fetch(BASE + '/api/status')).json();
  const bundle = await (await fetch(BASE + '/js/bundle.js?v=' + st.version)).text();
  push('首页有三档视图密度按钮', html.includes('data-dens="compact"') && html.includes('data-dens="card"'));
  push('密度样式与本地记忆在位', html.includes('#list[data-dens="compact"]') && bundle.includes("ghrank:dens"));
  finish();
}

const cdp = await openCdp({ width: 1440, height: 950 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await new Promise((r) => setTimeout(r, 3500));
  await cdp.js(`localStorage.removeItem('ghrank:dens'); location.reload()`);
  await new Promise((r) => setTimeout(r, 3500));

  const base = await cdp.js(`(function(){
    var l=document.getElementById('list');
    var it=l.querySelector('.item');
    var d=it? it.querySelector('.desc') : null;
    var pressed=[].find.call(document.querySelectorAll('.dens-b'), function(b){return b.getAttribute('aria-pressed')==='true'});
    return {dens: l.getAttribute('data-dens'), h: it? Math.round(it.getBoundingClientRect().height):0,
            desc: d? getComputedStyle(d).display : 'none', pressed: pressed? pressed.textContent : ''};
  })()`);
  push('默认是「标准」档', base.dens === 'standard' && /标准/.test(base.pressed), JSON.stringify(base));
  push('标准档显示描述', base.desc !== 'none', base.desc);

  await cdp.js(`(function(){var b=[].find.call(document.querySelectorAll('.dens-b'),function(x){return x.getAttribute('data-dens')==='compact'}); b.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 700));
  const compact = await cdp.js(`(function(){
    var l=document.getElementById('list'); var it=l.querySelector('.item'); var d=it.querySelector('.desc');
    return {dens: l.getAttribute('data-dens'), h: Math.round(it.getBoundingClientRect().height), desc: getComputedStyle(d).display,
            pressed: [].find.call(document.querySelectorAll('.dens-b'), function(b){return b.getAttribute('aria-pressed')==='true'}).getAttribute('data-dens')};
  })()`);
  push('切到「紧凑」后 data-dens=compact 且按钮选中', compact.dens === 'compact' && compact.pressed === 'compact', JSON.stringify(compact));
  push('紧凑档隐藏描述', compact.desc === 'none', compact.desc);
  push('紧凑档比标准档矮', compact.h > 0 && compact.h < base.h, base.h + ' → ' + compact.h);

  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 3500));
  const kept = await cdp.js(`(function(){var l=document.getElementById('list');var p=[].find.call(document.querySelectorAll('.dens-b'),function(b){return b.getAttribute('aria-pressed')==='true'});return {dens:l.getAttribute('data-dens'), pressed:p?p.getAttribute('data-dens'):''}})()`);
  push('刷新后仍是紧凑（本地记忆）', kept.dens === 'compact' && kept.pressed === 'compact', JSON.stringify(kept));

  await cdp.js(`(function(){var b=[].find.call(document.querySelectorAll('.dens-b'),function(x){return x.getAttribute('data-dens')==='card'}); b.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 700));
  const card = await cdp.js(`(function(){var l=document.getElementById('list');var it=l.querySelector('.item');return {dens:l.getAttribute('data-dens'), h:Math.round(it.getBoundingClientRect().height)}})()`);
  push('切到「卡片」后比标准档高', card.dens === 'card' && card.h > base.h, base.h + ' → ' + card.h);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 600));
  await cdp.js(`(function(){var t=document.getElementById('mfToggle'); if(t && t.getAttribute('aria-expanded')==='false') t.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 600));
  const m = await cdp.js(`(function(){
    var bs=[].slice.call(document.querySelectorAll('.dens-b'));
    var hs=bs.map(function(b){return Math.round(b.getBoundingClientRect().height)});
    return {n:bs.length, min: Math.min.apply(null, hs), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth};
  })()`);
  push('390 下三档按钮都在且 ≥40px', m.n === 3 && m.min >= 40, JSON.stringify(m));
  push('390 下不横向溢出', m.sw <= m.cw + 1, m.sw + '/' + m.cw);
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