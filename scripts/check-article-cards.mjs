import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const PORT = 9500 + Math.floor(Math.random() * 400);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; return; }
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('CDP 连不上');
}
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result.value;
}
async function goto(url, waitFor) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) { await sleep(200); const n = await evalJs(`document.querySelectorAll('${waitFor}').length`); if (n > 0) return n; }
  throw new Error('等不到 ' + waitFor + ' @ ' + url);
}

const SPA_READ = `(function(){
  var out=[];
  document.querySelectorAll('#artViewList .artcard').forEach(function(c){
    out.push({
      title:(c.querySelector('h3')||{}).textContent||'',
      cat:(c.querySelector('.artcard-cat')||{}).textContent||'',
      date:(c.querySelector('time')||{}).textContent||'',
      mins:(c.querySelector('.artcard-mins')||{}).textContent||'',
      lock:(c.querySelector('.lock')||{}).textContent||''
    });
  });
  return out;
})()`;

const STATIC_READ = `(function(){
  var out=[];
  document.querySelectorAll('#cards .acard').forEach(function(c){
    var texts=[]; c.querySelectorAll('.ameta span').forEach(function(s){ texts.push(s.textContent.trim()); });
    out.push({ title:(c.querySelector('h3')||{}).textContent||'', texts:texts });
  });
  return out;
})()`;

let bad = 0, total = 0;
function ok(name, cond, extra) { total++; if (cond) console.log('OK   ' + name); else { bad++; console.log('FAIL ' + name + (extra ? ' → ' + extra : '')); } }
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clean = (s) => norm(s).replace('🔒', '').trim();

(async () => {
  await connect();
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const spa = await goto(BASE + '/?page=articles', '#artViewList .artcard').then(() => evalJs(SPA_READ));
  const st = await goto(BASE + '/articles', '#cards .acard').then(() => evalJs(STATIC_READ));

  ok('站内「文章」tab 渲染出卡片', spa.length >= 3, String(spa.length));
  ok('静态 /articles 渲染出卡片', st.length >= 3, String(st.length));

  const byTitle = new Map(st.map((c) => [clean(c.title), c]));
  for (const c of spa) {
    const s = byTitle.get(clean(c.title));
    const label = '《' + clean(c.title).slice(0, 12) + '》';
    if (!s) { ok(label + ' 静态页也有这篇', false); continue; }
    const texts = s.texts.map(norm);
    const catOk = c.cat ? texts.includes(norm(c.cat)) : !texts.some((t) => t && !/\d/.test(t) && !t.includes('分钟') && !t.includes('密码') && !t.includes('加密'));
    ok(label + ' 分类两处一致', catOk, 'tab=' + c.cat + ' static=' + JSON.stringify(texts));
    ok(label + ' 日期两处一致', !!c.date && texts.includes(norm(c.date)), 'tab=' + c.date + ' static=' + JSON.stringify(texts));
    const minsOk = c.mins ? texts.includes(norm(c.mins)) : !texts.some((t) => t.includes('分钟'));
    ok(label + ' 阅读时长两处一致', minsOk, 'tab=' + c.mins + ' static=' + JSON.stringify(texts));
    const lockOk = c.lock ? texts.includes('🔒 需要密码') : !texts.some((t) => t.includes('密码'));
    ok(label + ' 加密标记两处一致', lockOk, 'tab=' + c.lock + ' static=' + JSON.stringify(texts));
  }

  ok('两处都不再出现「旧数据未加密」这种站务黑话', !JSON.stringify(spa).includes('未加密') && !JSON.stringify(st).includes('未加密'), JSON.stringify(st.map((c) => c.texts)));
  ok('静态页卡片已去掉多余标签（分类最多一个）', st.every((c) => c.texts.filter((t) => t && !/\d{4}-/.test(t) && !t.includes('分钟') && !t.includes('密码')).length <= 1), JSON.stringify(st.map((c) => c.texts)));
  ok('SPA 卡片有正文的篇目显示「约 N 分钟」', spa.some((c) => /^约 \d+ 分钟$/.test(norm(c.mins))), JSON.stringify(spa.map((c) => c.mins)));

  // —— 切「分类显示英文」，两边都要跟着变 ——
  const pw = 'dev';
  const body = (catEn) => JSON.stringify({ password: pw, section: 'article', value: { catEn: catEn, unlockHint: '这篇需要密码才能看，问站长要。', categories: [] } });
  const save = await (await fetch(BASE + '/api/site', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(true) })).json();
  ok('能打开「分类显示英文」开关', save.ok === true, JSON.stringify(save).slice(0, 120));
  const spa2 = await goto(BASE + '/?page=articles', '#artViewList .artcard').then(() => evalJs(SPA_READ));
  const st2 = await goto(BASE + '/articles', '#cards .acard').then(() => evalJs(STATIC_READ));
  const spaKeys = spa2.map((c) => norm(c.cat)).filter(Boolean);
  ok('SPA 分类切成英文 key', spaKeys.length > 0 && spaKeys.every((k) => /^[a-z0-9-]+$/.test(k)), JSON.stringify(spaKeys));
  const stKeys = st2.map((c) => norm(c.texts[0] || '')).filter((k) => /^[a-z][a-z0-9-]*$/.test(k)); // 英文 key 必须以字母开头，别把日期 2026-11-25 当分类
  ok('静态页分类也是英文 key', stKeys.length === spaKeys.length && JSON.stringify(stKeys.sort()) === JSON.stringify(spaKeys.slice().sort()), JSON.stringify(stKeys) + ' vs ' + JSON.stringify(spaKeys));
  await fetch(BASE + '/api/site', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(false) });

  console.log(bad === 0 ? '\nALL OK (' + total + ')' : '\n' + bad + '/' + total + ' FAILED');
  ws.close(); chrome.kill();
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR ' + e.message); try { chrome.kill(); } catch (_) {} process.exit(1); });
