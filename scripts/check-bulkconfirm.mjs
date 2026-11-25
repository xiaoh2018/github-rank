// 批量改分类二次确认门禁：勾选后点「应用分类」必须先弹确认框（会改 slug/链接），取消则不写盘。
// 用法：先起 dev-server（8123），再 node scripts/check-bulkconfirm.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:8123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9990 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-bulk-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (name, cond, detail) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']')); if (!cond) fails++; };

let target;
for (let i = 0; i < 40 && !target; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((x) => x.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
if (!target) { console.error('Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/admin?v=' + Date.now() });
await sleep(2400);

// 登录
await evalJs(`(() => { var p = document.getElementById('pw'); if (p) p.value = 'dev'; var f = document.getElementById('loginForm'); if (f) f.requestSubmit(); return 1; })()`);
await sleep(2000);
const loggedIn = await evalJs(`!document.getElementById('gate') || document.getElementById('gate').hidden || getComputedStyle(document.getElementById('gate')).display === 'none'`);
ok('登录后台成功', loggedIn === true, String(loggedIn));

await evalJs(`(() => { var n = document.querySelector('.nav[data-tab="articles"]'); if (n) n.click(); return 1; })()`);
await sleep(1500);

const panel = await evalJs(`(() => ({
  rows: document.querySelectorAll('#artTbody [data-artpick]').length,
  hasApply: !!document.getElementById('artBulkApply'),
  hasCat: !!document.getElementById('artBulkCat'),
  options: [...(document.querySelectorAll('#artBulkCat option'))].map(o => o.value).filter(Boolean),
}))()`);
ok('文章面板有勾选框', panel && panel.rows > 0, JSON.stringify(panel));
ok('有「应用分类」按钮与分类下拉', panel && panel.hasApply && panel.hasCat, JSON.stringify(panel));
ok('分类下拉有可选项', panel && panel.options.length > 0, JSON.stringify(panel));

// 勾第一行 + 选一个分类，然后点应用
const picked = await evalJs(`(() => {
  var cb = document.querySelector('#artTbody [data-artpick]');
  cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
  var sel = document.getElementById('artBulkCat');
  var val = [...sel.options].map(o => o.value).filter(Boolean)[0];
  sel.value = val; sel.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('artBulkApply').click();
  return { cat: val };
})()`);
await sleep(700);

const dlg = await evalJs(`(() => {
  var d = document.getElementById('delDlg');
  return { open: !!(d && d.open), title: (document.getElementById('delTitle') || {}).textContent || '', body: (document.getElementById('delNote') || {}).textContent || '' };
})()`);
ok('点「应用分类」先弹确认框', dlg && dlg.open === true, JSON.stringify(dlg));
ok('确认框标题写明批量改分类', dlg && dlg.title.indexOf('批量改分类') >= 0, JSON.stringify(dlg));
ok('确认框说明会改链接', dlg && (dlg.body.indexOf('链接') >= 0 || dlg.body.indexOf('.html') >= 0), JSON.stringify(dlg));

// 取消：不应写盘
const before = await (await fetch(base + '/api/articles?v=' + Date.now())).json().catch(() => ({}));
await evalJs(`(() => { var b = document.querySelector('#delDlg [data-close="delDlg"]'); if (b) b.click(); else document.getElementById('delDlg').close(); return 1; })()`);
await sleep(900);
const closed = await evalJs(`(() => { var d = document.getElementById('delDlg'); return !(d && d.open); })()`);
ok('点取消后弹窗关闭', closed === true, String(closed));
const after = await (await fetch(base + '/api/articles?v=' + Date.now())).json().catch(() => ({}));
const sig = (j) => JSON.stringify((j.articles || []).map((a) => [a.id, a.category, a.slug]));
ok('取消后文章分类与链接没变', sig(before) === sig(after), sig(before) + ' vs ' + sig(after));

console.log(fails ? '\n' + fails + ' FAILED' : '\n全部通过');
try { ws.close(); } catch {}
try { child.kill(); } catch {}
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(fails ? 1 : 0);
