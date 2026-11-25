// 前台交互流程门禁：真的去点，验证"点了有没有用"。
// 覆盖：首页榜单/导航标签切换、首页搜索过滤、文章页搜索过滤、文章卡片打开阅读器、
// 文章深链直达、问答页分类 chip 过滤。
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:8123';
// 开跑前清掉 dev-server 里的假边缘缓存，保证看到的是仓库里的真实数据
try { await fetch(BASE + '/__purge'); } catch (e) {}
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
  // ---------- 6) 首页：主题切换（4 套）----------
  await nav(BASE + '/', 3000);
  await ev("document.getElementById('btnSettings').click(); 'ok'");
  await sleep(800);
  const themeChips = await ev("document.querySelectorAll('#themeRow [data-theme-pick]').length");
  await ev("(function(){var b=document.querySelector('#themeRow [data-theme-pick=\"ink\"]'); if(b) b.click(); return 'ok';})()");
  await sleep(700);
  const inkTheme = await ev("JSON.stringify({attr: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor, on: (document.querySelector('#themeRow [data-theme-pick=\"ink\"]')||{}).className || ''})");
  const ink = JSON.parse(inkTheme);
  const isDark = /rgb\((\d+), (\d+), (\d+)\)/.exec(ink.bg || '');
  const darkOk = !!isDark && (+isDark[1] + +isDark[2] + +isDark[3]) < 200;
  check('主题切到 Linear 冷暗', themeChips === 4 && ink.attr === 'ink' && darkOk, `背景 ${ink.bg}，激活态 ${/is-on/.test(ink.on) ? '有' : '无'}`);
  await ev("(function(){var b=document.querySelector('#themeRow [data-theme-pick=\"paper\"]'); if(b) b.click(); return 'ok';})()");
  await sleep(600);
  const backTheme = await ev("document.documentElement.getAttribute('data-theme')");
  check('主题切回暖纸白', backTheme === 'paper', `data-theme=${backTheme}`);

  // ---------- 7) 首页：分页器 ----------
  await nav(BASE + '/', 3000);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const FIRST = "(document.querySelector('#list .item:not(.empty-item) .title, #list .item:not(.empty-item) a')||{}).textContent || ''";
  const pagerShown = await ev("!document.getElementById('pager').hidden");
  const firstA = await ev(FIRST);
  await ev("document.getElementById('next').click(); 'ok'");
  await sleep(1200);
  const firstB = await ev(FIRST);
  const pageInfo = await ev("(document.getElementById('pageInfo')||{}).textContent || ''");
  check('首页下一页', pagerShown === true && firstA !== firstB && String(firstB).length > 0, `${String(firstA).slice(0, 14)} → ${String(firstB).slice(0, 14)}（${pageInfo}）`);
  await ev("document.getElementById('prev').click(); 'ok'");
  await sleep(1200);
  const firstC = await ev(FIRST);
  check('首页上一页回到首项', firstC === firstA, `${String(firstC).slice(0, 14)}`);

  // ---------- 8) 导航页：搜索过滤 ----------
  await nav(BASE + '/nav', 2800);
  const NAV_CARD = "document.querySelectorAll('#navBody .navcard:not(.ad-inline-card)').length";
  const navAll = await ev(NAV_CARD);
  const navKw = await ev("(function(){var c=document.querySelector('#navBody .navcard:not(.ad-inline-card)'); if(!c) return ''; var b=c.querySelector('b'); return (b?b.textContent:'').trim().slice(0,2);})()");
  await ev("(function(){var s=document.getElementById('navSearch'); s.value=" + JSON.stringify(String(navKw)) + "; s.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()");
  await sleep(900);
  const navFiltered = await ev(NAV_CARD);
  const navCount = await ev("(document.getElementById('navCount')||{}).textContent || ''");
  check('导航页搜索过滤', String(navKw).length > 0 && navFiltered > 0 && navFiltered < navAll, `全部 ${navAll} → 搜「${navKw}」${navFiltered} · ${navCount}`);
  await ev("(function(){var s=document.getElementById('navSearch'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()");
  await sleep(800);
  const navBackAll = await ev(NAV_CARD);
  check('导航页清空搜索恢复', navBackAll === navAll, `${navFiltered} → ${navBackAll}（原 ${navAll}）`);

  // ---------- 9) 加锁文章：解锁弹窗 + 错误密码提示 ----------
  // 自己造一篇带锁文章再点，不依赖仓库里恰好有带密文的文章（旧数据可能是"标了锁但没密文"）
  const lockTitle = '__gate__前台加锁';
  const lockPost = async (body) => {
    const r = await fetch(BASE + '/api/articles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch (e) {}
    return j;
  };
  const lockAdd = await lockPost({ password: 'dev', action: 'add', article: { title: lockTitle, summary: '前台门禁用', body: '机密正文-GATE-1', locked: true, password: 'gate-pass-123', category: 'gate' } });
  const lockOne = lockAdd && Array.isArray(lockAdd.articles) ? lockAdd.articles.filter((a) => a && a.title === lockTitle)[0] : null;
  const lockId = lockOne ? lockOne.id : null;

  await nav(BASE + '/articles?v=' + Date.now(), 2800);
  const lockClick = await ev("(function(){var cs=document.querySelectorAll('#cards .acard'); for(var i=0;i<cs.length;i++){ if(/🔒/.test(cs[i].textContent||'')){ cs[i].click(); return 'locked'; } } return 'no locked card';})()");
  await sleep(1200);
  const pwShown = await ev("JSON.stringify({open: !!document.getElementById('pwDlg') && document.getElementById('pwDlg').open, err: (document.getElementById('pwErr')||{}).textContent || ''})");
  const pw = JSON.parse(pwShown);
  await ev("(function(){var i=document.getElementById('pwIn'); i.value='definitely-wrong-pw'; document.getElementById('pwGo').click(); return 'ok';})()");
  await sleep(2200);
  const pwErr = await ev("(document.getElementById('pwErr')||{}).textContent || ''");
  check('加锁文章弹出解锁框', !!lockId && lockClick === 'locked' && pw.open === true, '点击结果 ' + lockClick);
  check('错误密码有提示', String(pwErr).trim().length > 0, '提示「' + String(pwErr).trim().slice(0, 30) + '」');
  await ev("(function(){try{document.getElementById('pwCancel').click();}catch(e){} return 'ok';})()");
  await sleep(600);
  const pwClosed = await ev("!!document.getElementById('pwDlg') && document.getElementById('pwDlg').open");
  check('取消关闭解锁框', pwClosed === false);
  if (lockId) await lockPost({ password: 'dev', action: 'remove', id: lockId });

} finally {
  try { await send('Browser.close'); } catch (e) {}
  proc.kill();
}

const bad = results.filter((r) => !r.ok);
console.log('');
if (bad.length) { console.log(bad.length + ' 个前台流程失败'); process.exit(1); }
console.log('全部前台流程通过（' + results.length + ' 项）');
