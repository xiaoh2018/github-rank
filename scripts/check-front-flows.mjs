// 前台交互流程门禁：真的去点，验证"点了有没有用"。
// 覆盖：首页榜单/导航标签切换、首页搜索过滤、文章页搜索过滤、文章卡片打开阅读器、
// 文章深链直达、问答页分类 chip 过滤。
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:8123';
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9700 + Math.floor(Math.random() * 150);
const dir = 'C:\\Windows\\Temp\\cdpfront' + Date.now();
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((t) => t.type === 'page'); } catch (e) {}
}
if (!target) { console.log('Chrome 起不来，跳过'); process.exit(0); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const send = (m, p) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return '__ERR__' + (r.result.exceptionDetails.text || '');
  return r.result && r.result.result ? r.result.result.value : null;
};
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok }); console.log((ok ? 'OK    ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); };
const nav = async (url, wait) => { await send('Page.navigate', { url }); await sleep(wait || 2600); };

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // ---------- 1) 首页：榜单 ↔ 导航 标签 ----------
  await nav(BASE + '/', 3000);
  const before = await ev("JSON.stringify({rank: document.getElementById('rank').hidden, nav: document.getElementById('navView').hidden})");
  await ev("document.getElementById('tabNav').click(); 'ok'");
  await sleep(1400);
  const afterNav = await ev("JSON.stringify({rank: document.getElementById('rank').hidden, nav: document.getElementById('navView').hidden, cards: document.querySelectorAll('#navBody .navcard').length})");
  await ev("document.getElementById('tabRank').click(); 'ok'");
  await sleep(900);
  const afterBack = await ev("JSON.stringify({rank: document.getElementById('rank').hidden, nav: document.getElementById('navView').hidden})");
  const b = JSON.parse(before), n = JSON.parse(afterNav), k = JSON.parse(afterBack);
  check('首页切到导航', n.rank === true && n.nav === false && n.cards > 0, `导航卡片 ${n.cards} 张`);
  check('首页切回榜单', k.rank === false && k.nav === true, `初始 ${JSON.stringify(b)}`);

  // ---------- 2) 首页：搜索过滤 ----------
  const ITEM_N = "document.querySelectorAll('#list .item:not(.empty-item)').length";
  const totalItems = await ev(ITEM_N);
  await ev("(function(){var q=document.getElementById('q'); q.value='zzz-不存在-zzz'; q.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()");
  await sleep(1200);
  const filtered = await ev("JSON.stringify({items: document.querySelectorAll('#list .item:not(.empty-item)').length, empty: !!document.querySelector('#list .empty-item')})");
  const f = JSON.parse(filtered);
  check('首页搜索过滤', totalItems > 0 && f.items === 0 && f.empty === true, `全部 ${totalItems} → ${f.items}（空态卡 ${f.empty}）`);
  await ev("(function(){var q=document.getElementById('q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()");
  await sleep(900);
  const restored = await ev(ITEM_N);
  check('清空搜索后恢复列表', restored === totalItems, `${f.items} → ${restored}（原 ${totalItems}）`);

  // ---------- 3) 文章页：搜索 + 打开阅读器 ----------
  await nav(BASE + '/articles', 2800);
  const cardsAll = await ev("document.querySelectorAll('#cards .acard').length");
  // 用第一张卡片标题里的两个字当关键词，保证一定能命中
  const kw = await ev("(function(){var a=document.querySelector('#cards .acard'); if(!a) return ''; var t=(a.querySelector('h3,h2,.atitle')||a).textContent||''; return t.replace(/[\\s\\uD800-\\uDFFF]/g,'').slice(0,2);})()");
  await ev("(function(){var s=document.getElementById('search'); s.value=" + JSON.stringify(String(kw)) + "; s.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()");
  await sleep(1000);
  const cardsOne = await ev("document.querySelectorAll('#cards .acard').length");
  check('文章页搜索过滤', String(kw).length > 0 && cardsOne >= 1 && cardsOne < cardsAll, `全部 ${cardsAll} → 搜「${kw}」${cardsOne}`);

  // 清空搜索，再点第一张卡片
  await ev("(function(){var s=document.getElementById('search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()");
  await sleep(900);
  const cardsBack = await ev("document.querySelectorAll('#cards .acard').length");
  check('清空搜索后恢复卡片', cardsBack === cardsAll, `${cardsOne} → ${cardsBack}（原 ${cardsAll}）`);
  await ev("(function(){var a=document.querySelector('#cards .acard'); if(!a) return 'no card'; a.click(); return 'ok';})()");
  await sleep(1600);
  const reader = await ev("JSON.stringify({hidden: document.getElementById('reader').hidden, title: (document.getElementById('rTitle')||document.querySelector('#reader h1')||{}).textContent || ''})");
  const rd = JSON.parse(reader);
  check('文章卡片打开阅读器', rd.hidden === false && String(rd.title).length > 0, `标题「${String(rd.title).slice(0, 20)}」`);

  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'ok'");
  await sleep(900);
  const closed = await ev("JSON.stringify({hidden: document.getElementById('reader').hidden})");
  check('Esc 关闭阅读器', JSON.parse(closed).hidden === true);

  // ---------- 4) 文章深链直达 ----------
  await nav(BASE + '/articles/tech/4.html', 3000);
  const deep = await ev("JSON.stringify({hidden: document.getElementById('reader').hidden, title: (document.getElementById('rTitle')||document.querySelector('#reader h1')||{}).textContent || ''})");
  const dp = JSON.parse(deep);
  check('文章深链直达', dp.hidden === false && /目录高亮验证/.test(String(dp.title)), `标题「${String(dp.title).slice(0, 20)}」`);

  // ---------- 5) 问答页：分类 chip 过滤 ----------
  await nav(BASE + '/faq', 2600);
  const qaAll = await ev("document.querySelectorAll('#list details.qa').length");
  const chipTags = await ev("Array.prototype.map.call(document.querySelectorAll('#tags .chip[data-tag]'), function(c){return c.getAttribute('data-tag');}).join(',')");
  const target = String(chipTags).split(',').find((x) => x && x !== 'all') || '';
  if (!target) {
    check('问答分类过滤', false, '没有分类 chip');
  } else {
    await ev("(function(){var c=document.querySelector('#tags .chip[data-tag=\"' + " + JSON.stringify(target) + " + '\"]'); if(!c) return 'no chip'; c.click(); return 'ok';})()");
    await sleep(800);
    const qaFiltered = await ev("document.querySelectorAll('#list details.qa').length");
    await ev("(function(){var c=document.querySelector('#tags .chip[data-tag=\"all\"]'); if(c) c.click(); return 'ok';})()");
    await sleep(700);
    const qaBack = await ev("document.querySelectorAll('#list details.qa').length");
    check('问答分类过滤', qaFiltered > 0 && qaFiltered < qaAll && qaBack === qaAll, `全部 ${qaAll} → 「${target}」${qaFiltered} → 全部 ${qaBack}`);
  }
} finally {
  try { await send('Browser.close'); } catch (e) {}
  proc.kill();
}

const bad = results.filter((r) => !r.ok);
console.log('');
if (bad.length) { console.log(bad.length + ' 个前台流程失败'); process.exit(1); }
console.log('全部前台流程通过（' + results.length + ' 项）');
