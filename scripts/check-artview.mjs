// 门禁：文章做成页内 tab（不整页跳转）+ 文章页去掉统计卡与「关于本站」技术文案
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function session(width, height) {
  const port = 9930 + Math.floor(Math.random() * 40);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-artv-'));
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
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: !!mobile });
  return { ws, child, send, evalJs };
}
let mobile = false;

const arts = JSON.parse(fs.readFileSync('data/articles.json', 'utf8'));
const artList = Array.isArray(arts) ? arts : (arts.articles || []);
const expectCards = artList.filter((a) => a && a.title).length;

// ---------- 1) 桌面：点 tab 页内切换，不整页跳转 ----------
{
  const s = await session(1440, 900);
  await s.send('Page.navigate', { url: BASE + '/' });
  await sleep(2600);
  const before = await s.evalJs(`(function(){
    return { artHidden: document.getElementById('artView').hidden, rankHidden: document.getElementById('rank').hidden };
  })()`);
  push('初始在榜单视图（artView 隐藏）', before.artHidden === true && before.rankHidden === false, JSON.stringify(before));

  // 打标记：整页跳转会丢掉这个变量
  await s.evalJs("window.__noReload=1;");
  await s.evalJs("document.getElementById('tabArticles').click();");
  await sleep(900);
  const after = await s.evalJs(`(function(){
    var av=document.getElementById('artView'), rk=document.getElementById('rank');
    var t=document.getElementById('tabArticles'), tr=document.getElementById('tabRank');
    return {
      stillSameDocument: window.__noReload===1,
      artHidden: av.hidden, rankHidden: rk.hidden,
      url: location.pathname + location.search,
      artSel: t.getAttribute('aria-selected'), rankSel: tr.getAttribute('aria-selected'),
      onClass: t.classList.contains('is-on'),
      cards: document.querySelectorAll('#artViewList .artcard').length,
      hrefs: Array.prototype.map.call(document.querySelectorAll('#artViewList .artcard h3 a'), function(a){ return a.getAttribute('href'); })
    };
  })()`);
  push('点「文章」不整页跳转（同一文档）', after.stillSameDocument === true, JSON.stringify({ same: after.stillSameDocument }));
  push('文章视图显示、榜单视图隐藏', after.artHidden === false && after.rankHidden === true, JSON.stringify({ art: after.artHidden, rank: after.rankHidden }));
  push('URL 变成 ?page=articles', /page=articles/.test(after.url), after.url);
  push('tab 选中态跟着切（aria-selected + is-on）', after.artSel === 'true' && after.rankSel === 'false' && after.onClass, JSON.stringify({ art: after.artSel, rank: after.rankSel }));

  const chrome = await s.evalJs(`(function(){
    function vis(el){ if(!el) return null; var r=el.getBoundingClientRect(); return { d:getComputedStyle(el).display, h:Math.round(r.height) }; }
    return { rb: vis(document.getElementById('rankBar')), st: vis(document.getElementById('stats')) };
  })()`);
  push('文章视图里榜单工具栏与统计卡不显示', chrome.rb && chrome.rb.d === 'none' && chrome.st && chrome.st.d === 'none', JSON.stringify(chrome));
  push('渲染出全部文章卡', after.cards === expectCards, after.cards + ' / ' + expectCards);
  push('卡片链接是规范地址 /articles/….html', after.hrefs.length > 0 && after.hrefs.every((h) => /^\/articles\/.+\.html$/.test(h)), after.hrefs.slice(0, 2).join(' '));

  // 搜索过滤
  await s.evalJs("(function(){var i=document.getElementById('artSearch'); i.value='目录'; i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await sleep(500);
  const q1 = await s.evalJs("document.querySelectorAll('#artViewList .artcard').length");
  push('搜索生效（关键词缩小到 1 张）', q1 === 1, String(q1));
  await s.evalJs("(function(){var i=document.getElementById('artSearch'); i.value='zzzznotexist'; i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await sleep(500);
  const q0 = await s.evalJs("(function(){return {cards:document.querySelectorAll('#artViewList .artcard').length, empty:!!document.querySelector('#artViewList .empty')};})()");
  push('无结果给空态卡', q0.cards === 0 && q0.empty === true, JSON.stringify(q0));
  await s.evalJs("(function(){var i=document.getElementById('artSearch'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await sleep(400);

  // 分类 chip
  const chipInfo = await s.evalJs(`(function(){
    var chips=document.querySelectorAll('#artChips .chip');
    return { n: chips.length, labels: Array.prototype.map.call(chips, function(c){ return c.textContent.trim(); }) };
  })()`);
  push('分类胶囊存在（全部 + 各分类）', chipInfo.n >= 2 && chipInfo.labels[0] === '全部', JSON.stringify(chipInfo.labels));
  await s.evalJs("(function(){var c=document.querySelector('#artChips [data-artcat=\"技术\"]'); if(c) c.click();})()");
  await sleep(400);
  const byCat = await s.evalJs("document.querySelectorAll('#artViewList .artcard').length");
  push('点分类后只剩该分类文章', byCat === 1, String(byCat));
  await s.evalJs("(function(){var c=document.querySelector('#artChips [data-artcat=\"all\"]'); if(c) c.click();})()");
  await sleep(400);
  const backAll = await s.evalJs("document.querySelectorAll('#artViewList .artcard').length");
  push('点「全部」恢复', backAll === expectCards, String(backAll));

  // 排序下拉
  await s.evalJs("(function(){var s=document.getElementById('artSort'); s.value='old'; s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await sleep(400);
  const sorted = await s.evalJs("document.querySelectorAll('#artViewList .artcard').length");
  push('切换排序不丢卡片', sorted === expectCards, String(sorted));

  // 回到榜单再点「全部文章 →」也能进文章视图
  await s.evalJs("document.getElementById('tabRank').click();");
  await sleep(600);
  await s.evalJs("window.__noReload2=1; document.getElementById('artMore').click();");
  await sleep(700);
  const viaMore = await s.evalJs("(function(){return {same:window.__noReload2===1, hidden:document.getElementById('artView').hidden};})()");
  push('首页「全部文章 →」也走页内切换', viaMore.same === true && viaMore.hidden === false, JSON.stringify(viaMore));

  await s.evalJs("document.getElementById('tabRank').click();");
  await sleep(700);
  const back = await s.evalJs("(function(){var rb=document.getElementById('rankBar');return {d:getComputedStyle(rb).display, rankHidden:document.getElementById('rank').hidden, artHidden:document.getElementById('artView').hidden};})()");
  push('切回榜单后工具栏恢复、文章视图收起', back.d !== 'none' && back.rankHidden === false && back.artHidden === true, JSON.stringify(back));

  // 直接访问 ?page=articles
  await s.send('Page.navigate', { url: BASE + '/?page=articles' });
  await sleep(2400);
  const deep = await s.evalJs("(function(){return {hidden:document.getElementById('artView').hidden, cards:document.querySelectorAll('#artViewList .artcard').length, sel:document.getElementById('tabArticles').getAttribute('aria-selected')};})()");
  push('?page=articles 直达即文章视图', deep.hidden === false && deep.cards === expectCards && deep.sel === 'true', JSON.stringify(deep));

  s.ws.close(); try { s.child.kill(); } catch {}
}

// ---------- 2) 移动端 320：文章视图单列、不横向溢出 ----------
{
  mobile = true;
  const s = await session(320, 720);
  await s.send('Page.navigate', { url: BASE + '/?page=articles' });
  await sleep(2600);
  const m = await s.evalJs(`(function(){
    var doc=document.documentElement, cards=document.querySelectorAll('#artViewList .artcard');
    // 单列 = 所有卡片左缘对齐（只有一种 left），且纵向依次往下（top 递增）
    var lefts={}, tops=[];
    Array.prototype.forEach.call(cards, function(c){ var r=c.getBoundingClientRect(); lefts[Math.round(r.left)]=1; tops.push(Math.round(r.top)); });
    var cols=Object.keys(lefts).length;
    var stackOk=true;
    for(var i=1;i<tops.length;i++){ if(tops[i]<=tops[i-1]) stackOk=false; }
    var bar=document.querySelector('.artvbar').getBoundingClientRect();
    var input=document.getElementById('artSearch').getBoundingClientRect();
    return { sw: doc.scrollWidth, cw: doc.clientWidth, cards: cards.length, cols: cols,
             inputW: Math.round(input.width), barW: Math.round(bar.width), inputH: Math.round(input.height), fs: getComputedStyle(document.getElementById('artSearch')).fontSize };
  })()`);
  push('320 下文章视图不横向溢出', m.sw <= m.cw + 1, m.sw + ' / ' + m.cw);
  push('320 下卡片单列', m.cards > 0 && m.cols === 1, JSON.stringify({ cards: m.cards, cols: m.cols }));
  push('320 下搜索框撑满且 16px/44px', m.inputW >= m.barW - 2 && parseFloat(m.fs) >= 16 && m.inputH >= 40, JSON.stringify({ inputW: m.inputW, barW: m.barW, fs: m.fs, h: m.inputH }));
  s.ws.close(); try { s.child.kill(); } catch {}
  mobile = false;
}

// ---------- 3) /articles 页面：统计卡与「关于本站」技术文案已删除 ----------
{
  const html = await (await fetch(BASE + '/articles', { cache: 'no-store' })).text();
  push('/articles 没有「篇文章」统计卡', !/id="stCount"/.test(html) && !/class="bstats"/.test(html), '');
  push('/articles 没有「关于本站」技术文案', !/id="aboutText"/.test(html) && !/Cloudflare Worker 的折腾记录/.test(html), '');
  push('/articles hero 文案已改成读者口径', /站长写的一些记录，按时间倒序/.test(html), '');
  push('/articles 侧栏「站内」三链接', /项目榜单/.test(html) && /常用站点/.test(html) && /常见问题/.test(html), '');
}

const bad = rows.filter((r) => !r.ok);
for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  → ' + r.extra : ''));
console.log('\n' + (bad.length ? bad.length + ' 项失败 / 共 ' + rows.length : '全部通过（' + rows.length + ' 项）'));
process.exit(bad.length ? 1 : 0);
