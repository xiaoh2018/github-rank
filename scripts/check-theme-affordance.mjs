import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chk = (n, ok, ex) => { rows.push(!!ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (ex !== undefined ? '  [' + ex + ']' : '')); };

async function session(url, ready) {
  const port = 15100 + Math.floor(Math.random() * 120);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let ws, seq = 0; const pending = new Map();
  for (let i = 0; i < 120; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); break; } } catch (e) {} await sleep(200); }
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id, method: m, params: p })); }); };
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'EXC:' + String((r.exceptionDetails.exception || {}).description || '').slice(0, 200) : (r.result && r.result.value); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}${url}${url.indexOf('?') >= 0 ? '&' : '?'}t=${Date.now()}` });
  for (let i = 0; i < 220; i++) { if (await ev(ready)) break; await sleep(150); }
  await sleep(800);
  return { ev, done: () => { try { ws.close(); } catch (e) {} chrome.kill(); } };
}

const INFO = `(function(){var b=document.getElementById('btnTheme');
  return JSON.stringify({has:!!b,text:b?b.textContent.trim():'',title:b?b.title:'',theme:document.documentElement.getAttribute('data-theme')||''});})()`;

for (const [url, ready, tag] of [
  ['/', "document.querySelectorAll('#list .item').length>0", '首页'],
  ['/articles', "document.querySelectorAll('#cards .acard').length>0", '静态文章'],
  ['/faq', "document.querySelectorAll('#list .qa').length>0", '静态问答'],
]) {
  const s = await session(url, ready);
  const o = JSON.parse(await s.ev(INFO));
  chk(tag + ' 有主题按钮', o.has === true);
  chk(tag + ' 按钮文案是「主题 · X」', /^主题 · \S+$/.test(o.text) && o.text.length <= 10, o.text);
  chk(tag + ' 有 title 说明', /切换配色主题/.test(o.title), o.title);
  const before = o.theme;
  await s.ev("document.getElementById('btnTheme').click()");
  await sleep(400);
  const after = await s.ev("document.documentElement.getAttribute('data-theme')");
  chk(tag + ' 点一下确实换主题', after !== before, before + ' -> ' + after);
  s.done();
}

const s2 = await session('/articles', "document.querySelectorAll('#cards .acard').length>0");
const dup = await s2.ev("(document.body.innerText.match(/按时间倒序/g)||[]).length");
chk('静态文章页「按时间倒序」只出现一次（去重副标题）', dup === 1, dup);
s2.done();

const bad = rows.filter((x) => !x).length;
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
