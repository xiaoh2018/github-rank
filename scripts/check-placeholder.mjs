import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chk = (n, ok, ex) => { rows.push(!!ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (ex !== undefined ? '  [' + ex + ']' : '')); };

async function session(w, h, url, ready) {
  const port = 14400 + Math.floor(Math.random() * 150);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let ws, seq = 0; const pending = new Map();
  for (let i = 0; i < 120; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); break; } } catch (e) {} await sleep(200); }
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id, method: m, params: p })); }); };
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'EXC:' + String((r.exceptionDetails.exception || {}).description || '').slice(0, 200) : (r.result && r.result.value); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 800 });
  await send('Page.navigate', { url: `${BASE}${url}${url.indexOf('?') >= 0 ? '&' : '?'}t=${Date.now()}` });
  for (let i = 0; i < 200; i++) { if (await ev(ready)) break; await sleep(150); }
  await sleep(900);
  return { ev, done: () => { try { ws.close(); } catch (e) {} chrome.kill(); } };
}

const ph = (id) => `(document.getElementById('${id}')||{}).placeholder||''`;

for (const [w, h] of [[320, 800], [390, 844]]) {
  const s = await session(w, h, '/', "document.querySelectorAll('#list .item').length>0");
  const q = await s.ev(ph('q'));
  chk(`${w}px 榜单搜索占位符够短`, q.length > 0 && q.length <= 16, q);
  await s.ev("document.getElementById('tabFaq').click()");
  await sleep(600);
  const f = await s.ev(ph('faqSearch'));
  chk(`${w}px 问答搜索占位符够短`, f.length > 0 && f.length <= 16, f);
  await s.ev("document.getElementById('tabArticles').click()");
  await sleep(600);
  const a = await s.ev(ph('artSearch'));
  chk(`${w}px 文章搜索占位符够短`, a.length > 0 && a.length <= 16, a);
  s.done();

  const s2 = await session(w, h, '/articles', "document.querySelectorAll('#cards .acard').length>0");
  const x = await s2.ev(ph('search'));
  chk(`${w}px 静态文章页占位符够短`, x.length > 0 && x.length <= 16, x);
  s2.done();

  const s3 = await session(w, h, '/faq', "document.querySelectorAll('#list .qa').length>0");
  const y = await s3.ev(ph('q'));
  chk(`${w}px 静态问答页占位符够短`, y.length > 0 && y.length <= 16, y);
  s3.done();
}

const s4 = await session(1440, 900, '/', "document.querySelectorAll('#list .item').length>0");
const q4 = await s4.ev(ph('q'));
chk('1440px 桌面仍用长占位符（带快捷键提示）', q4.length >= 20 && q4.indexOf('/') >= 0, q4);
s4.done();

const bad = rows.filter((x) => !x).length;
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
