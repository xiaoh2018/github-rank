import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const PORT = 10400 + Math.floor(Math.random() * 60);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'artcols-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } }; return; }
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('CDP 连不上');
}
const send = (method, params = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); }); };
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('EXC ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200)); return r.result && r.result.value; };
async function waitFor(expr, ms = 25000) { for (let t = 0; t < ms; t += 150) { try { if (await ev(expr)) return true; } catch (e) {} await sleep(150); } return false; }
async function view(w, h) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }); }
async function goto(url) { await send('Page.navigate', { url }); await sleep(1200); }

const rows = [];
function chk(name, ok, extra) { rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : JSON.stringify(extra) }); }

const siteUrl = BASE + '/data/site.json';
const orig = await (await fetch(siteUrl + '?v=' + Date.now())).json();
const origArticle = orig.article || {};

async function setCols(v) {
  const body = { password: 'dev', section: 'article', value: { unlockHint: origArticle.unlockHint || '', catEn: !!origArticle.catEn, cols: v, categories: origArticle.categories || [] } };
  const r = await fetch(BASE + '/api/site', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function colsOfHome() {
  await goto(BASE + '/?t=' + Date.now());
  const ok = await waitFor("document.querySelectorAll('.artgrid .artcard').length>0");
  if (!ok) return { ok: false, n: 0, attr: '' };
  const n = await ev("(function(){var g=document.querySelector('.artgrid');if(!g)return 0;return getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length;})()");
  const attr = await ev("document.body.getAttribute('data-artcols')||''");
  return { ok: true, n, attr };
}
async function colsOfArticles() {
  await goto(BASE + '/articles?t=' + Date.now());
  const ok = await waitFor("document.querySelectorAll('.cards .acard').length>0");
  if (!ok) return { ok: false, n: 0, attr: '' };
  const n = await ev("(function(){var g=document.querySelector('.cards');if(!g)return 0;var cs=getComputedStyle(g);if(cs.display!=='grid')return 1;return cs.gridTemplateColumns.split(' ').filter(Boolean).length;})()");
  const attr = await ev("document.documentElement.getAttribute('data-artcols')||''");
  return { ok: true, n, attr };
}

(async () => {
  await connect(); await send('Page.enable'); await send('Runtime.enable');
  await view(1440, 1000);

  const r0 = await setCols('single');
  chk('保存 single 成功', r0.status === 200 && r0.json.ok === true, r0.status);
  let h = await colsOfHome();
  chk('首页 单列：data-artcols=single', h.attr === 'single', h.attr);
  chk('首页 单列：实际 1 栏', h.n === 1, h.n);
  let a = await colsOfArticles();
  chk('文章页 单列：1 栏', a.n === 1, a);

  const r1 = await setCols('double');
  chk('保存 double 成功', r1.status === 200 && r1.json.ok === true);
  h = await colsOfHome();
  chk('首页 双列：实际 2 栏', h.n === 2, h.n);
  a = await colsOfArticles();
  chk('文章页 双列：实际 2 栏', a.n === 2, a);

  const r2 = await setCols('triple');
  chk('保存 triple 成功', r2.status === 200 && r2.json.ok === true);
  h = await colsOfHome();
  chk('首页 三列：实际 3 栏', h.n === 3, h.n);
  a = await colsOfArticles();
  chk('文章页 三列：实际 3 栏', a.n === 3, a);

  const r3 = await setCols('auto');
  chk('保存 auto 成功', r3.status === 200 && r3.json.ok === true);
  h = await colsOfHome();
  chk('首页 自动：≥2 栏', h.n >= 2, h.n);

  await view(390, 844);
  const r4 = await setCols('triple');
  chk('保存 triple（手机前）', r4.status === 200);
  h = await colsOfHome();
  chk('390 下即使是三列也只 1 栏', h.n === 1, h.n);
  a = await colsOfArticles();
  chk('390 文章页 1 栏', a.n === 1, a);

  const adm = await (await fetch(BASE + '/admin?v=' + Date.now())).text();
  chk('后台有 4 个列数选项', (adm.split('type="radio" name="article-cols"').length - 1) === 4, adm.split('type="radio" name="article-cols"').length - 1);
  chk('后台读取列数（collect 里有 acols）', adm.includes("name=\"article-cols\"") && adm.includes("'double'") && adm.includes('acols'));
  chk('后台保存后回填选中项', adm.includes('acR[aci].checked'));

  const bad = await setCols('quad');
  chk('非法值被拒 400', bad.status === 400, bad.status);
  chk('拒绝原因说清可选值', String((bad.json && bad.json.error) || '').indexOf('auto、single、double 或 triple') >= 0, (bad.json && bad.json.error) || '');

  const back = await setCols(origArticle.cols || 'double');
  chk('还原原值', back.status === 200);

  const badCnt = rows.filter((r) => !r.ok).length;
  for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
  console.log(badCnt === 0 ? 'ALL OK (' + rows.length + ')' : badCnt + ' FAILED of ' + rows.length);
  try { ws.close(); } catch (e) {}
  chrome.kill();
  process.exit(badCnt === 0 ? 0 : 1);
})().catch((err) => { console.error('ERROR ' + err.message); try { chrome.kill(); } catch (e) {} process.exit(1); });
