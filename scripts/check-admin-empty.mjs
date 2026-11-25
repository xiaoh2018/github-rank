// 门禁：后台表格空态卡（v143）
// 1) /admin 源码里有 .empty-card 与 data-empty-act
// 2) 文章面板搜乱码 → 出现 .empty-card「没有匹配的文章」+ 重置按钮
// 3) 点重置 → 列表回来、搜索框清空、空态消失
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('OK   ' + m); };
const bad = (m) => { fail++; console.log('FAIL ' + m); };

const adminHtml = await (await fetch(BASE + '/admin', { cache: 'no-store' })).text();
(adminHtml.includes('.empty-card{padding:30px') ? ok : bad)('后台源码有 .empty-card 样式');
(adminHtml.includes('data-empty-act="artreset"') ? ok : bad)('后台源码有「清空搜索与筛选」按钮');
(adminHtml.includes('data-empty-act="link-add"') ? ok : bad)('后台源码有友链空态按钮');
(adminHtml.includes('data-empty-act="cat-add"') ? ok : bad)('后台源码有分类空态按钮');
(adminHtml.includes('data-empty-act="qa-add"') ? ok : bad)('后台源码有问答空态按钮');
(adminHtml.includes('EMPTY_ACT') ? ok : bad)('后台源码有空态按钮委托表');
(adminHtml.includes('data-empty-act="nav-cat-add"') ? ok : bad)('后台源码有导航分类空态按钮');
(adminHtml.includes('data-navfreset="1"') ? ok : bad)('后台源码有导航「清空筛选」按钮');
(adminHtml.includes('role="status"') ? ok : bad)('后台空态卡对读屏可见（role=status）');

const port = 9600 + Math.floor(Math.random() * 300);
const prof = path.join(os.tmpdir(), 'cr-aempty-' + Date.now());
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=1440,900',
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

let ws = null, id = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
};
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
          const p = pending.get(m.id); pending.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        }
      };
      break;
    }
  } catch (e) {}
  await sleep(250);
}
if (!ws) { console.log('ERR chrome'); process.exit(1); }
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1600);
  await evalJs("(function(){var p=document.getElementById('pw'); p.value='dev'; document.getElementById('loginForm').requestSubmit(); return 1})()");
  await sleep(1800);
  await evalJs("document.querySelector('.nav[data-tab=\"articles\"]').click(); 1");
  await sleep(1200);

  const rows0 = await evalJs("document.querySelectorAll('#artTbody tr').length");
  (rows0 > 0 ? ok : bad)('文章列表初始 ' + rows0 + ' 行');
  await evalJs("(function(){var i=document.getElementById('artSearch'); i.value='zzqq没有的文章'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()");
  await sleep(500);
  const cardT = await evalJs("(function(){var c=document.querySelector('#artTbody .empty-card'); return c?c.textContent.replace(/\\s+/g,' ').trim():''})()");
  (cardT.indexOf('没有匹配的文章') >= 0 ? ok : bad)('出现空态卡（' + cardT.slice(0, 20) + '…）');
  const hasBtn = await evalJs("!!document.querySelector('#artTbody [data-empty-act=\"artreset\"]')");
  (hasBtn ? ok : bad)('空态卡里有重置按钮');
  await evalJs("document.querySelector('#artTbody [data-empty-act=\"artreset\"]').click(); 1");
  await sleep(600);
  const rows1 = await evalJs("document.querySelectorAll('#artTbody tr').length");
  (rows1 > 0 ? ok : bad)('点重置后恢复 ' + rows1 + ' 行');
  const q1 = await evalJs("(document.getElementById('artSearch')||{}).value");
  (q1 === '' ? ok : bad)('搜索框已清空（实际 "' + q1 + '"）');
  const gone = await evalJs("!document.querySelector('#artTbody .empty-card')");
  (gone ? ok : bad)('空态卡已消失');
  const note = await evalJs("(document.getElementById('artSearchNote')||{}).textContent");
  (note === '' ? ok : bad)('筛选提示已清空（实际 "' + note + '"）');

  // 导航页：搜索无匹配 → 空态卡 + 清空筛选
  await evalJs("document.querySelector('.nav[data-tab=\"nav\"]').click(); 1");
  await sleep(1300);
  const navRows0 = await evalJs("document.querySelectorAll('#navAdmin .nav-table tbody tr').length");
  (navRows0 > 0 ? ok : bad)('导航列表初始 ' + navRows0 + ' 行');
  await evalJs("(function(){var i=document.getElementById('navFilter'); i.value='zzqq没有的站点'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()");
  await sleep(500);
  const navCard = await evalJs("(function(){var c=document.querySelector('#navAdmin .empty-card'); return c?c.textContent.replace(/\\s+/g,' ').trim():''})()");
  (navCard.indexOf('没有匹配的站点') >= 0 ? ok : bad)('导航空态卡（' + navCard.slice(0, 16) + '…）');
  const navReset = await evalJs("!!document.querySelector('#navAdmin [data-navfreset]')");
  (navReset ? ok : bad)('导航空态卡里有「清空筛选」');
  await evalJs("document.querySelector('#navAdmin [data-navfreset]').click(); 1");
  await sleep(600);
  const navRows1 = await evalJs("document.querySelectorAll('#navAdmin .nav-table tbody tr').length");
  (navRows1 > 0 ? ok : bad)('清空筛选后恢复 ' + navRows1 + ' 行');
  const navF = await evalJs("(document.getElementById('navFilter')||{}).value");
  (navF === '' ? ok : bad)('筛选框已清空（实际 "' + navF + '"）');
} catch (e) {
  bad('执行异常: ' + e.message);
} finally {
  try { await send('Browser.close'); } catch (e) {}
  try { child.kill(); } catch (e) {}
  await sleep(300);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (fail ? 'FAILED ' + fail : 'ALL ' + pass + ' OK'));
  process.exit(fail ? 1 : 0);
}
