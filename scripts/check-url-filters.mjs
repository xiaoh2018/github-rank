// 门禁：筛选状态（分类/关键词/排序/标签）要写进 URL，并能从 URL 还原
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
function pass(name, cond, extra) { if (cond) { ok++; console.log('  PASS  ' + name); } else { bad++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); } }

const port = 10000 + Math.floor(Math.random() * 90);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-urlf-'));
const child = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });

let tg;
for (let i = 0; i < 60 && !tg; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); tg = l.find((x) => x.type === 'page'); } catch {}
  if (!tg) await sleep(250);
}
if (!tg) { console.log('Chrome 没起来'); process.exit(1); }
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let n = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => { const i = ++n; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pend.set(i, r)); };
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description));
  return r.result && r.result.result && r.result.result.value;
}
const clean = (u) => u.replace(/[?&]v=\d+/g, '').replace(/^\?/, '');
const search = () => evalJs('location.search');

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

  // ---------- /articles ----------
  await send('Page.navigate', { url: base + '/articles' });
  await sleep(2200);
  pass('文章页默认不带筛选参数', !/[?&](cat|q|sort|page)=/.test(await search()), await search());

  // 点「技术」分类
  const cats = await evalJs('[...document.querySelectorAll("#chips .chip")].map(function(b){return b.getAttribute("data-cat")})');
  const pickCat = cats.find((c) => c && c !== 'all');
  await evalJs('document.querySelector(\'#chips .chip[data-cat="' + pickCat + '"]\').click()');
  await sleep(600);
  const afterCat = await evalJs('({ s: location.search, rows: document.querySelectorAll("#cards .acard").length, on: (document.querySelector("#chips .chip.is-on") || {}).getAttribute && document.querySelector("#chips .chip.is-on").getAttribute("data-cat") })');
  pass('点分类写进 URL', clean(afterCat.s).indexOf('cat=') >= 0, afterCat.s);
  pass('点分类后列表只剩该分类', afterCat.rows > 0 && afterCat.on === pickCat, JSON.stringify(afterCat));
  // 关键词要用「该分类里真有的词」，否则 cat+q 的组合天然是 0 条（那是正确行为，不是 bug）
  var kw = await evalJs('(function(){var t=(document.querySelector("#cards .acard .atitle")||document.querySelector("#cards .acard h3")||{textContent:""}).textContent.trim(); return t ? t.slice(0,2) : "文章";})()');

  // 关键词 + 排序
  await evalJs('(function(){var s=document.getElementById("search"); s.value=' + JSON.stringify(kw) + '; s.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(600);
  pass('搜索词写进 URL', clean(await search()).indexOf('q=') >= 0, await search());
  await evalJs('(function(){var s=document.getElementById("sort"); s.value="title"; s.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await sleep(500);
  pass('排序写进 URL', clean(await search()).indexOf('sort=title') >= 0, await search());

  // 直接访问带参数的地址：三项都要还原
  const target = '/articles?cat=' + encodeURIComponent(pickCat) + '&q=' + encodeURIComponent(kw) + '&sort=title';
  await send('Page.navigate', { url: base + target });
  await sleep(2200);
  const restored = await evalJs('({ cat: (document.querySelector("#chips .chip.is-on") || {}).getAttribute && document.querySelector("#chips .chip.is-on").getAttribute("data-cat"), q: (document.getElementById("search") || {}).value, sort: (document.getElementById("sort") || {}).value, rows: document.querySelectorAll("#cards .acard").length })');
  pass('从 URL 还原分类', restored.cat === pickCat, JSON.stringify(restored));
  pass('从 URL 还原关键词', restored.q === kw, restored.q + ' vs ' + kw);
  pass('从 URL 还原排序', restored.sort === 'title', restored.sort);
  pass('还原后列表按筛选渲染', restored.rows >= 1, 'rows=' + restored.rows);

  // 后退：URL 与列表要跟着回到上一步（改排序前）
  await evalJs('history.back()');
  await sleep(1200);
  const back = await evalJs('({ s: location.search, sort: (document.getElementById("sort") || {}).value })');
  pass('后退能回退筛选状态', clean(back.s).indexOf('sort=title') < 0 && back.sort !== 'title', JSON.stringify(back));

  // ---------- /faq ----------
  await send('Page.navigate', { url: base + '/faq' });
  await sleep(2200);
  const tags = await evalJs('[...document.querySelectorAll("#tags .chip")].map(function(b){return b.getAttribute("data-tag")})');
  const pickTag = tags.find((t) => t && t !== 'all');
  await evalJs('document.querySelector(\'#tags .chip[data-tag="' + pickTag + '"]\').click()');
  await sleep(600);
  const tagUrl = await evalJs('({ s: location.search, on: (document.querySelector("#tags .chip.is-on") || {}).getAttribute && document.querySelector("#tags .chip.is-on").getAttribute("data-tag"), rows: document.querySelectorAll("#list details.qa").length })');
  pass('问答标签写进 URL', clean(tagUrl.s).indexOf('tag=') >= 0, tagUrl.s);
  pass('标签高亮生效', tagUrl.on === pickTag, JSON.stringify(tagUrl));

  await evalJs('(function(){var q=document.getElementById("q"); q.value="cron"; q.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(600);
  pass('问答关键词写进 URL', clean(await search()).indexOf('q=cron') >= 0, await search());

  // 直达组合
  await send('Page.navigate', { url: base + '/faq?tag=' + encodeURIComponent(pickTag) + '&q=cron' });
  await sleep(2200);
  const faqRestored = await evalJs('({ on: (document.querySelector("#tags .chip.is-on") || {}).getAttribute && document.querySelector("#tags .chip.is-on").getAttribute("data-tag"), q: (document.getElementById("q") || {}).value, count: (document.getElementById("count") || {}).textContent })');
  pass('问答从 URL 还原标签与关键词', faqRestored.on === pickTag && faqRestored.q === 'cron', JSON.stringify(faqRestored));

  // 清空搜索后 URL 去掉 q
  await evalJs('(function(){var q=document.getElementById("q"); q.value=""; q.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(600);
  pass('清空关键词后 URL 去掉 q 参数', clean(await search()).indexOf('q=') < 0, await search());
} finally {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过（' + ok + ' 项）');
process.exit(bad ? 1 : 0);
