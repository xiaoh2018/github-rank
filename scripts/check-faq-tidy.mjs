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
  const port = 14100 + Math.floor(Math.random() * 150);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'faqgate-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let ws, seq = 0; const pending = new Map();
  for (let i = 0; i < 120; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); break; } } catch (e) {} await sleep(200); }
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id, method: m, params: p })); }); };
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'EXC:' + String((r.exceptionDetails.exception || {}).description || '').slice(0, 200) : (r.result && r.result.value); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}${url}${url.indexOf('?') >= 0 ? '&' : '?'}t=${Date.now()}` });
  for (let i = 0; i < 220; i++) { if (await ev(ready)) break; await sleep(150); }
  await sleep(700);
  return { ev, done: () => { try { ws.close(); } catch (e) {} chrome.kill(); } };
}

const MEASURE = `(function(){
  var de=document.documentElement, root=document.getElementById('faqView')||document.getElementById('list');
  var tiny=0, bad=[];
  root.querySelectorAll('*').forEach(function(el){
    var r=el.getBoundingClientRect(); if(r.width<1||r.height<1) return;
    var cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none') return;
    var fsx=parseFloat(cs.fontSize), t=(el.textContent||'').trim();
    if(fsx&&fsx<12&&t.length>1&&el.children.length===0) tiny++;
    if(el.matches('a,button,summary,[role=button]')){ if(r.height<28&&r.width<44) bad.push(el.tagName+' '+(el.className||'')+' '+Math.round(r.width)+'x'+Math.round(r.height)); }
  });
  var qt=root.querySelector('.qtag'), ql=root.querySelector('.qlink');
  return JSON.stringify({sw:de.scrollWidth,cw:de.clientWidth,rows:root.querySelectorAll('.qa').length,
    tiny:tiny,bad:bad, qtag: qt?getComputedStyle(qt).fontSize:'', qlh: ql?Math.round(ql.getBoundingClientRect().height):0});
})()`;

for (const [w, h, url, ready, tag] of [
  [320, 800, '/?page=faq', "document.querySelectorAll('#faqView .qa').length>0", 'SPA 320'],
  [390, 844, '/?page=faq', "document.querySelectorAll('#faqView .qa').length>0", 'SPA 390'],
  [390, 844, '/faq', "document.querySelectorAll('#list .qa').length>0", '静态 /faq 390'],
]) {
  const s = await session(w, h, url, ready);
  const o = JSON.parse(await s.ev(MEASURE));
  chk(tag + ' 十条问答都在', o.rows === 10, o.rows);
  chk(tag + ' 不横向溢出', o.sw === o.cw, o.sw + '/' + o.cw);
  chk(tag + ' 没有 <12px 文字', o.tiny === 0, o.tiny);
  chk(tag + ' 可点目标 ≥28 高或 ≥44 宽', o.bad.length === 0, o.bad.join(' | '));
  chk(tag + ' 分类标签 12px', parseFloat(o.qtag) >= 12, o.qtag);
  if (tag.indexOf('静态') === 0) chk(tag + ' 「#N」链接可点面积 ≥32 高', o.qlh >= 32, o.qlh);
  s.done();
}

const bad = rows.filter((x) => !x).length;
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
