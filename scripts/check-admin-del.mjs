import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = Number(process.argv[2] || 1440), H = Number(process.argv[3] || 900);
const BASE = 'http://127.0.0.1:8123';
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const push = (n, ok, extra) => rows.push({ n, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const port = 9300 + Math.floor(Math.random() * 400);
const dir = path.join(os.tmpdir(), 'cdp-del-' + Date.now());
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-debugging-port=' + port, '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
let ws; const pending = new Map(); let seq = 0;
const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + e.slice(0, 60)); return r.result.value; };
const waitFor = async (e, ms = 12000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await sleep(250); } return false; };
const api = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'dev', ...body }) })).json();

async function loginAndOpen(tab) {
  await ev("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); true");
  await sleep(2000);
  await ev(`document.querySelector('.nav[data-tab="${tab}"]').click(); true`);
  await sleep(700);
}

try {
  await sleep(900);
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 800 });
  await send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1600);
  await loginAndOpen('articles');

  // ---------- 文章：确认文案 + 可撤销 + 撤销能恢复 ----------
  const before = await ev("document.querySelectorAll('#artTbody tr').length");
  const title0 = await ev("(document.querySelector('#artTbody tr td:nth-child(3)') || {}).textContent || ''");
  await ev("document.querySelector('#artTbody [data-artdel]').click(); true");
  await waitFor("document.getElementById('delDlg').open");
  const note = await ev("document.getElementById('delNote').textContent");
  push('删除文章确认框说清后果', /正文/.test(note), note.slice(0, 40));
  push('删除文章确认框承诺可撤销', /撤销/.test(note), '');
  await ev("document.getElementById('delSubmit').click(); true");
  await waitFor("!!document.querySelector('#pane-articles .save-msg.ok')");
  const msg = await ev("(document.querySelector('#pane-articles .save-msg.ok') || {}).textContent || ''");
  push('删除后有常驻结果行（不是一闪而过的 toast）', /已删除/.test(msg), msg.trim());
  push('结果行带「可撤销」字样', /可撤销/.test(msg) || /撤销/.test(await ev("(document.querySelector('#pane-articles .save-msg .linkbtn') || {}).textContent || ''")), '');
  push('结果行有可点的「撤销」', await ev("!!document.querySelector('#pane-articles .save-msg .linkbtn')"));
  push('撤销按钮已启用', !(await ev("document.getElementById('artUndo').disabled")));
  const after = await ev("document.querySelectorAll('#artTbody tr').length");
  push('列表里真的少了一条', after === before - 1, before + ' -> ' + after);
  await ev("document.querySelector('#pane-articles .save-msg .linkbtn').click(); true");
  await waitFor("document.querySelectorAll('#artTbody tr').length === " + before, 12000);
  push('点撤销后回到删除前', (await ev("document.querySelectorAll('#artTbody tr').length")) === before, before);
  push('撤销后撤销按钮变灰', await ev("document.getElementById('artUndo').disabled"));

  // ---------- 友链：不可撤销要说明 + 常驻结果 ----------
  await api('/api/links', { action: 'add', name: '__门禁__临时友链', url: 'https://example.com', desc: '' });
  await send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1500);
  await loginAndOpen('links');
  const hasTemp = await ev("[...document.querySelectorAll('#linkBody tr')].some(tr => tr.textContent.indexOf('__门禁__') >= 0)");
  push('临时友链已出现在列表', hasTemp);
  await ev("(() => { const tr = [...document.querySelectorAll('#linkBody tr')].find(x => x.textContent.indexOf('__门禁__') >= 0); tr.querySelector('[data-del]').click(); return true; })()");
  await waitFor("document.getElementById('delDlg').open");
  const lnote = await ev("document.getElementById('delNote').textContent");
  push('删友链确认框说明不可撤销', /不可撤销/.test(lnote), lnote.slice(0, 40));
  await ev("document.getElementById('delSubmit').click(); true");
  await waitFor("!!document.querySelector('#pane-links .save-msg.ok')");
  const lmsg = await ev("(document.querySelector('#pane-links .save-msg.ok') || {}).textContent || ''");
  push('删友链后有常驻结果行且说明已生效', /已删除/.test(lmsg) && /已生效/.test(lmsg), lmsg.trim());
  push('临时友链已从列表消失', !(await ev("[...document.querySelectorAll('#linkBody tr')].some(tr => tr.textContent.indexOf('__门禁__') >= 0)")));

  // ---------- 问答：先确认再删 + 说清「要不要保存」 ----------
  await ev("document.querySelector('.nav[data-tab=\"qa\"]').click(); true");
  await sleep(800);
  const qBefore = await ev("document.querySelectorAll('#qaList [data-qadel]').length");
  await ev("document.querySelector('#qaList [data-qadel]').click(); true");
  await waitFor("document.getElementById('delDlg').open");
  const qnote = await ev("document.getElementById('delNote').textContent");
  push('删问答前会先确认（以前是直接删）', /保存问答/.test(qnote), qnote.slice(0, 40));
  await ev("document.getElementById('delSubmit').click(); true");
  await waitFor("!!document.querySelector('#pane-qa .save-msg.ok')");
  const qmsg = await ev("(document.querySelector('#pane-qa .save-msg.ok') || {}).textContent || ''");
  push('删问答后提示要先保存才生效', /保存问答/.test(qmsg), qmsg.trim());
  const qAfter = await ev("document.querySelectorAll('#qaList [data-qadel]').length");
  push('问答列表少了一条（仅本地）', qAfter === qBefore - 1, qBefore + ' -> ' + qAfter);
  push('状态行不与「保存问答」提示抢位', await ev("!!document.getElementById('qaSaveMsg')"));

  push('整页不横向溢出', (await ev("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1")));
} catch (e) {
  push('脚本异常：' + e.message, false);
} finally {
  let bad = 0;
  for (const r of rows) { if (!r.ok) bad++; console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.extra ? '  [' + r.extra + ']' : '')); }
  console.log(bad === 0 ? 'ALL OK (' + rows.length + ')' : bad + ' FAILED of ' + rows.length);
  try { await send('Browser.close'); } catch {}
  try { child.kill(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(bad === 0 ? 0 : 1);
}
