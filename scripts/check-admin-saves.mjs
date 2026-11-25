// 后台「每个保存按钮都能真存」的端到端门禁。
// 做法：CDP 登录 dev-server → 逐个面板点 data-save 按钮 → 抓 fetch 请求 + toast + 错误红条，
// 断言每个保存都打到了预期的接口、且没有出现错误提示。跑完把 data/ 下的 json 还原。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8123';
const DATA = ['data/site.json', 'data/links.json', 'data/articles.json', 'data/qa.json', 'data/nav.json'];
const snapshot = new Map(DATA.map((f) => [f, fs.readFileSync(f, 'utf8')]));

const PANES = [
  ['layout', '/api/site', '版面布局'],
  ['articles', '/api/site', '文章设置'],
  ['nav', '/api/nav', '导航页'],
  ['seo', '/api/site', 'SEO 与 GEO'],
  ['links', null, '友链'], // 友链的保存是行内弹窗，没有 data-save
  ['ad', '/api/site', '广告位'],
  ['contact', '/api/site', '联系方式'],
  ['beian', '/api/site', '备案信息'],
  ['submit', null, '收录提交'], // 是执行按钮，不是 data-save
  ['keys', '/api/site', '设置与密钥'],
  ['translate', null, '翻译'], // 只有实测按钮
  ['qa', '/api/qa', '问答'],
  ['theme', '/api/site', '主题'],
];

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9100 + Math.floor(Math.random() * 150);
const dir = 'C:\\Windows\\Temp\\cdpsaves' + Date.now();
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    target = list.find((t) => t.type === 'page');
  } catch (e) {}
}
if (!target) { console.log('起不来 Chrome，跳过'); process.exit(0); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return '__ERR__ ' + JSON.stringify(r.result.exceptionDetails.text || '');
  return r.result && r.result.result ? r.result.result.value : null;
};

let failures = 0;
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1500);
  await evalJs("(function(){window.__req=[];var of=window.fetch;window.fetch=function(u){try{window.__req.push(String(u&&u.url?u.url:u));}catch(e){}return of.apply(window,arguments);};})(); 'ok'");
  await evalJs("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); 'ok'");
  await sleep(1700);

  for (const [pane, api, label] of PANES) {
    if (!api) { console.log('skip  ' + label + '（没有 data-save 保存按钮）'); continue; }
    const opened = await evalJs("(function(){var b=document.querySelector('.nav[data-tab=\"" + pane + "\"]'); if(!b) return 'no nav'; b.click(); return 'ok';})()");
    if (opened !== 'ok') { console.log('FAIL  打开面板 ' + label + ' → ' + opened); failures++; continue; }
    await sleep(700);
    await evalJs("window.__req=[]; 'ok'");
    const click = await evalJs("(function(){var p=document.getElementById('pane-" + pane + "'); if(!p) return 'no pane'; var b=p.querySelector('[data-save]'); if(!b) return 'no button'; b.click(); return 'ok';})()");
    if (click !== 'ok') { console.log('FAIL  ' + label + ' 点保存 → ' + click); failures++; continue; }
    await sleep(1500);
    const reqs = await evalJs("window.__req.join(' ')");
    const toast = (await evalJs("(document.getElementById('toast')||{}).textContent || ''")) || '';
    const err = (await evalJs("(document.getElementById('errBar')||{}).textContent || ''")) || '';
    const hit = String(reqs).includes(api);
    const bad = /失败|只能是|错误|异常/.test(toast + ' ' + err);
    if (hit && !bad) {
      console.log('OK    ' + label + ' 保存 → ' + api + (toast ? ' · ' + toast : ''));
    } else {
      failures++;
      console.log('FAIL  ' + label + ' 保存 → 期望 ' + api + '，实际 [' + reqs + '] toast=「' + toast + '」 err=「' + err + '」');
    }
  }
} finally {
  try { await send('Browser.close'); } catch (e) {}
  proc.kill();
  for (const [f, text] of snapshot) fs.writeFileSync(f, text, 'utf8');
}

console.log('');
if (failures) { console.log(failures + ' 个保存失败'); process.exit(1); }
console.log('全部保存按钮都能真存（' + PANES.filter((p) => p[1]).length + ' 个面板）');
