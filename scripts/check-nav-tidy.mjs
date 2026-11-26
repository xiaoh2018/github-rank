import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chk = (n, ok, ex) => { rows.push(!!ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (ex !== undefined ? '  [' + ex + ']' : '')); };

async function session(w, h, url) {
  const port = 13100 + Math.floor(Math.random() * 150);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'navgate-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let ws, seq = 0; const pending = new Map();
  for (let i = 0; i < 120; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); break; } } catch (e) {} await sleep(200); }
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id, method: m, params: p })); }); };
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'EXC:' + String((r.exceptionDetails.exception || {}).description || '').slice(0, 160) : (r.result && r.result.value); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}${url}?t=${Date.now()}` });
  for (let i = 0; i < 200; i++) { if (await ev("document.querySelectorAll('#navBody .navcard').length>0")) break; await sleep(150); }
  await sleep(700);
  return { ev, done: () => { try { ws.close(); } catch (e) {} chrome.kill(); } };
}

const MEASURE = `(function(){
  var de=document.documentElement, v=document.getElementById('navView');
  var cards=[].slice.call(document.querySelectorAll('#navBody .navcard:not(.ad-inline-card)'));
  var tiny=0,bad=0;
  document.querySelectorAll('#navView *').forEach(function(el){
    var r=el.getBoundingClientRect(); if(r.width<1||r.height<1) return;
    var cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none') return;
    var fsx=parseFloat(cs.fontSize); if(fsx && fsx<12 && (el.textContent||'').trim().length>1) tiny++;
    if(el.matches('a,button,[role=button]')){ if(!(r.height>=28||r.width>=44)) bad++; }
  });
  var ib=document.getElementById('insightBtn');
  return JSON.stringify({sw:de.scrollWidth,cw:de.clientWidth,viewW:Math.round(v.getBoundingClientRect().width),
    cards:cards.length,cardW:cards.length?Math.round(cards[0].getBoundingClientRect().width):0,
    tiny:tiny,bad:bad,insightVisible: ib ? getComputedStyle(ib).display!=='none' : false,
    hostFont: cards.length? getComputedStyle(cards[0].querySelector('.host')).fontSize : '',
    njFont: (function(){var e=document.querySelector('.nj em'); return e?getComputedStyle(e).fontSize:'';})()});
})()`;

for (const [w, h] of [[320, 800], [390, 844]]) {
  const s = await session(w, h, '/');
  await s.ev("document.getElementById('tabNav').click()");
  await sleep(700);
  const o = JSON.parse(await s.ev(MEASURE));
  chk(`${w}px 导航视图不横向溢出`, o.sw === o.cw, `${o.sw}/${o.cw}`);
  chk(`${w}px 导航卡片铺满内容区`, Math.abs(o.cardW - o.viewW) <= 2, `${o.cardW}/${o.viewW}`);
  chk(`${w}px 23 个站点卡片`, o.cards === 23, o.cards);
  chk(`${w}px 没有小于 12px 的文字`, o.tiny === 0, o.tiny);
  chk(`${w}px 可点目标 ≥28 高或 ≥44 宽`, o.bad === 0, o.bad);
  chk(`${w}px 导航视图隐藏「分析」按钮`, o.insightVisible === false, o.insightVisible);
  chk(`${w}px 网址行 12px`, parseFloat(o.hostFont) >= 12, o.hostFont);
  chk(`${w}px 分类计数 12px`, parseFloat(o.njFont) >= 12, o.njFont);
  await s.ev("document.getElementById('tabRank').click()");
  await sleep(600);
  chk(`${w}px 切回榜单后「分析」按钮回来`, await s.ev("getComputedStyle(document.getElementById('insightBtn')).display!=='none'"));
  s.done();
}

const bad = rows.filter((x) => !x).length;
console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
process.exit(bad === 0 ? 0 : 1);
