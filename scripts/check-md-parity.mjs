import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => {
  rows.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

const FENCE = String.fromCharCode(96, 96, 96);
const TICK = String.fromCharCode(96);
const SAMPLE = [
  '## 小标题',
  '',
  '**加粗** 与 ' + TICK + '代码' + TICK + ' 和 [链接](https://example.com)',
  '',
  '- 项目一',
  '- 项目二',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  FENCE + 'js',
  'const a = 1 < 2 && "x";',
  FENCE,
  '',
  '<script>alert(1)</script>',
].join('\n');

const verOf = (html) => {
  const m = html.match(/\/?js\/md\.js\?v=([^"']+)/);
  return m ? m[1] : '';
};

const st = await (await fetch(BASE + '/api/status')).json().catch(() => ({}));
const curVer = st.version || (st.data && st.data.version) || '';

const admin = await (await fetch(BASE + '/admin')).text();
const home = await (await fetch(BASE + '/')).text();
const arts = await (await fetch(BASE + '/articles.html')).text().catch(() => '');

const vAdmin = verOf(admin);
const vHome = verOf(home);
const vArts = verOf(arts);

push('后台加载的 md.js 带版本号', !!vAdmin, vAdmin);
push('后台不再写死 v=9', vAdmin !== '9', vAdmin);
if (curVer) push('后台版本号 == 当前发版号（' + curVer + '）', vAdmin === curVer, vAdmin);
push('首页同版本', vHome === vAdmin, { home: vHome, admin: vAdmin });
if (arts) push('文章页同版本', vArts === vAdmin, { arts: vArts, admin: vAdmin });
push('预览栏标出「和读者看到的一致 + 渲染器版本」', admin.includes('art-prev-head') && admin.includes('md.js ' + vAdmin), '');

if (REMOTE) {
  const bad0 = rows.filter((x) => !x.ok);
  console.log('\n' + (bad0.length ? 'FAILED ' + bad0.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE + ' (REMOTE)');
  process.exit(bad0.length ? 1 : 0);
}

const norm = (h) => String(h).replace(/>\s+</g, '><').trim();
const render = (cdp) =>
  cdp.js(`(function(){
    if (!window.KeeMd || typeof window.KeeMd.render !== 'function') return 'NO_RENDERER';
    return window.KeeMd.render(${JSON.stringify(SAMPLE)});
  })()`);

const cdp = await openCdp({ width: 1280, height: 900 });
try {
  // 前台渲染
  const arts0 = await (await fetch(BASE + '/data/articles.json')).json().catch(() => null);
  const list0 = Array.isArray(arts0) ? arts0 : (arts0 && arts0.articles) || [];
  const one = list0.find((x) => x && (x.slug || x.id)) || {};
  const post = one.slug || one.id || '';
  // 首页的 md.js 是按需加载的（打开一次阅读器才注入），所以先开一篇文章
  const artPath = one.slug || ((one.category || 'tech') + '/' + (one.id || '1'));
  // 静态文章页是**急切**加载 md.js 的（首页是打开阅读器时才按需注入），拿它做前台基准
  await cdp.send('Page.navigate', { url: BASE + '/articles/' + artPath + '.html' });
  await new Promise((r) => setTimeout(r, 2400));
  const front = await render(cdp);
  push('前台能渲染（KeeMd 在）', front !== 'NO_RENDERER', front === 'NO_RENDERER' ? 'NO_RENDERER' : 'ok');

  // 后台渲染
  await cdp.send('Page.navigate', { url: BASE + '/admin' });
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.js("sessionStorage.setItem('adminPw','dev')");
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 2400));
  const adm = await render(cdp);
  push('后台能渲染（KeeMd 在）', adm !== 'NO_RENDERER', adm === 'NO_RENDERER' ? 'NO_RENDERER' : 'ok');

  if (front !== 'NO_RENDERER' && adm !== 'NO_RENDERER') {
    const a = norm(front);
    const b = norm(adm);
    push('同样的 Markdown 两边渲染完全一致', a === b, a === b ? 'len ' + a.length : { front: a.slice(0, 120), admin: b.slice(0, 120) });
    push('代码围栏里的 < 被转义（没被当标签）', a.includes('&lt;') && !a.includes('<script'), '');
    push('表格渲染成 table', a.includes('<table'), '');
  }

  // 后台预览框真的用同一个渲染器
  await cdp.js(`(function(){var n=document.querySelector('.side [data-tab="articles"]'); if(n) n.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 500));
  await cdp.js("document.getElementById('artNew').click()");
  await new Promise((r) => setTimeout(r, 700));
  const prev = await cdp.js(`(function(){
    var t=document.getElementById('artBody');
    t.value=${JSON.stringify(SAMPLE)};
    t.dispatchEvent(new Event('input'));
    var p=document.getElementById('artPrev');
    return {html: p.innerHTML.slice(0,200), hasTable: !!p.querySelector('table')};
  })()`);
  push('后台预览框里也是同一份渲染（表格在）', prev.hasTable === true, prev);
  const metaTxt = await cdp.js("((document.querySelector('.art-prev-head')||{}).textContent||'').trim()");
  push('预览栏那行字带着当前版本号', metaTxt.includes('md.js ' + vAdmin), metaTxt.slice(0, 60));
  await cdp.js("document.getElementById('artDlg').close()");
} finally {
  await cdp.close();
}

const bad = rows.filter((x) => !x.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + ' of ' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE);
process.exit(bad.length ? 1 : 0);