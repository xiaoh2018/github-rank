import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

if (REMOTE) {
  const st = await (await fetch(BASE + '/api/status')).json();
  const bundle = await (await fetch(BASE + '/js/bundle.js?v=' + st.version)).text();
  const home = await (await fetch(BASE + '/')).text();
  push('顶栏有「收藏」视图入口', home.includes('data-view="favs"'));
  push('bundle 里有收藏视图实现', bundle.includes('function renderFavs'));
  finish();
}

const cdp = await openCdp({ width: 1440, height: 950 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await new Promise((r) => setTimeout(r, 3600));
  await cdp.js(`(function(){
    var key='ghrank:favs';
    var list=JSON.parse(localStorage.getItem(key)||'[]');
    if (!list.length) list=['Marvisak/VIctory'];
    list.push('zzz/not-in-list');
    localStorage.setItem(key, JSON.stringify(list));
    return list.length;
  })()`);
  await cdp.js('location.reload()');
  await new Promise((r) => setTimeout(r, 3800));

  const views = await cdp.js(`document.querySelectorAll('#views .btn').length`);
  push('顶栏有 4 个视图（含收藏）', views === 4, views);

  await cdp.js(`(function(){var b=document.querySelector('#views [data-view="favs"]'); b.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 900));

  const state1 = await cdp.js(`(function(){
    var b=document.querySelector('#views [data-view="favs"]');
    var items=[].slice.call(document.querySelectorAll('#list .item'));
    var first=items[0]||null, second=items[1]||null;
    return {
      pressed: b.getAttribute('aria-pressed'),
      n: items.length,
      href: first && first.querySelector('a.name') ? first.querySelector('a.name').getAttribute('href') : '',
      firstText: first ? first.textContent : '',
      secondText: second ? second.textContent : ''
    };
  })()`);
  push('点「收藏」后视图选中', state1.pressed === 'true', state1.pressed);
  push('列出 2 个收藏', state1.n === 2, state1.n);
  push('收藏项链到 GitHub 且带星数', state1.href === 'https://github.com/Marvisak/VIctory' && /★\d/.test(state1.firstText), state1.href + ' | ' + state1.firstText.slice(0, 60));
  push('不在当前榜单的收藏也显示（并说明原因）', /不在当前这次拉到的榜单里/.test(state1.secondText), state1.secondText.slice(0, 60));

  await cdp.js(`(function(){
    var items=[].slice.call(document.querySelectorAll('#list .item'));
    var btn=items[1].querySelector('button');
    btn.click(); return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  const after = await cdp.js(`(function(){
    return {n: document.querySelectorAll('#list .item').length, store: (JSON.parse(localStorage.getItem('ghrank:favs')||'[]')).length};
  })()`);
  push('点「取消收藏」从列表与本地同时移除', after.n === 1 && after.store === 1, JSON.stringify(after));

  await cdp.js(`(function(){document.querySelector('#list .item button').click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 700));
  const empty = await cdp.js(`(function(){
    var it=document.querySelector('#list .item');
    return {text: it? it.textContent : '', hasGo: !![].some.call(document.querySelectorAll('#list button'), function(b){return b.textContent==='去项目榜'})};
  })()`);
  push('收藏清空后有引导空态', /还没有收藏/.test(empty.text) && empty.hasGo, empty.text.slice(0, 70));

  await cdp.js(`(function(){var b=[].find.call(document.querySelectorAll('#list button'),function(x){return /去项目榜/.test(x.textContent)}); if(b) b.click(); return 1})()`);
  await new Promise((r) => setTimeout(r, 2500));
  const back = await cdp.js(`(function(){var b=document.querySelector('#views [data-view="repos"]');return {pressed:b.getAttribute('aria-pressed'), items: document.querySelectorAll('#list .item').length}})()`);
  push('「去项目榜」回到榜单', back.pressed === 'true' && back.items > 5, JSON.stringify(back));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 800));
  const m = await cdp.js(`({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})`);
  push('390 下不横向溢出', m.sw <= m.cw + 1, m.sw + '/' + m.cw);
} finally {
  await cdp.close();
}
finish();

function finish() {
  let bad = 0;
  for (const r of rows) {
    if (!r.ok) bad++;
    console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '  → ' + r.detail : ''));
  }
  console.log('');
  console.log(bad ? bad + ' FAILED of ' + rows.length : 'ALL OK (' + rows.length + ')  @' + BASE + (REMOTE ? ' (REMOTE)' : ''));
  process.exit(bad ? 1 : 0);
}