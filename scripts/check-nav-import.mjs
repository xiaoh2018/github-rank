// 导航「批量导入」：以前是整体粘贴 → 边解析边 push，坏行直接扔掉、重复照样进。
// 这个门禁验三件事：预览要逐行给结论、导入只写合格的行、什么都不合格时不许关窗。
import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (REMOTE) {
  const html = await (await fetch(BASE + '/admin')).text();
  push('线上后台有预览容器（navImpPrev）', html.includes('navImpPrev'), 'len=' + html.length);
  push('线上后台有解析函数（navParseImport）', html.includes('navParseImport'), '');
  push('线上后台总览文案在位', html.includes('可以导入 '), '');
  const f0 = rows.filter((r) => !r.ok);
  for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label);
  if (f0.length) { console.log('\n' + f0.length + ' FAILED of ' + rows.length); process.exit(1); }
  console.log('\nALL OK (' + rows.length + ')  @' + BASE + ' (REMOTE)');
  process.exit(0);
}

const cdp = await openCdp({ width: 1440, height: 900 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1400);
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await sleep(2600);
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="nav"]');if(n)n.click();return 1})()`);
  await sleep(700);

  // 纯函数：逐行结论
  const parsed = await cdp.js(`(function(){
    if (!window.__navParseImport) return null;
    var exist = (function(){ var it = document.querySelector('.nav-row [data-navurl], .nav-row input[data-f="url"]'); return it ? it.value : ''; })();
    var raw = [
      '新站甲 | https://example.com/aaa | 一段描述',
      '和上面重复 | https://example.com/aaa/ | 尾斜杠',
      '坏协议 | javascript:alert(1) | 不该进',
      '只有名字没有网址',
      'MDN | https://developer.mozilla.org | 文档'
    ].join(String.fromCharCode(10));
    return window.__navParseImport(raw);
  })()`);
  push('解析函数在位', !!parsed, parsed ? Object.keys(parsed).join(',') : 'null');
  if (parsed) {
    push('5 行里 2 行可导入（含尾斜杠重复被识别）', parsed.ok === 2, 'ok=' + parsed.ok);
    push('1 行判为重复', parsed.dup === 1, 'dup=' + parsed.dup);
    push('2 行判为格式不对（javascript: / 缺网址）', parsed.bad === 2, 'bad=' + parsed.bad);
    const bads = (parsed.rows || []).filter((r) => r.state === 'bad').map((r) => r.reason).join(' | ');
    push('格式不对的两行都写了原因', /http\(s\)/.test(bads) && /没有网址/.test(bads), bads.slice(0, 80));
    const okRow = (parsed.rows || [])[0] || {};
    push('可导入行带 name / url / desc', okRow.name === '新站甲' && okRow.url === 'https://example.com/aaa' && okRow.desc === '一段描述', JSON.stringify(okRow).slice(0, 90));
  }

  // 界面：预览表与总览
  await cdp.js(`(function(){ var b=document.getElementById('navImport'); if(b) b.click(); return 1 })()`);
  await sleep(400);
  await cdp.js(`(function(){
    var t=document.getElementById('navImpText');
    t.value = ['新站甲 | https://example.com/aaa | 一段描述','坏协议 | javascript:alert(1) | 不该进','只有名字没有网址'].join(String.fromCharCode(10));
    t.dispatchEvent(new Event('input', {bubbles:true}));
    return 1;
  })()`);
  await sleep(400);
  const prev = await cdp.js(`(function(){
    var box=document.getElementById('navImpPrev'), sum=document.getElementById('navImpSum'), go=document.getElementById('navImpGo');
    return { hidden: box? box.hidden : null, trs: box? box.querySelectorAll('tbody tr').length : -1, sum: sum? sum.textContent : '', disabled: go? go.disabled : null };
  })()`);
  push('预览区展开并逐行列出（3 行）', prev.hidden === false && prev.trs === 3, JSON.stringify(prev).slice(0, 110));
  push('总览写清能导入几条、跳过几条', /可以导入 1 条/.test(prev.sum) && /跳过 2 条格式不对/.test(prev.sum), prev.sum.slice(0, 90));
  push('有可导入行时「导入」可点', prev.disabled === false, String(prev.disabled));

  // 导入：只写合格的行
  await cdp.js(`(function(){ document.getElementById('navImpGo').click(); return 1 })()`);
  await sleep(700);
  const after = await cdp.js(`(function(){
    var dlg=document.getElementById('navImpDlg');
    var urls=[...document.querySelectorAll('input[data-f="url"]')].map(i=>i.value);
    var names=[...document.querySelectorAll('input[data-f="name"]')].map(i=>i.value);
    return { open: dlg? dlg.open : null, hasNew: urls.some(u=>u.indexOf('example.com/aaa')>=0), js: urls.some(u=>/^javascript:/i.test(u)), names: names.filter(Boolean).length };
  })()`);
  push('导入后对话框关闭', after.open === false, String(after.open));
  push('合格行真的进了列表', after.hasNew === true, 'urls 里有 example.com/aaa');
  push('javascript: 一行没有进列表', after.js === false, '');

  // 全不合格：不许关窗，且按钮禁用
  await cdp.js(`(function(){ document.getElementById('navImport').click(); return 1 })()`);
  await sleep(300);
  await cdp.js(`(function(){
    var t=document.getElementById('navImpText');
    t.value = ['坏协议 | javascript:alert(1) | x','也不对 | ftp://example.com | y'].join(String.fromCharCode(10));
    t.dispatchEvent(new Event('input', {bubbles:true}));
    return 1;
  })()`);
  await sleep(350);
  const none = await cdp.js(`(function(){
    var go=document.getElementById('navImpGo'), sum=document.getElementById('navImpSum');
    var dis=go? go.disabled : null;
    if (go) go.click();
    return { disabled: dis, sum: sum? sum.textContent : '', open: document.getElementById('navImpDlg').open };
  })()`);
  push('全不合格时「导入」是禁用状态', none.disabled === true, String(none.disabled));
  push('全不合格时点了也不关窗（还停在预览上）', none.open === true, String(none.open));
  push('全不合格的总览说 0 条可导入', /可以导入 0 条/.test(none.sum), none.sum.slice(0, 80));

  // 清理：不保存，直接重载丢掉这批草稿
  await cdp.js(`location.reload()`);
  await sleep(2200);
  const intact = await cdp.js(`(function(){ return (document.querySelectorAll('input[data-f="url"]')||[]).length })()`);
  push('重载后草稿没有落库（数据没被偷改）', typeof intact === 'number', 'url 输入框 ' + intact + ' 个');
} finally {
  await cdp.close();
}

// 390 宽度下不横向溢出
const cdp2 = await openCdp({ width: 390, height: 844 });
try {
  await cdp2.send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1300);
  await cdp2.js("sessionStorage.setItem('adminPw','dev')");
  await cdp2.js('location.reload()');
  await sleep(2400);
  await cdp2.js(`(function(){var n=document.querySelector('.side [data-tab="nav"]');if(n)n.click();return 1})()`);
  await sleep(500);
  await cdp2.js(`(function(){ var b=document.getElementById('navImport'); if(b) b.click(); return 1 })()`);
  await sleep(350);
  await cdp2.js(`(function(){
    var t=document.getElementById('navImpText');
    t.value = ['新站甲 | https://example.com/aaa | 一段描述','坏协议 | javascript:alert(1) | 不该进'].join(String.fromCharCode(10));
    t.dispatchEvent(new Event('input', {bubbles:true}));
    return 1;
  })()`);
  await sleep(400);
  const narrow = await cdp2.js(`(function(){ return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }; })()`);
  push('390 下整页不横向溢出', narrow.sw <= narrow.cw + 1, JSON.stringify(narrow));
} finally {
  await cdp2.close();
}

const failed = rows.filter((r) => !r.ok);
for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '  → ' + r.detail : ''));
if (failed.length) {
  console.log('\n' + failed.length + ' FAILED of ' + rows.length);
  process.exit(1);
}
console.log('\nALL OK (' + rows.length + ')  @' + BASE + (REMOTE ? ' (REMOTE)' : ''));