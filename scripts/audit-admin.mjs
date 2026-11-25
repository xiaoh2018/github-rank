// 后台逐面板审计：登录后逐个点开 12 个面板，收集控制台错误、横向溢出元素、空卡片、没有文案的按钮。
// 用法：node scripts/audit-admin.mjs [http://127.0.0.1:8123]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:8123';
const TABS = ['overview', 'layout', 'articles', 'nav', 'qa', 'seo', 'links', 'ad', 'contact', 'beian', 'submit', 'keys', 'translate'];
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9300 + Math.floor(Math.random() * 200);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-audit-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    target = list.find((x) => x.type === 'page');
  } catch {}
  if (!target) await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('ERR ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.result.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/admin' });
await sleep(1600);
await evalJs(`(() => { document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); return 1; })()`);
await sleep(1900);

const rows = [];
for (const tab of TABS) {
  errors.length = 0;
  const info = await evalJs(`(async () => {
    const nav = document.querySelector('.nav[data-tab="${tab}"]');
    if (nav) nav.click();
    await new Promise(r => setTimeout(r, 450));
    const pane = document.getElementById('pane-' + '${tab}');
    if (!pane) return { missing: true };
    const wide = [];
    pane.querySelectorAll('*').forEach(el => {
      if (/^(input|textarea|select)$/i.test(el.tagName)) return;
      if (el.scrollWidth - el.clientWidth > 2 && el.clientWidth > 0 && getComputedStyle(el).overflowX !== 'auto') {
        wide.push((el.tagName.toLowerCase() + '.' + (el.className || '')).slice(0, 60) + ' ' + el.scrollWidth + '>' + el.clientWidth);
      }
    });
    const cards = Array.from(pane.querySelectorAll('.card'));
    const emptyCards = cards.filter(c => c.textContent.trim().length < 12).length;
    const btns = Array.from(pane.querySelectorAll('button'));
    const noText = btns.filter(b => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.title).length;
    return {
      hidden: pane.hidden,
      display: getComputedStyle(pane).display,
      cards: cards.length,
      emptyCards,
      buttons: btns.length,
      noTextButtons: noText,
      wide: wide.slice(0, 4),
      height: Math.round(pane.getBoundingClientRect().height),
    };
  })()`);
  rows.push({ tab, ...info, errors: errors.slice(0, 3) });
}

let bad = 0;
for (const r of rows) {
  const flag = r.missing || r.hidden || r.display === 'none' || (r.wide && r.wide.length) || (r.errors && r.errors.length) || r.emptyCards;
  if (flag) bad++;
  console.log((flag ? 'WARN ' : 'ok   ') + r.tab.padEnd(10) + JSON.stringify({ cards: r.cards, empty: r.emptyCards, wide: r.wide, errors: r.errors, noText: r.noTextButtons }));
}
console.log(bad ? `\n${bad} 个面板需要看` : '\n全部面板正常');
try { await send('Browser.close'); } catch {}
child.kill();
