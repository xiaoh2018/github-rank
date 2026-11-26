import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const PORT = 9600 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map();
let fails = 0, total = 0;

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; return; }
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('CDP 连不上');
}
function send(method, params = {}) { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); }); }
async function e(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; }
async function waitFor(expr, ms = 15000) { for (let t = 0; t < ms; t += 200) { try { if (await e(expr)) return true; } catch (err) {} await sleep(200); } return false; }
function ok(name, cond, extra = '') { total++; if (cond) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + '  ' + extra); } }

async function run(tag, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 800 });
  await send('Page.navigate', { url: BASE + '/articles' });
  await waitFor("document.querySelectorAll('#cards .acard').length > 0");
  await sleep(300);

  const cats = await e("Array.from(document.querySelectorAll('#chips [data-cat]')).map(b=>b.getAttribute('data-cat')).filter(v=>v!=='all')");
  ok('[' + tag + '] 至少有一个真实分类可测', Array.isArray(cats) && cats.length > 0, JSON.stringify(cats));
  const cat = (cats && cats[0]) || '技术';
  const catLabel = await e("(function(){var b=document.querySelector('#chips [data-cat=\"' + cat + '\"]');return b?b.textContent.trim():'';})()");

  // 关键词 + 分类同时命中 0 条
  await e("var b=document.querySelector('#chips [data-cat=\"" + cat + "\"]'); b&&b.click();");
  await sleep(200);
  await e("(function(){var s=document.getElementById('search'); s.value='zzzzqqq'; s.dispatchEvent(new Event('input',{bubbles:true}));})()");
  const gotEmpty = await waitFor("!!document.querySelector('#cards .empty-filter')");
  ok('[' + tag + '] 组合筛选无结果时出现筛选空态卡', gotEmpty);

  const txt = await e("(function(){var el=document.querySelector('#cards .empty-filter');return el?el.innerText.replace(/\\s+/g,' '):'';})()");
  ok('[' + tag + '] 标题说清「没有匹配的文章」', /没有匹配的文章/.test(txt), txt.slice(0, 60));
  const catLabelNow = await e("(function(){var b=document.querySelector('#chips .chip.is-on');return b?b.textContent.trim():'';})()");
  ok('[' + tag + '] 列出分类条件', txt.indexOf('分类「' + catLabelNow + '」') >= 0, JSON.stringify({ cat, catLabel, catLabelNow, txt: txt.slice(0, 120) }));
  ok('[' + tag + '] 列出关键词条件', txt.indexOf('关键词「zzzzqqq」') >= 0, txt.slice(0, 120));
  ok('[' + tag + '] 说明是逐篇看过的（站内一共 N 篇）', /站内一共 \d+ 篇/.test(txt), txt.slice(0, 160));

  const btns = await e("Array.from(document.querySelectorAll('#cards .empty-filter [data-ef]')).map(b=>b.getAttribute('data-ef'))");
  ok('[' + tag + '] 三个出口按钮齐全', Array.isArray(btns) && ['q', 'cat', 'all'].every((k) => btns.indexOf(k) >= 0), JSON.stringify(btns));

  const box = await e("(function(){var r=document.querySelector('#cards .empty-filter .ef-acts').getBoundingClientRect();return {h:r.height,sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth};})()");
  ok('[' + tag + '] 按钮区高度合理且不横向溢出', box && box.h >= 36 && box.sw <= box.cw + 1, JSON.stringify(box));

  // 只清关键词：分类保留，列表回来
  await e("document.querySelector('#cards .empty-filter [data-ef=\"q\"]').click()");
  const backCards = await waitFor("document.querySelectorAll('#cards .acard').length > 0");
  const qNow = await e("document.getElementById('search').value");
  const catOn = await e("(function(){var b=document.querySelector('#chips .chip.is-on');return b?b.getAttribute('data-cat'):null;})()");
  ok('[' + tag + '] 「只清关键词」后列表回来', backCards);
  ok('[' + tag + '] 「只清关键词」后搜索框清空', qNow === '', JSON.stringify(qNow));
  ok('[' + tag + '] 「只清关键词」后分类仍保留', catOn === cat, JSON.stringify(catOn));

  // 再制造空态，用「清空全部筛选」
  await e("(function(){var s=document.getElementById('search'); s.value='zzzzqqq'; s.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await waitFor("!!document.querySelector('#cards .empty-filter')");
  await e("document.querySelector('#cards .empty-filter [data-ef=\"all\"]').click()");
  await waitFor("document.querySelectorAll('#cards .acard').length > 0");
  const st = await e("({q:document.getElementById('search').value, cat:(document.querySelector('#chips .chip.is-on')||{}).getAttribute?document.querySelector('#chips .chip.is-on').getAttribute('data-cat'):null, url:location.search})");
  ok('[' + tag + '] 「清空全部筛选」后关键词为空', st && st.q === '', JSON.stringify(st));
  ok('[' + tag + '] 「清空全部筛选」后分类回到全部', st && st.cat === 'all', JSON.stringify(st));
  ok('[' + tag + '] 清空后地址栏不带筛选参数', st && !/[?&](q|cat)=/.test(st.url), st && st.url);
}

(async () => {
  await connect(); await send('Page.enable'); await send('Runtime.enable');
  await run('390', 390, 800);
  await send('Emulation.clearDeviceMetricsOverride');
  await run('1440', 1440, 900);
  console.log('\n' + (fails ? 'FAILED ' + fails + ' / ' + total : 'ALL OK (' + total + ')'));
  try { ws.close(); } catch (err) {}
  chrome.kill();
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error('ERROR ' + err.message); try { chrome.kill(); } catch (e2) {} process.exit(1); });
