// 后台表单可访问名：14 个面板的每个输入控件都要有名字（label / aria-label / title）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const W = Number(process.env.PROBE_W || 1440);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const port = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghr-labels-'));
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch {}
  if (!target) await sleep(150);
}
if (!target) { console.error('no cdp page'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text));
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const rows = [];
const push = (name, ok, extra) => { rows.push({ name, ok: !!ok }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 700 });
await send('Page.navigate', { url: BASE + '/admin?t=' + Date.now() });
await sleep(2800);
await ev("(function(){var p=document.getElementById('pw'); if(p) p.value='test'; var b=document.getElementById('loginBtn'); if(b) b.click(); return 1;})()");
await sleep(1800);

const audit = await ev(`
(function(){
  function name(el){
    if (el.getAttribute('aria-label')) return 'aria-label';
    if (el.getAttribute('aria-labelledby')) return 'aria-labelledby';
    if (el.labels && el.labels.length) return 'label';
    if (el.getAttribute('title')) return 'title';
    return '';
  }
  var out = { panes: {}, unnamed: [] };
  Array.prototype.forEach.call(document.querySelectorAll('.pane'), function(p){
    var id = p.id.replace(/^pane-/, '');
    var fields = Array.prototype.filter.call(p.querySelectorAll('input,select,textarea'), function(el){
      return el.type !== 'hidden' && !el.disabled;
    });
    var bad = fields.filter(function(el){ return !name(el); });
    out.panes[id] = { fields: fields.length, unnamed: bad.length };
    bad.slice(0, 4).forEach(function(el){
      out.unnamed.push(id + ':' + el.tagName.toLowerCase() + '#' + (el.id || '-') + (el.getAttribute('placeholder') ? '(' + el.getAttribute('placeholder').slice(0, 12) + ')' : ''));
    });
  });
  return out;
})()`);

const paneNames = Object.keys(audit.panes);
push('后台 14 个面板都在 DOM 里（可审计）', paneNames.length === 14, paneNames.length);
let totalFields = 0; let totalUnnamed = 0;
paneNames.forEach((k) => { totalFields += audit.panes[k].fields; totalUnnamed += audit.panes[k].unnamed; });
push('每个面板的每个控件都有可访问名（14 面板 ' + totalFields + ' 个控件）', totalUnnamed === 0, audit.unnamed.slice(0, 6));

const al = await ev(`(function(){
  function g(id){ var el = document.getElementById(id); return el ? (el.getAttribute('aria-label') || '') : 'NONE'; }
  var slot = document.querySelector('[data-ad-field="html"]');
  var slotName = slot ? slot.getAttribute('aria-label') : 'NONE';
  var link = document.querySelector('[data-ad-field="link"]');
  var modal = document.querySelector('[data-ad-field="modal"]');
  return {
    qa: g('qaFilter'), art: g('artSearch'), geo: g('geo-summary'), unlock: g('artUnlockHint'), nav: g('navFilter'),
    slot: slotName, link: link ? link.getAttribute('aria-label') : 'NONE', modal: modal ? modal.getAttribute('aria-label') : 'NONE',
    slotCount: document.querySelectorAll('[data-ad-field="html"]').length
  };
})()`);
push('问答筛选框有名字', /筛选问答/.test(al.qa), al.qa);
push('文章搜索框有名字', /搜索文章/.test(al.art), al.art);
push('GEO 摘要框有名字', /站点简介/.test(al.geo), al.geo);
push('解锁提示框有名字', /解锁提示/.test(al.unlock), al.unlock);
push('导航筛选框有名字', /筛选常用站点/.test(al.nav), al.nav);
push('广告位 HTML 框名字带槽位名（' + al.slotCount + ' 个槽）', al.slotCount >= 8 && /广告 HTML/.test(al.slot) && /：/.test(al.slot), al.slot);
push('广告位跳转链接框有名字', /跳转链接/.test(al.link), al.link);
push('广告位弹窗内容框有名字', /弹窗内容/.test(al.modal), al.modal);

// 功能性：点「在这里显示」这行字，checkbox 应该被切换（说明 label 真的关联上了）
const labelWorks = await ev(`(function(){
  var cb = document.querySelector('[data-ad-field="enabled"]');
  if (!cb) return 'NONE';
  var lab = cb.closest('label');
  if (!lab) return 'NO_LABEL';
  var before = cb.checked;
  lab.click();
  var flipped = cb.checked !== before;
  if (flipped) lab.click();
  return flipped && cb.checked === before ? 'OK' : 'NO_TOGGLE';
})()`);
push('点「在这里显示」文字能切换开关（label 关联）', labelWorks === 'OK', labelWorks);

// 320 宽下广告面板不横向溢出
await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: BASE + '/admin?t=' + Date.now() });
await sleep(2600);
await ev("(function(){var p=document.getElementById('pw'); if(p) p.value='test'; var b=document.getElementById('loginBtn'); if(b) b.click(); return 1;})()");
await sleep(1600);
await ev("(function(){var n=document.querySelector('.side .nav[data-tab=\"ad\"]'); if(n) n.click(); return 1;})()");
await sleep(1200);
const over = await ev("(function(){var p=document.getElementById('pane-ad');var d=document.documentElement;var shown=p?getComputedStyle(p).display!=='none':false;return {shown:shown, sw:d.scrollWidth, cw:d.clientWidth};})()");
push('320 宽广告面板已打开且整页不横向溢出', over && over.shown && over.sw <= over.cw + 1, over);

ws.close();
try { child.kill(); } catch {}
const bad = rows.filter((r) => !r.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + '/' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + W + 'px  ' + BASE);
process.exit(bad.length ? 1 : 0);
