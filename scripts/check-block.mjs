import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const home = await (await fetch(BASE + '/')).text();
  const bundle = await (await fetch(BASE + '/js/bundle.js?v=' + (await (await fetch(BASE + '/api/status')).json()).version)).text();
  push('首页有「不感兴趣」按钮与屏蔽条逻辑', bundle.includes('不感兴趣') && bundle.includes('blockBar') && bundle.includes('ghrank:blocked'));
  push('屏蔽条带「恢复全部」', bundle.includes('恢复全部'));
  finish();
}

const cdp = await openCdp({ width: 1440, height: 950 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await new Promise((r) => setTimeout(r, 3500));

  const first = await cdp.js(`(function(){var a=document.querySelector('#list .item .title, #list .item h3 a, #list .item a.name'); return a? a.textContent.trim() : ''})()`);
  const n0 = await cdp.js(`document.querySelectorAll('#list .item').length`);
  push('首页有项目卡片', n0 > 3 && !!first, n0 + ' | ' + first);

  const btnText = await cdp.js(`(function(){var b=document.querySelector('#list .item [aria-label^="不再显示"]'); return b? b.textContent : ''})()`);
  push('每张卡都有「不感兴趣」按钮', btnText === '不感兴趣', btnText);

  await cdp.js(`(function(){document.querySelector('#list .item [aria-label^="不再显示"]').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 800));

  const after = await cdp.js(`(function(){
    var bar=document.getElementById('blockBar');
    var still=[].some.call(document.querySelectorAll('#list .item .title, #list .item h3 a, #list .item a.name'), function(a){return a.textContent.trim()=== ${JSON.stringify(first)}});
    return {bar: bar? bar.textContent : '', still: still};
  })()`);
  push('点了之后那张卡从列表消失', after.still === false, JSON.stringify(after));
  push('顶部出现「已屏蔽 1 个项目」', /已屏蔽 1 个项目/.test(after.bar || ''), after.bar);

  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 3500));
  const kept = await cdp.js(`(function(){
    var bar=document.getElementById('blockBar');
    var still=[].some.call(document.querySelectorAll('#list .item .title, #list .item h3 a, #list .item a.name'), function(a){return a.textContent.trim()=== ${JSON.stringify(first)}});
    return {bar: bar? bar.textContent : '', still: still};
  })()`);
  push('刷新后仍然屏蔽（本地保存）', kept.still === false && /已屏蔽 1 个项目/.test(kept.bar || ''), JSON.stringify(kept));

  await cdp.js(`(function(){document.getElementById('blockRestore').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 900));
  const back = await cdp.js(`(function(){
    var bar=document.getElementById('blockBar');
    var still=[].some.call(document.querySelectorAll('#list .item .title, #list .item h3 a, #list .item a.name'), function(a){return a.textContent.trim()=== ${JSON.stringify(first)}});
    return {bar: !!bar, still: still};
  })()`);
  push('「恢复全部」把项目放回来', back.still === true, JSON.stringify(back));
  push('恢复后屏蔽条消失', back.bar === false, back.bar);

  await cdp.js(`(function(){document.querySelector('#list .item [aria-label^="不再显示"]').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 600));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 500));
  const w = await cdp.js(`({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, bar: (document.getElementById('blockBar')||{}).textContent || ''})`);
  const mb = await cdp.js(`(function(){var b=document.querySelector('#list .item .mini.mblock'); if(!b) return null; var cs=getComputedStyle(b); return {display: cs.display, h: Math.round(b.getBoundingClientRect().height)}})()`);
  push('390 下「不感兴趣」仍然可用（32px 高）', !!mb && mb.display !== 'none' && mb.h >= 32, JSON.stringify(mb));
  push('390 下屏蔽条不撑破页面', w.sw <= w.cw + 1, JSON.stringify(w));
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