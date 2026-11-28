import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const adm = await (await fetch(BASE + '/admin')).text();
  push('后台内置了撤销条（offerUndo / undoGo）', adm.includes('offerUndo') && adm.includes('undoGo') && adm.includes('__undo'));
  push('问答删除会提示「已删除问答」', adm.includes('已删除问答「'));
  finish();
}

const cdp = await openCdp({ width: 1440, height: 950 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1400));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2800));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="qa"]'); if(n) n.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 600));

  const n0 = await cdp.js(`document.querySelectorAll('#qaList [data-qadel]').length`);
  const q0 = await cdp.js(`(document.querySelector('#qaList .qa-q')||{}).value || ''`);
  push('问答面板有若干条', n0 >= 2, n0);

  // 删除第一条（确认框）
  await cdp.js(`(function(){var b=document.querySelector('#qaList [data-qadel]'); b.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 300));
  const dlgOpen = await cdp.js(`(function(){var d=document.getElementById('delDlg'); return d ? d.open : null})()`);
  push('删除前有确认框', dlgOpen === true, dlgOpen);
  await cdp.js(`(function(){document.getElementById('delSubmit').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 500));

  const n1 = await cdp.js(`document.querySelectorAll('#qaList [data-qadel]').length`);
  push('确认后少一条', n1 === n0 - 1, n1 + '/' + n0);

  const bar = await cdp.js(`(function(){var b=document.getElementById('undoBar'); if(!b) return null; var cs=getComputedStyle(b); return {shown: cs.display !== 'none', text: b.textContent, hasGo: !!b.querySelector('#undoGo')}})()`);
  push('撤销条出现且带说明', bar && bar.shown && bar.hasGo && /已删除问答/.test(bar.text), bar ? bar.text : 'null');

  await cdp.js(`(function(){document.getElementById('undoGo').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 500));
  const n2 = await cdp.js(`document.querySelectorAll('#qaList [data-qadel]').length`);
  const q2 = await cdp.js(`(document.querySelector('#qaList .qa-q')||{}).value || ''`);
  push('撤销后回到原数量', n2 === n0, n2 + '/' + n0);
  push('撤销后回到原位置（第一条还是原来那条）', q2 === q0, q2.slice(0, 24));

  const hidden = await cdp.js(`(function(){var b=document.getElementById('undoBar'); return b ? getComputedStyle(b).display === 'none' : true})()`);
  push('撤销后条子自动收起', hidden === true, hidden);

  // 连删两条：撤销只回到 n0-1
  await cdp.js(`(function(){document.querySelector('#qaList [data-qadel]').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 250));
  await cdp.js(`(function(){document.getElementById('delSubmit').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 400));
  await cdp.js(`(function(){document.querySelector('#qaList [data-qadel]').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 250));
  await cdp.js(`(function(){document.getElementById('delSubmit').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 450));
  const n3 = await cdp.js(`document.querySelectorAll('#qaList [data-qadel]').length`);
  await cdp.js(`(function(){document.getElementById('undoGo').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 450));
  const n4 = await cdp.js(`document.querySelectorAll('#qaList [data-qadel]').length`);
  push('连删两条后撤销只回一条（撤销的是最后一次）', n3 === n0 - 2 && n4 === n0 - 1, n3 + '->' + n4);

  // 390 下撤销条不溢出
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 300));
  await cdp.js(`window.__undo && 1`);
  const w = await cdp.js(`(function(){var b=document.getElementById('undoBar'); var r=b?b.getBoundingClientRect():null; return {sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, bw: r?Math.round(r.width):0}})()`);
  push('390 下撤销条不超出视口', w.sw <= w.cw + 1 && w.bw <= 390, JSON.stringify(w));
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