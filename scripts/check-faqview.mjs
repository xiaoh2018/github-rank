// 门禁：问答做成页内 tab（不整页跳转）+ 搜索/标签筛选 + 直达 ?page=faq + 320 不溢出
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const qaJson = JSON.parse(fs.readFileSync('data/qa.json', 'utf8'));
const qaItems = Array.isArray(qaJson) ? qaJson : (qaJson.items || []);
const qaCount = qaItems.filter((x) => x && x.q).length;

async function session(width, height) {
  const port = 9970 + Math.floor(Math.random() * 40);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-faqv-'));
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' });
  const wsUrl = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        const page = list.find((t) => t.type === 'page');
        if (page) return page.webSocketDebuggerUrl;
      } catch {}
      await sleep(250);
    }
    throw new Error('chrome not ready');
  })();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waits = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + expr.slice(0, 120));
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 500 });
  return { ws, child, send, evalJs };
}

// ---------- 1) 桌面：点「问答」页内切换 ----------
{
  const s = await session(1440, 900);
  await s.send('Page.navigate', { url: BASE + '/' });
  await sleep(2600);

  const before = await s.evalJs(`(function(){
    var fv=document.getElementById('faqView');
    return { faqHidden: fv ? fv.hidden : null, rankHidden: document.getElementById('rank').hidden, hasTab: !!document.getElementById('tabFaq') };
  })()`);
  push('顶栏有「问答」tab 按钮', before.hasTab === true, JSON.stringify(before));
  push('初始在榜单视图（问答视图隐藏）', before.faqHidden === true && before.rankHidden === false, JSON.stringify(before));

  await s.evalJs('window.__noReload=1;');
  await s.evalJs("document.getElementById('tabFaq').click();");
  await sleep(900);

  const after = await s.evalJs(`(function(){
    var fv=document.getElementById('faqView'), rk=document.getElementById('rank');
    var t=document.getElementById('tabFaq'), tr=document.getElementById('tabRank');
    var rb=document.getElementById('rankBar');
    var items=document.querySelectorAll('#faqList details.qa');
    return {
      sameDoc: window.__noReload===1,
      faqHidden: fv.hidden, rankHidden: rk.hidden,
      page: document.body.getAttribute('data-page'),
      url: location.pathname + location.search,
      faqSel: t.getAttribute('aria-selected'), on: t.classList.contains('is-on'), rankSel: tr.getAttribute('aria-selected'),
      rankBarDisplay: rb ? getComputedStyle(rb).display : 'n/a',
      count: items.length,
      firstOpen: items.length ? items[0].hasAttribute('open') : null,
      qtags: Array.prototype.map.call(items, function(d){ var x=d.querySelector('.qtag'); return x?x.textContent.trim():''; })
    };
  })()`);
  push('点「问答」不整页跳转（同一文档）', after.sameDoc === true, '');
  push('问答视图显示、榜单隐藏', after.faqHidden === false && after.rankHidden === true, JSON.stringify({ faqHidden: after.faqHidden, rankHidden: after.rankHidden }));
  push('body[data-page=faq]', after.page === 'faq', after.page);
  push('地址变成 /?page=faq', /page=faq/.test(after.url || ''), after.url);
  push('tab 高亮与 aria-selected 同步', after.on === true && after.faqSel === 'true' && after.rankSel === 'false', JSON.stringify({ on: after.on, faqSel: after.faqSel, rankSel: after.rankSel }));
  push('问答视图里榜单工具栏不显示', after.rankBarDisplay === 'none', after.rankBarDisplay);
  push('条目数与 data/qa.json 一致', after.count === qaCount, '页面 ' + after.count + ' / 数据 ' + qaCount);
  push('第一条默认展开', after.firstOpen === true, String(after.firstOpen));

  // 搜索
  await s.evalJs(`(function(){ var i=document.getElementById('faqSearch'); i.value='更新'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(400);
  const searched = await s.evalJs(`(function(){
    var items=document.querySelectorAll('#faqList details.qa');
    return { count: items.length, texts: Array.prototype.map.call(items, function(d){
      var q=d.querySelector('.qtext'), a=d.querySelector('.ans');
      return (q?q.textContent:'') + '｜' + (a?a.textContent:'');
    }) };
  })()`);
  push('搜索能过滤（结果变少且命中）', searched.count > 0 && searched.count < qaCount, searched.count + ' / ' + qaCount);
  push('搜索结果的问题或答案里带关键词', searched.texts.every((t) => t.indexOf('更新') >= 0), JSON.stringify(searched.texts.map((t) => t.slice(0, 18))));

  // 清空 + 标签筛选
  await s.evalJs(`(function(){ var i=document.getElementById('faqSearch'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(300);
  const chipInfo = await s.evalJs(`(function(){
    var c=document.querySelector('#faqChips [data-faqtag="收录"]');
    if(!c) return { has:false };
    c.click(); return { has:true };
  })()`);
  await sleep(300);
  const chipRes = await s.evalJs(`(function(){
    var items=document.querySelectorAll('#faqList details.qa');
    return { count: items.length, qtags: Array.prototype.map.call(items, function(d){ var x=d.querySelector('.qtag'); return x?x.textContent.trim():''; }) };
  })()`);
  push('标签胶囊「收录」存在且能点', chipInfo.has === true, '');
  push('标签筛选后只剩该标签', chipRes.count > 0 && chipRes.qtags.every((t) => t === '收录'), chipRes.count + ' 条：' + JSON.stringify(chipRes.qtags));

  // 切到文章、再回榜单
  await s.evalJs("document.getElementById('tabArticles').click();");
  await sleep(900);
  const toArt = await s.evalJs(`(function(){ return { faqHidden: document.getElementById('faqView').hidden, artHidden: document.getElementById('artView').hidden, url: location.pathname + location.search }; })()`);
  push('点「文章」切到文章视图', toArt.faqHidden === true && toArt.artHidden === false && /page=articles/.test(toArt.url), JSON.stringify(toArt));

  await s.evalJs("document.getElementById('tabRank').click();");
  await sleep(600);
  const backRank = await s.evalJs(`(function(){ return { rankHidden: document.getElementById('rank').hidden, url: location.pathname + location.search }; })()`);
  push('点「榜单」回到榜单视图', backRank.rankHidden === false && !/page=/.test(backRank.url), JSON.stringify(backRank));

  s.ws.close();
  try { s.child.kill(); } catch {}
}

// ---------- 2) 直达 ?page=faq ----------
{
  const s = await session(1440, 900);
  await s.send('Page.navigate', { url: BASE + '/?page=faq' });
  await sleep(2800);
  const direct = await s.evalJs(`(function(){
    var fv=document.getElementById('faqView');
    return { faqHidden: fv ? fv.hidden : null, page: document.body.getAttribute('data-page'), count: document.querySelectorAll('#faqList details.qa').length };
  })()`);
  push('直达 /?page=faq 落在问答视图', direct.faqHidden === false && direct.page === 'faq' && direct.count > 0, JSON.stringify(direct));
  s.ws.close();
  try { s.child.kill(); } catch {}
}

// ---------- 3) 320 宽不横向溢出 ----------
{
  const s = await session(320, 720);
  await s.send('Page.navigate', { url: BASE + '/?page=faq' });
  await sleep(2800);
  const narrow = await s.evalJs(`(function(){
    var d=document.documentElement;
    var items=document.querySelectorAll('#faqList details.qa');
    var sum=items[0]?items[0].querySelector('summary'):null;
    return { sw: d.scrollWidth, cw: d.clientWidth, count: items.length, sumH: sum ? Math.round(sum.getBoundingClientRect().height) : 0 };
  })()`);
  push('320 宽不横向溢出', narrow.sw <= narrow.cw + 1, narrow.sw + ' / ' + narrow.cw);
  push('320 宽条目正常渲染（≥3 条、行高 ≥40）', narrow.count >= 3 && narrow.sumH >= 40, narrow.count + ' 条，行高 ' + narrow.sumH);
  s.ws.close();
  try { s.child.kill(); } catch {}
}

// ---------- 4) /faq 静态页顶栏指向站内视图 ----------
{
  const faqHtml = fs.readFileSync('faq.html', 'utf8');
  push('/faq 顶栏「问答」指向 /?page=faq', faqHtml.includes('href="/?page=faq"'), '');
  push('/faq 顶栏「文章」指向 /?page=articles', faqHtml.includes('href="/?page=articles"'), '');
  push('/faq 顶栏「导航」指向 /?page=nav', faqHtml.includes('href="/?page=nav"'), '');
}

const bad = rows.filter((r) => !r.ok);
for (const r of rows) console.log((r.ok ? 'OK  ' : 'FAIL') + ' ' + r.name + (r.extra ? ' → ' + r.extra : ''));
console.log(bad.length ? `\n${bad.length} FAILED / ${rows.length}` : `\nALL OK (${rows.length})`);
process.exit(bad.length ? 1 : 0);
