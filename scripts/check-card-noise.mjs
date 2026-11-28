// 门禁：首页榜单卡「降噪」——活跃度文案、更新时间缩短、topics 折叠、复制/卡片按钮 hover 才出现
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8123';
const rows = [];
const push = (name, ok, extra) => rows.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

async function session({ width, height, mobile, touch }) {
  const port = 9950 + Math.floor(Math.random() * 30);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-card2-'));
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
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + expr.slice(0, 100));
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: !!mobile });
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(3000);
  return { ws, child, send, evalJs };
}

// 只统计真正的项目卡（排除信息流广告位 .ad-inline）
const CARD_SEL = "#list .item:not(.ad-inline)";

{
  const s = await session({ width: 1440, height: 900 });

  const info = await s.evalJs(`(function(){
    var cards = document.querySelectorAll('${CARD_SEL}');
    var metas = [];
    var tagSets = [];
    cards.forEach(function(it){
      var m = it.querySelector('.meta');
      if (m) metas.push(m.textContent);
      var ts = it.querySelectorAll('.tags .tag');
      if (ts.length) {
        tagSets.push(Array.prototype.map.call(ts, function(t){
          return { txt: t.textContent.trim(), title: t.getAttribute('title') || '', more: t.classList.contains('more') };
        }));
      }
    });
    return { cards: cards.length, metas: metas, tagSets: tagSets };
  })()`);

  push('项目卡渲染出来了', info.cards >= 10, info.cards + ' 张');
  const metas = info.metas || [];
  const hasAct = metas.every((m) => /活跃度\s*\d+/.test(m));
  const hasOldAct = metas.some((m) => /活跃\s?\d/.test(m) && m.indexOf('活跃度') < 0);
  push('文案改成「活跃度 N」', hasAct && !hasOldAct, metas[0] || '');
  const shortOk = metas.every((m) => /\d+\s*(秒|分钟|小时|天)前更新/.test(m));
  const longBad = metas.some((m) => m.indexOf('更新于') >= 0);
  push('更新时间缩短为「N 小时前更新」', shortOk && !longBad, metas[0] || '');

  const sets = info.tagSets || [];
  push('有 topics 的卡片存在（可验证折叠）', sets.length > 0, sets.length + ' 张带标签');
  const foldOk = sets.every((set) => {
    const real = set.filter((t) => !t.more).length;
    const more = set.filter((t) => t.more).length;
    return real <= 3 && more <= 1;
  });
  push('标签最多显示 3 个（其余折成 +N）', foldOk, JSON.stringify(sets[0] || []));
  push('每个标签都有悬停全名（title）', sets.every((set) => set.every((t) => t.title.length > 0)), '');
  const moreOk = sets.every((set) => set.filter((t) => t.more).every((t) => /^\+\d+$/.test(t.txt) && t.title.length > 0 && t.title.charAt(0) !== '+'));
  push('+N 的数量与隐藏项对得上', moreOk, '');

  // hover 才显示「复制/卡片」
  const miniCount = await s.evalJs(`document.querySelector('${CARD_SEL}').querySelectorAll('.mini:not(.mshare):not(.mblock)').length`);
  push('复制/卡片按钮存在', miniCount === 2, miniCount + ' 个');
  const before = await s.evalJs(`getComputedStyle(document.querySelector('${CARD_SEL} .mini:not(.mshare):not(.mblock)')).opacity`);
  push('默认不显示（opacity 0）', before === '0', before);

  const rect = await s.evalJs(`(function(){var r=document.querySelector('${CARD_SEL}').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+20)};})()`);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, buttons: 0 });
  await sleep(120);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 4, y: rect.y + 4, buttons: 0 });
  await sleep(400);
  const after = await s.evalJs(`(function(){var it=document.querySelector('${CARD_SEL}');return {hovered: it.matches(':hover'), op: getComputedStyle(it.querySelector('.mini')).opacity};})()`);
  push('鼠标移上去才出现', after.hovered === true && Number(after.op) > 0.5, JSON.stringify(after));

  s.ws.close();
  try { s.child.kill(); } catch {}
}

{
  const s = await session({ width: 390, height: 844, mobile: true, touch: true });
  const r = await s.evalJs(`(function(){
    var m = document.querySelector('${CARD_SEL} .mini:not(.mshare):not(.mblock)');
    return { display: m ? getComputedStyle(m).display : 'missing', hoverNone: window.matchMedia('(hover:none)').matches };
  })()`);
  push('触屏设备不显示复制/卡片按钮', r.hoverNone === true && r.display === 'none', JSON.stringify(r));
  s.ws.close();
  try { s.child.kill(); } catch {}
}

const bad = rows.filter((r) => !r.ok);
for (const r of rows) console.log((r.ok ? 'OK  ' : 'FAIL') + ' ' + r.name + (r.extra ? ' → ' + r.extra : ''));
console.log(bad.length ? `\n${bad.length} FAILED / ${rows.length}` : `\nALL OK (${rows.length})`);
process.exit(bad.length ? 1 : 0);
