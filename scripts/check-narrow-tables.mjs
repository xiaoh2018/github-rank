// 门禁：文章正文表格窄屏可横滚 + 后台工具栏窄屏换行顺序
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.GHRANK_BASE || 'http://127.0.0.1:8123';
const pw = process.env.GHRANK_PW || 'dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const pass = (n, c, e) => { if (c) { ok++; console.log('  PASS  ' + n); } else { bad++; console.log('  FAIL  ' + n + (e ? '  [' + e + ']' : '')); } };
const api = async (p, body) => {
  const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};

const port = 10940 + Math.floor(Math.random() * 50);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-narrow-'));
const child = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let tg;
for (let i = 0; i < 60 && !tg; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); tg = l.find((x) => x.type === 'page'); } catch {}
  if (!tg) await sleep(250);
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let n = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => { const i = ++n; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pend.set(i, r)); };
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description));
  return r.result && r.result.result && r.result.result.value;
}

const title = '__门禁__窄屏表格 ' + Date.now();
let artId = '';

try {
  await send('Page.enable');
  await send('Runtime.enable');

  const body = [
    '下面这张表有 6 列、每列都很长，用来验证窄屏能不能横向滚动而不是把字挤成竖排。',
    '',
    '| 平台 | 安装命令 | 用途说明 | 注意事项 | 官方文档 | 备注 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Windows | winget install Microsoft.VisualStudioCode | 用系统包管理器安装编辑器，避免手动下载安装包 | 需要管理员权限，首次运行可能要重启终端 | https://code.visualstudio.com/docs | 推荐 |',
    '| macOS | brew install --cask visual-studio-code | 用 Homebrew 安装应用，升级只需一条命令 | 需要先装 Xcode Command Line Tools | https://brew.sh/ | 推荐 |',
    '| Linux | snap install code --classic | 用 snap 安装，自动更新 | 部分发行版默认没装 snapd | https://snapcraft.io/code | 可选 |',
  ].join('\n');

  const add = await api('/api/articles', { password: pw, action: 'add', article: { title, date: new Date().toISOString().slice(0, 10), summary: '门禁造数：窄屏表格', body, category: '技术' } });
  pass('造数：新增带宽表格的文章', add.status === 200 && add.json && add.json.ok, 'status=' + add.status + ' ' + JSON.stringify((add.json && add.json.error) || ''));
  const after = await api('/api/articles');
  const mine = ((after.json && after.json.articles) || []).find((a) => a.title === title);
  artId = mine && mine.id;
  pass('拿到 slug', !!(mine && mine.slug), String(mine && mine.slug));

  // —— 390 宽打开文章
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: base + '/articles/' + (mine && mine.slug) + '.html' });
  await sleep(2600);

  const narrow = await ev(`(function(){
    var t = document.querySelector('#rBody .md-table');
    if (!t) return { found: false, readerOpen: !!document.querySelector('#reader[open], .reader[open]') };
    var s = getComputedStyle(t);
    var table = t.querySelector('table');
    var firstCell = t.querySelector('th,td');
    return {
      found: true,
      overflowX: s.overflowX,
      scrollW: t.scrollWidth,
      clientW: t.clientWidth,
      tableW: table ? Math.round(table.getBoundingClientRect().width) : 0,
      cellW: firstCell ? Math.round(firstCell.getBoundingClientRect().width) : 0,
      docSw: document.documentElement.scrollWidth,
      docCw: document.documentElement.clientWidth
    };
  })()`);
  pass('正文表格套了 .md-table 滚动容器', !!narrow.found, JSON.stringify(narrow));
  pass('窄屏容器可横向滚动', narrow.overflowX === 'auto', narrow.overflowX);
  pass('宽表确实溢出（能滚）', narrow.scrollW - narrow.clientW >= 40, narrow.scrollW + ' vs ' + narrow.clientW);
  pass('单元格没被挤成竖排（≥88px）', narrow.cellW >= 88, narrow.cellW + 'px');
  pass('整页不横向溢出', narrow.docSw === narrow.docCw, narrow.docSw + '/' + narrow.docCw);

  // —— 1440 宽同页
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const wide = await ev(`(function(){
    var t = document.querySelector('#rBody .md-table');
    if (!t) return null;
    return { scrollW: t.scrollWidth, clientW: t.clientWidth, overflowX: getComputedStyle(t).overflowX };
  })()`);
  pass('宽屏表格不溢出（不用滚）', !!wide && wide.scrollW - wide.clientW < 40, wide && wide.scrollW + ' vs ' + wide.clientW);

  // —— 后台工具栏 390
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: base + '/admin' });
  await sleep(2200);
  if (await ev("!!document.getElementById('gate')")) {
    await ev("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); true");
    await sleep(1800);
  }
  await ev("(function(){var a=document.querySelectorAll('.nav');for(var i=0;i<a.length;i++){if(a[i].getAttribute('data-tab')==='articles'){a[i].click();return true}}return false})()");
  await sleep(900);
  const bar = await ev(`(function(){
    var s = document.getElementById('artSearch');
    var pane = document.getElementById('pane-articles');
    if (!s || !pane) return null;
    var sort = document.getElementById('artSort');
    var cat = document.getElementById('artCatFilter');
    return {
      searchW: Math.round(s.getBoundingClientRect().width),
      paneW: Math.round(pane.getBoundingClientRect().width),
      sortW: sort ? Math.round(sort.getBoundingClientRect().width) : 0,
      catW: cat ? Math.round(cat.getBoundingClientRect().width) : 0,
      docSw: document.documentElement.scrollWidth,
      docCw: document.documentElement.clientWidth
    };
  })()`);
  pass('后台搜索框占满一行', !!bar && bar.searchW >= bar.paneW * 0.8, bar && bar.searchW + '/' + bar.paneW);
  pass('排序/分类下拉仍可用（≥90px）', !!bar && bar.sortW >= 90 && bar.catW >= 90, bar && bar.sortW + '/' + bar.catW);
  pass('后台窄屏整页不横向溢出', !!bar && bar.docSw === bar.docCw, bar && bar.docSw + '/' + bar.docCw);
} catch (e) {
  bad++;
  console.log('  FAIL  脚本异常  [' + (e && e.message) + ']');
} finally {
  try {
    if (artId) await api('/api/articles', { password: pw, action: 'remove', id: artId });
    const chk = await api('/api/articles');
    const left = ((chk.json && chk.json.articles) || []).filter((a) => String(a.title).indexOf('__门禁__') === 0).length;
    pass('清理：门禁文章已删除', left === 0, '残留 ' + left);
  } catch (e2) { bad++; console.log('  FAIL  清理异常  [' + (e2 && e2.message) + ']'); }
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  console.log(bad === 0 ? '\n全部通过（' + ok + ' 项）' : '\n' + ok + ' 通过 / ' + bad + ' 失败');
  process.exit(bad === 0 ? 0 : 1);
}
