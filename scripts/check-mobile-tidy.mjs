import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
function chk(n, ok, extra) { rows.push({ n, ok: !!ok, extra: extra === undefined ? '' : String(extra) }); console.log((ok ? 'OK   ' : 'FAIL ') + n + (extra !== undefined ? '  [' + extra + ']' : '')); }

async function session(w, h) {
  const port = 12500 + Math.floor(Math.random() * 200);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let ws, seq = 0; const pending = new Map();
  for (let i = 0; i < 120; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); break; } } catch (e) {} await sleep(200); }
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id, method: m, params: p })); }); };
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'EXC:' + String((r.exceptionDetails.exception || {}).description || '').slice(0, 200) : (r.result && r.result.value); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });
  return { ev, done: () => { try { ws.close(); } catch (e) {} chrome.kill(); } };
}

for (const [w, h] of [[320, 800], [360, 800], [390, 844]]) {
  const s = await session(w, h);
  for (let i = 0; i < 160; i++) { if (await s.ev("document.querySelectorAll('#list .item').length>0")) break; await sleep(150); }
  await sleep(600);
  const m = await s.ev(`(function(){
    var de=document.documentElement, main=document.querySelector('.main'), list=document.querySelector('#list'), pager=document.getElementById('pager');
    var pagerH=pager?Math.round(pager.getBoundingClientRect().height):0;
    var tiny=0, bad=0;
    document.querySelectorAll('body *').forEach(function(el){
      var r=el.getBoundingClientRect(); if(r.width<1||r.height<1) return;
      var cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none') return;
      var t=el.tagName.toLowerCase(); if(t==='html'||t==='body') return;
      var fsx=parseFloat(cs.fontSize); if(fsx && fsx<12 && (el.textContent||'').trim().length>1) tiny++;
      if(el.matches('a,button,[role=button]')){
        var okTarget = (r.height>=28 || r.width>=44);
        if(!okTarget) bad++;
      }
    });
    return JSON.stringify({sw:de.scrollWidth,cw:de.clientWidth,mainW:Math.round(main.getBoundingClientRect().width),
      listW:Math.round(list.getBoundingClientRect().width), pagerH:pagerH, tiny:tiny, badTargets:bad});
  })()`);
  const o = JSON.parse(m);
  chk(`${w}px 不横向溢出`, o.sw === o.cw, `${o.sw}/${o.cw}`);
  chk(`${w}px 榜单列填满内容区（${w - 32}）`, Math.abs(o.mainW - (w - 32)) <= 2, o.mainW);
  chk(`${w}px 卡片列表与主列同宽`, Math.abs(o.listW - o.mainW) <= 2, `${o.listW} vs ${o.mainW}`);
  chk(`${w}px 没有小于 12px 的文字`, o.tiny === 0, o.tiny);
  chk(`${w}px 可点目标 ≥28 高或 ≥44 宽`, o.badTargets === 0, o.badTargets);
  chk(`${w}px 分页器高度 ≤ 140（最多两排）`, o.pagerH > 0 && o.pagerH <= 140, o.pagerH);
  s.done();
}

const bad = rows.filter((r) => !r.ok).length;
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
