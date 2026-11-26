// 后台文章列表：行内改分类（下拉 → 立即保存 → 状态行 → 链接跟着变）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const W = Number(process.env.W || 1440);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghr-artcat-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 120 && !target; i++) { try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(150); }
if (!target) { console.error('no cdp page'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result && r.result.exceptionDetails) throw new Error(String((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text));
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const rows = [];
const push = (name, ok, extra) => { rows.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 950, deviceScaleFactor: 1, mobile: W < 500 });
await send('Page.navigate', { url: BASE + '/admin?t=' + Date.now() });
await sleep(2800);
if (REMOTE) {
  const html = await (await fetch(BASE + '/admin?t=' + Date.now())).text();
  push('列表行有分类下拉（data-artcat）', html.includes('data-artcat='));
  push('下拉带可访问名（含书名号标题）', html.includes('aria-label="《'));
  push('工具栏有行内状态位', html.includes('id="artInlineMsg"'));
  push('样式里有 .artcat', html.includes('.artcat{max-width:150px'));
  const bad = rows.filter((r) => !r.ok).length;
  console.log('\n' + (bad ? 'FAILED ' + (rows.length - bad) + '/' + rows.length : 'ALL OK (' + rows.length + ')') + '  [online read-only]  ' + BASE);
  child.kill(); ws.close(); process.exit(bad ? 1 : 0);
}

await ev("(function(){var p=document.getElementById('pw'); if(p) p.value='dev'; var b=document.getElementById('loginBtn'); if(b) b.click(); return 1;})()");
await sleep(1800);
await ev("(function(){var n=document.querySelector('[data-tab=\"articles\"]'); if(n) n.click(); return 1;})()");
await sleep(1200);

const info = await ev(`(function(){
  var sels = Array.prototype.slice.call(document.querySelectorAll('#artTbody [data-artcat]'));
  var trs = Array.prototype.slice.call(document.querySelectorAll('#artTbody tr'));
  var first = sels[0];
  var opts = first ? Array.prototype.map.call(first.options, function(o){return o.value;}) : [];
  var r = first ? first.getBoundingClientRect() : null;
  return { rows: trs.length, sels: sels.length, val: first ? first.value : null,
           label: first ? first.getAttribute('aria-label') : '',
           opts: opts, w: r ? Math.round(r.width) : 0,
           sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
           msg: (document.getElementById('artInlineMsg')||{}).textContent || '' };
})()`);
push('每行都有分类下拉', info.sels > 0 && info.sels === info.rows, info);
push('下拉有可访问名（含书名号标题）', /《.+》的分类/.test(info.label || ''));
push('选项含「未分类」与现有分类', (info.opts || []).includes('') && (info.opts || []).length >= 2, info.opts);

// 当前值 = 后台数据里的分类
const api = await (await fetch(BASE + '/api/articles')).json();
const firstArt = (api.articles || [])[0];
const row0 = await ev(`(function(){var s=document.querySelector('#artTbody [data-artcat]'); var tr=s.closest('tr'); return {id:s.getAttribute('data-artcat'), val:s.value, slug:(tr.querySelector('.slugline')||{}).textContent||''};})()`);
const matchArt = (api.articles || []).filter((a) => String(a.id) === String(row0.id))[0];
push('下拉初值 = 数据里的分类', (matchArt ? (matchArt.category || '') : 'X') === row0.val, { ui: row0.val, data: matchArt && matchArt.category });

// 改成临时分类
const TMP = 'e2e-tmp';
await ev(`(function(){var s=document.querySelector('#artTbody [data-artcat]'); var o=document.createElement('option'); o.value='${TMP}'; o.textContent='${TMP}'; s.appendChild(o); s.value='${TMP}'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
await sleep(2200);
const after = await (await fetch(BASE + '/api/articles')).json();
const changed = (after.articles || []).filter((a) => String(a.id) === String(row0.id))[0];
push('改分类真的写进数据', changed && changed.category === TMP, changed && { cat: changed.category, slug: changed.slug });
push('链接跟着分类变', changed && String(changed.slug || '').startsWith('e2e-tmp/'), changed && changed.slug);
const msgA = await ev("(function(){var b=document.getElementById('artInlineMsg'); return {text:(b||{}).textContent||'', ok:!!b&&b.classList.contains('ok')};})()");
push('状态行说清改成了什么', /已把《.+》改成「e2e-tmp」/.test(msgA.text) && msgA.ok, msgA);
const rowAfter = await ev("(function(){var s=document.querySelector('#artTbody [data-artcat]'); return s?s.value:'';})()");
push('重渲染后下拉仍指向新分类', rowAfter === TMP, rowAfter);

// 还原
await ev(`(function(){var s=document.querySelector('#artTbody [data-artcat]'); var o=document.createElement('option'); o.value='${matchArt && matchArt.category ? matchArt.category : ''}'; o.textContent=o.value||'未分类'; s.appendChild(o); s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
await sleep(2200);
const back = await (await fetch(BASE + '/api/articles')).json();
const restored = (back.articles || []).filter((a) => String(a.id) === String(row0.id))[0];
push('可以改回原分类', restored && (restored.category || '') === (matchArt && matchArt.category || ''), restored && restored.category);
push('页面不横向溢出', info.sw <= info.cw + 1, { sw: info.sw, cw: info.cw });
push('下拉宽度不超过 150', info.w > 0 && info.w <= 152, info.w);

const bad = rows.filter((r) => !r.ok).length;
console.log('\n' + (bad ? 'FAILED ' + (rows.length - bad) + '/' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + W + 'px  ' + BASE);
child.kill(); ws.close();
process.exit(bad ? 1 : 0);