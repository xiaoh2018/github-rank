import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.env.W || 1440);
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, proc, userDir, last;
for (let i = 0; i < 3 && !ws; i++) {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const port = await freePort();
  proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir, '--window-size=' + W + ',1000', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  for (let k = 0; k < 50; k++) {
    try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); const p = l.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); break; } } catch (e) { last = e; }
    await sleep(200);
  }
}
if (!ws) throw new Error('cdp 连不上：可能有残留 headless chrome 占着端口（' + (last && last.message) + '）');

let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }; return r.result && r.result.result ? r.result.result.value : null; };
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 1000, deviceScaleFactor: 1, mobile: W < 700 });

const snap = () => js(`(function(){
  var b=document.getElementById('btnLang');
  var st=document.getElementById('status');
  return { label:b?b.textContent.trim():null, pressed:b?b.getAttribute('aria-pressed'):null, title:b?b.getAttribute('title'):null,
    status:st?(st.textContent||'').trim():'', lang:(function(){try{return localStorage.getItem('ghrank:lang')}catch(e){return 'ERR'}})(),
    desc:(function(){var d=document.querySelector('#list .item .desc');return d?(d.textContent||'').trim().slice(0,40):''})(),
    sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth };
})()`);

await send('Page.navigate', { url: BASE + '/?t=' + Date.now() });
await sleep(3000);
await js(`(function(){try{localStorage.removeItem('ghrank:lang')}catch(e){};location.reload();return 1})()`);
await sleep(3000);

const s0 = await snap();
push('按钮文案说的是「描述」而不是笼统的 English', s0.label === '描述：中文', s0.label);
push('按钮有 aria-pressed 与说明性 title', s0.pressed === 'false' && /中文翻译/.test(s0.title || ''), s0.pressed + ' | ' + (s0.title || '').slice(0, 18));
push('默认中文时描述是译文', /尝试在 PC 上运行/.test(s0.desc), s0.desc.slice(0, 20));

await js(`document.getElementById('btnLang').click()`);
await sleep(900);
const s1 = await snap();
push('点一次 → 文案变「描述：原文」且 aria-pressed=true', s1.label === '描述：原文' && s1.pressed === 'true', s1.label + ' / ' + s1.pressed);
push('点一次 → 描述换成 GitHub 原文', /An attempt at running/.test(s1.desc), s1.desc.slice(0, 24));
push('点一次 → 状态行说明这次切换', /GitHub 原文/.test(s1.status), s1.status.slice(0, 26));
push('点一次 → 选择存进 localStorage', s1.lang === 'en', s1.lang);

await js(`document.getElementById('btnLang').click()`);
await sleep(900);
const s2 = await snap();
push('再点一次 → 回到中文译文与 false', s2.label === '描述：中文' && s2.pressed === 'false' && /尝试在 PC 上运行/.test(s2.desc), s2.label + ' / ' + s2.pressed);
push('再点一次 → 状态行说明切回', /中文翻译/.test(s2.status), s2.status.slice(0, 26));
push('页面不横向溢出', s2.sw <= s2.cw + 1, s2.sw + '/' + s2.cw);

await js(`(function(){try{localStorage.setItem('ghrank:lang','en')}catch(e){};location.reload();return 1})()`);
await sleep(3000);
const s3 = await snap();
push('刷新后保留选择（按钮显示「描述：原文」）', s3.label === '描述：原文' && s3.pressed === 'true', s3.label + ' / ' + s3.pressed);

let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  → ' + r.extra : '')); }
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')  @' + W + 'px  ' + BASE : bad + ' FAILED of ' + rows.length);
ws.close(); proc.kill(); try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(bad === 0 ? 0 : 1);
