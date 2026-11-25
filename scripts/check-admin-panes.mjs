import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9500 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-'));
const base = 'http://127.0.0.1:8123';
const tabs = ['overview', 'layout', 'articles', 'nav', 'seo', 'links', 'ad', 'contact', 'beian', 'submit', 'keys', 'translate'];

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let list = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      list = await r.json();
      if (list && list.length) break;
    } catch (e) {}
    await sleep(250);
  }
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  const logs = [];
  let collecting = false;

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      w(msg);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      logs.push('EXC: ' + (d.exception && d.exception.description ? String(d.exception.description).split('\n')[0] : d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && collecting) {
      const args = (msg.params.args || []).map((a) => a.value === undefined ? a.description : a.value).join(' ');
      if (msg.params.type === 'error') logs.push('ERR: ' + args);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    waiting.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/admin' });
  await sleep(1600);
  await evalJs("document.getElementById('pw').value='dev';document.getElementById('loginForm').requestSubmit();");
  await sleep(1600);

  for (const t of tabs) {
    collecting = true;
    const before = logs.length;
    const r = await evalJs(`(function(){var b=document.querySelector('.nav[data-tab="${t}"]');if(!b)return 'NO-NAV';b.click();var p=document.getElementById('pane-${t}');if(!p)return 'NO-PANE';var cs=getComputedStyle(p);return JSON.stringify({hidden:p.hidden,display:cs.display,len:p.innerHTML.length});})()`);
    await sleep(500);
    collecting = false;
    const errs = logs.slice(before);
    console.log(t.padEnd(10), r, errs.length ? '| ' + errs.join(' || ') : '');
  }
  try { await send('Browser.close'); } catch (e) {}
  child.kill();
}

main().catch((e) => { console.error(e); try { child.kill(); } catch (_) {} process.exit(1); });
