// 共享 CDP 启动器：把「起 headless chrome → 连 ws → 收发 → 清理」这段
// 从 120 个门禁里各复制一份的样板收到一处。
//
// 内含三个在 20+ 轮里踩出来的修复：
//   1. 端口用 net.listen(0) 让内核分配（随机端口不是隔离，只是把冲突变偶发）；
//   2. `Runtime.evaluate` 的返回形状不统一（`{result:{result:{value}}}` / 异常在
//      `result.exceptionDetails`），这里统一成「拿到值或 {__err}」；
//   3. 退出时 kill 子进程 + 删临时 profile，避免孤儿 chrome 占端口拖垮下一个门禁。
//
// 用法：
//   const cdp = await openCdp({ width: 390, height: 844, mobile: true, onEvent: (m) => {} });
//   await cdp.send('Page.navigate', { url });
//   const v = await cdp.js('document.title');
//   await cdp.close();

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function openCdp(opts = {}) {
  const width = Number(opts.width || 1440);
  const height = Number(opts.height || 900);
  const mobile = opts.mobile === undefined ? width < 500 : !!opts.mobile;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const args = opts.args || [];
  if (!CHROME) throw new Error('没有找到 Chrome（试过 Program Files 两个位置）');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  let proc = null;
  let ws = null;
  let lastErr = '';

  for (let attempt = 0; attempt < 3 && !ws; attempt++) {
    const port = await freePort();
    proc = spawn(CHROME, [
      '--headless=new',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + dir,
      '--window-size=' + width + ',' + height,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ].concat(args), { stdio: 'ignore' });

    for (let i = 0; i < 60 && !ws; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        const page = list.find((t) => t.type === 'page');
        if (page) {
          ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        }
      } catch (e) { lastErr = String(e && e.message || e); }
      if (!ws) await sleep(200);
    }
    if (!ws) { try { proc.kill(); } catch { } }
  }
  if (!ws) throw new Error('连不上 CDP 目标（可能有残留 headless chrome 占着端口）：' + lastErr);

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (onEvent && m.method) onEvent(m);
  };

  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  // 统一 evaluate 的返回形状：值 / {__err}
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  // 页面级初始化：开 Page/Runtime/Network、关缓存、按视口模拟
  const init = async ({ cacheDisabled = true } = {}) => {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    if (cacheDisabled) await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  };

  const goto = async (url, waitMs = 1500) => {
    await send('Page.navigate', { url });
    await sleep(waitMs);
  };

  const close = async () => {
    try { ws.close(); } catch { }
    try { proc && proc.kill(); } catch { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  };

  return { send, js, init, goto, close, width, height, mobile };
}

// 单页截图（不点击、不交互）。注意 clip/`captureBeyondViewport` 的坐标系差异已在
// 这里规避：只做整页视口截图，需要裁切的门禁自己用 `Page.captureScreenshot`。
export async function shot({ url, out, width = 1440, height = 900, waitMs = 1800, fullPage = false }) {
  const cdp = await openCdp({ width, height });
  try {
    await cdp.init();
    await cdp.goto(url, waitMs);
    if (fullPage) {
      const m = await cdp.send('Page.getLayoutMetrics');
      const cs = m.result && m.result.cssContentSize;
      if (cs) await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: Math.ceil(cs.height), deviceScaleFactor: 1, mobile: width < 500,
      });
    }
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    const data = (r.result && r.result.data) || r.data;
    if (!data) throw new Error('截图失败：没有拿到 data');
    const buf = Buffer.from(data, 'base64');
    fs.writeFileSync(out, buf);
    return { out, bytes: buf.length, width, height };
  } finally {
    await cdp.close();
  }
}

export function runner(rows) {
  let bad = 0;
  for (const r of rows) {
    if (!r.ok) bad++;
    console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
  }
  console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
  return bad;
}