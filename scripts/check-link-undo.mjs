import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const PW = 'dev';
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const adm = await (await fetch(BASE + '/admin')).text();
  push('友链删除会提示「已删除友链」并能撤销', adm.includes('已删除友链「') && adm.includes("action: 'insert'"));
  push('确认框文案不再说「删除不可撤销」', !adm.includes('删除不可撤销（要恢复就重新添加一次）'));
  finish();
}

const post = async (body) => (await fetch(BASE + '/api/links', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(Object.assign({ password: PW }, body)),
})).json();

// 清空 + 造三条
for (let k = 0; k < 20; k++) {
  const r = await post({ action: 'remove', index: 0 });
  if (!r.ok) break;
}
const A = { name: '甲站', url: 'https://a.example.com/', desc: 'a' };
const B = { name: '乙站', url: 'https://b.example.com/', desc: 'b' };
const C = { name: '丙站', url: 'https://c.example.com/', desc: 'c' };
for (const it of [A, B, C]) await post(Object.assign({ action: 'add' }, it));

let list = (await (await fetch(BASE + '/api/links')).json()).links.map((x) => x.name);
push('准备三条友链', list.join(',') === '甲站,乙站,丙站', list.join(','));

// 接口：删中间 → 按位置插回
await post({ action: 'remove', index: 1 });
list = (await (await fetch(BASE + '/api/links')).json()).links.map((x) => x.name);
push('接口删除中间一条', list.join(',') === '甲站,丙站', list.join(','));
const ins = await post(Object.assign({ action: 'insert', index: 1 }, B));
list = (await (await fetch(BASE + '/api/links')).json()).links.map((x) => x.name);
push('insert 按位置插回（不是追加到末尾）', ins.ok && list.join(',') === '甲站,乙站,丙站', list.join(','));

const clamp = await post(Object.assign({ action: 'insert', index: 99 }, { name: '丁站', url: 'https://d.example.com/', desc: 'd' }));
list = (await (await fetch(BASE + '/api/links')).json()).links.map((x) => x.name);
push('insert 序号越界夹到末尾', clamp.ok && list[list.length - 1] === '丁站', list.join(','));

const bad = await post({ action: 'insert', index: 0, name: '戊站', url: 'javascript:alert(1)' });
push('insert 也校验网址（拒 javascript:）', !bad.ok && /http/.test(bad.error || ''), bad.error || '');

// 恢复三条，UI 段用
await post({ action: 'remove', index: 3 });
list = (await (await fetch(BASE + '/api/links')).json()).links.map((x) => x.name);
push('清理到三条', list.join(',') === '甲站,乙站,丙站', list.join(','));

const cdp = await openCdp({ width: 1440, height: 950 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1400));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2800));
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="links"]'); if(n) n.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 700));

  const names = () => cdp.js(`Array.prototype.map.call(document.querySelectorAll('#linkBody tr'), function(tr){ return tr.querySelector('td').textContent.trim(); })`);

  const n0 = await names();
  push('后台列出三条', n0.length === 3, n0.join(','));

  await cdp.js(`(function(){document.querySelector('#linkBody [data-del="1"]').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 350));
  const dlg = await cdp.js(`(function(){var d=document.getElementById('delDlg'); return d?d.open:null})()`);
  push('删除前有确认框', dlg === true, dlg);
  await cdp.js(`(function(){document.getElementById('delSubmit').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 900));

  const n1 = await names();
  push('确认后少一条（甲站,丙站）', n1.join(',') === '甲站,丙站', n1.join(','));

  const bar = await cdp.js(`(function(){var b=document.getElementById('undoBar'); if(!b) return null; return {shown: getComputedStyle(b).display !== 'none', text: b.textContent}})()`);
  push('撤销条出现且写明删了谁', bar && bar.shown && /已删除友链/.test(bar.text), bar ? bar.text : 'null');

  await cdp.js(`(function(){document.getElementById('undoGo').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 1100));
  const n2 = await names();
  push('撤销后按原顺序回来（甲站,乙站,丙站）', n2.join(',') === '甲站,乙站,丙站', n2.join(','));

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