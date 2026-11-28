import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;
const rows = [];
const push = (label, ok, detail) => {
  rows.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

if (REMOTE) {
  const home = await (await fetch(BASE + '/')).text();
  const homeHtml = await (await fetch(BASE + '/')).text();
  const ver = (/bundle\.js\?v=([A-Za-z0-9._-]+)/.exec(homeHtml) || [])[1] || '';
  const bundle = await (await fetch(BASE + '/js/bundle.js' + (ver ? '?v=' + ver : ''))).text();
  push('导航搜索会把关键词写进地址（可分享）', home.includes('navSyncUrl') && home.includes("u.searchParams.set('q'"), '');
  push('切换视图时不丢 q（setView 保留）', home.includes("v2==='nav'&&keepQ"), '');
  push('syncHash 保留导航页的 q', bundle.includes("pageMark === 'nav' && navQMark"), '');
  const bad0 = rows.filter((x) => !x.ok);
  console.log('\n' + (bad0.length ? 'FAILED ' + bad0.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE + ' (REMOTE)');
  process.exit(bad0.length ? 1 : 0);
}

const cdp = await openCdp({ width: 1440, height: 900 });
try {
  const snap = async () => cdp.js(`(function(){
    var q=document.getElementById('navSearch');
    var cards=[].slice.call(document.querySelectorAll('.navcard')).filter(function(c){return c.offsetParent!==null});
    var reset=document.querySelector('[data-navreset]');
    return {input:q?q.value:'', href:location.href,
      cards:cards.length,
      count:((document.getElementById('navCount')||{}).textContent||'').trim(),
      empty: !!document.querySelector('.navempty'),
      reset: !!reset, hist: history.length};
  })()`);

  // 1) /nav?q=github
  await cdp.send('Page.navigate', { url: BASE + '/nav?q=github' });
  await new Promise((r) => setTimeout(r, 2400));
  const a = await snap();
  push('直接打开 /nav?q=github 会带入关键词', a.input === 'github', a);
  push('地址里保留 q（可分享）', /[?&]q=github/.test(a.href), a.href);
  push('列表被筛选（不是 23 个）', a.cards > 0 && a.cards < 6, a.cards);
  push('计数文案说「匹配」', /匹配/.test(a.count), a.count);

  // 2) ?page=nav&q=github
  await cdp.send('Page.navigate', { url: BASE + '/?page=nav&q=github' });
  await new Promise((r) => setTimeout(r, 2400));
  const b = await snap();
  push('?page=nav&q= 形式同样生效', b.input === 'github' && b.cards === a.cards, b);

  // 3) 输入关键词 → 写地址
  await cdp.send('Page.navigate', { url: BASE + '/?page=nav' });
  await new Promise((r) => setTimeout(r, 2400));
  const h0 = await snap();
  await cdp.js(`(function(){var q=document.getElementById('navSearch'); q.value='zzzznope'; q.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  await new Promise((r) => setTimeout(r, 700));
  const c = await snap();
  push('输入关键词后地址里出现 q', /[?&]q=zzzznope/.test(c.href), c.href);
  push('搜不到时给空态和「清空搜索」', c.empty === true && c.reset === true, { empty: c.empty, reset: c.reset });
  push('写地址是替换不是新增历史（后退不会陷在筛选里）', c.hist === h0.hist, { before: h0.hist, after: c.hist });

  // 4) 清空 → 地址去掉 q、列表恢复
  await cdp.js("document.querySelector('[data-navreset]').click()");
  await new Promise((r) => setTimeout(r, 700));
  const d = await snap();
  push('清空后地址里没有 q', !/[?&]q=/.test(d.href), d.href);
  push('清空后列表恢复全量', d.cards >= 12 && /共 \d+ 个/.test(d.count), { cards: d.cards, count: d.count });

  // 5) 320 不溢出（带关键词时）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: BASE + '/?page=nav&q=github' });
  await new Promise((r) => setTimeout(r, 2400));
  const ov = await cdp.js('({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})');
  push('320 带关键词不横向溢出', ov.sw <= ov.cw + 1, ov);
} finally {
  await cdp.close();
}

const bad = rows.filter((x) => !x.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + ' of ' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE);
process.exit(bad.length ? 1 : 0);