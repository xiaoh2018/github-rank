import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const PW = 'dev';
const rows = [];
const push = (label, ok, detail) => {
  rows.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

if (REMOTE) {
  const adm = await (await fetch(BASE + '/admin')).text();
  push('后台收录记录在窄屏变卡片（有列名伪元素）', adm.includes('#ickLogBox td:nth-child(2)::before') && adm.includes('#ickLogBox th{display:none}'), '');
  push('动作按钮在窄屏至少 40px 高', adm.includes('#ickLogBox .mini{min-height:40px'), '');
  const bad0 = rows.filter((x) => !x.ok);
  console.log('\n' + (bad0.length ? 'FAILED ' + bad0.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE + ' (REMOTE)');
  process.exit(bad0.length ? 1 : 0);
}

const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
await post('/api/index-log', { password: PW, action: 'clear' });
for (const u of ['/nope-390-404', '/articles', '/faq']) await post('/api/index-check', { password: PW, url: BASE + u });

const cdp = await openCdp({ width: 900, height: 900 });
const prep = async () => {
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2500));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="submit"]'); if(n) n.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 300));
  await cdp.js(`(function(){var w=document.getElementById('ickLogWrap'); if(w&&!w.open){w.open=true; w.dispatchEvent(new Event('toggle'));} return 1})()`);
  await new Promise((r) => setTimeout(r, 1400));
};

try {
  // ---- 390 ----
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1400));
  await prep();

  const m = await cdp.js(`(function(){
    var box=document.getElementById('ickLogBox');
    var thead=box.querySelector('thead');
    var trs=Array.from(box.querySelectorAll('tr')).filter(function(x){return x.querySelector('td')});
    var tds=trs[0]?Array.from(trs[0].children):[];
    var lbl=getComputedStyle(tds[1]||box,'::before').content;
    var btns=Array.from(box.querySelectorAll('td:nth-child(6) .mini'));
    return {
      rows: trs.length,
      pageSw: document.documentElement.scrollWidth, pageCw: document.documentElement.clientWidth,
      boxSw: box.scrollWidth, boxCw: box.clientWidth,
      thVisible: Array.from(box.querySelectorAll('th')).filter(function(x){return getComputedStyle(x).display !== 'none'}).length,
      thead: thead?getComputedStyle(thead).display:'none',
      rowDisplay: trs[0]?getComputedStyle(trs[0]).display:'',
      rowH: trs[0]?Math.round(trs[0].getBoundingClientRect().height):-1,
      tds: tds.length,
      label: lbl,
      tdFs: tds[1]?parseFloat(getComputedStyle(tds[1]).fontSize):0,
      btnCount: btns.length,
      btnMinH: btns.length?Math.min.apply(null, btns.map(b=>Math.round(b.getBoundingClientRect().height))):0,
      btnMinW: btns.length?Math.min.apply(null, btns.map(b=>Math.round(b.getBoundingClientRect().width))):0,
    };
  })()`);
  push('390：记录至少 3 条', m.rows >= 3, m.rows);
  push('390：整页不横向溢出', m.pageSw <= m.pageCw + 1, { sw: m.pageSw, cw: m.pageCw });
  push('390：记录区不再被裁（内容宽 == 容器宽）', m.boxSw <= m.boxCw + 1, { sw: m.boxSw, cw: m.boxCw });
  push('390：表头（th）藏起来、每行变成块', m.thVisible === 0 && m.rowDisplay === 'block', { thVisible: m.thVisible, row: m.rowDisplay });
  push('390：每行仍是 6 格（只是换了排版）', m.tds === 6, m.tds);
  push('390：格子里带列名（路径/状态…）', /路径/.test(m.label), m.label);
  push('390：行高没有被挤成一条（≥90px）', m.rowH >= 90 && m.rowH <= 360, m.rowH);
  push('390：字号 ≥ 12.5px', m.tdFs >= 12.5, m.tdFs);
  push('390：动作按钮 ≥40px 高、≥56px 宽', m.btnCount >= 3 && m.btnMinH >= 40 && m.btnMinW >= 56, { n: m.btnCount, h: m.btnMinH, w: m.btnMinW });

  // 动作仍可点：点第一个「重查」，记录数应 +1
  const before = m.rows;
  const after = await cdp.js(`(function(){
    var b=document.querySelector('#ickLogBox td:nth-child(6) [data-ickre]');
    if(!b) return -1;
    b.click();
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 2200));
  const rowsNow = await cdp.js(`(function(){
    var r=document.querySelectorAll('#ickLogBox tr').length;
    var msg=(document.getElementById('ickActMsg')||{}).textContent||'';
    return {r:r, msg:msg};
  })()`);
  push('390：点「重查」能跑并回话', after === 1 && rowsNow.r >= before && /重查|已查|记录/.test(rowsNow.msg), { after, rows: rowsNow.r, msg: String(rowsNow.msg).slice(0, 40) });

  // ---- 1440 ----
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1400));
  await prep();
  for (let i = 0; i < 6; i++) {
    const opened = await cdp.js(`(function(){var w=document.getElementById('ickLogWrap'); if(!w) return 'no'; if(!w.open){w.open=true; w.dispatchEvent(new Event('toggle'));} return w.open?'open':'closed'})()`);
    if (opened === 'open') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 900));
  const d = await cdp.js(`(function(){
    var box=document.getElementById('ickLogBox');
    var thead=box.querySelector('thead');
    var trs=Array.from(box.querySelectorAll('tr')).filter(function(x){return x.querySelector('td')});
    return {thCount: box.querySelectorAll('th').length, theadDisp: thead?getComputedStyle(thead).display:'none', row: trs[0]?getComputedStyle(trs[0]).display:'', rows: trs.length,
      boxSw: box.scrollWidth, boxCw: box.clientWidth};
  })()`);
  push('1440：还是表格（行是 table-row、表头 th 在 DOM 里）', d.thCount >= 6 && d.row === 'table-row', d);
  push('1440：不横向溢出', d.boxSw <= d.boxCw + 1, { sw: d.boxSw, cw: d.boxCw });
  push('1440：记录还在', d.rows >= 3, d.rows);
} finally {
  await cdp.close();
}

const bad = rows.filter((x) => !x.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + ' of ' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE);
process.exit(bad.length ? 1 : 0);