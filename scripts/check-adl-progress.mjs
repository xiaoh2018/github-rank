import { openCdp } from './lib/cdp.mjs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const REMOTE = !!process.env.PROBE_BASE;

const rows = [];
const push = (label, ok, detail) => {
  rows.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
};

// 取一篇文章的地址参数
const arts = await (await fetch(BASE + '/data/articles.json')).json().catch(() => null);
const list = Array.isArray(arts) ? arts : (arts && arts.articles) || [];
const a = list.find((x) => x && (x.slug || x.id)) || null;
const post = a ? (a.slug || a.id) : '';

if (REMOTE) {
  const home = await (await fetch(BASE + '/')).text();
  const artPath = a ? (a.slug || (a.category || 'tech') + '/' + (a.id || '1')) : 'tech/1';
  const art = await (await fetch(BASE + '/articles/' + artPath + '.html')).text().catch(() => '');
  push('弹窗阅读器有阅读进度条', home.includes('id="adlProg"') && home.includes('adlProgPaint'), '');
  push('静态页仍有点顶进度条（两边都在）', art.includes('id="rprogress"'), '');
  const bad0 = rows.filter((x) => !x.ok);
  console.log('\n' + (bad0.length ? 'FAILED ' + bad0.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE + ' (REMOTE)');
  process.exit(bad0.length ? 1 : 0);
}

const cdp = await openCdp({ width: 1440, height: 900 });
try {
  await cdp.send('Page.navigate', { url: BASE + '/?page=articles&post=' + encodeURIComponent(post) });
  await new Promise((r) => setTimeout(r, 2200));
  const opened = await cdp.js("(function(){var d=document.getElementById('artDlg');return !!(d&&d.open)})()");
  push('深链能打开文章弹窗', opened === true, opened);

  // 灌一段长内容，让正文内部可滚
  await cdp.js(`(function(){
    var b=document.getElementById('artDlgBody');
    var para='<p>这是用来测进度条的长段落，重复若干次让它超出一屏。</p>';
    b.innerHTML = new Array(60).join(para);
    b.dispatchEvent(new Event('scroll'));
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  const p0 = await cdp.js("(function(){var p=document.getElementById('adlProg');return p?p.getAttribute('data-pct'):'none'})()");
  push('刚打开（未滚动）是 0%', String(p0) === '0', p0);

  const mid = await cdp.js(`(function(){
    var b=document.getElementById('artDlgBody');
    var max=b.scrollHeight-b.clientHeight;
    b.scrollTop=Math.round(max/2);
    b.dispatchEvent(new Event('scroll'));
    var p=document.getElementById('adlProg');
    return {pct:+p.getAttribute('data-pct'), w:document.getElementById('adlProgFill').style.width, max:max};
  })()`);
  push('滚到一半约 50%', Math.abs(mid.pct - 50) <= 6, mid);
  push('细条宽度跟着走', mid.w === mid.pct + '%', mid.w);

  const end = await cdp.js(`(function(){
    var b=document.getElementById('artDlgBody');
    b.scrollTop=b.scrollHeight;
    b.dispatchEvent(new Event('scroll'));
    var p=document.getElementById('adlProg');
    return {pct:+p.getAttribute('data-pct'), title:p.getAttribute('title')};
  })()`);
  push('滚到底 100%', end.pct === 100, end);
  push('title 写「已读 100%」', String(end.title).includes('已读 100%'), end.title);

  const h = await cdp.js("(function(){var p=document.getElementById('adlProg');var r=p.getBoundingClientRect();return {h:Math.round(r.height),y:Math.round(r.top)}})()");
  push('细条只有 3px 高（不挡内容）', h.h === 3, h);

  await cdp.js("document.getElementById('artDlgX').click()");
  await new Promise((r) => setTimeout(r, 700));
  const closed = await cdp.js("(function(){var d=document.getElementById('artDlg');return !!(d&&d.open)})()");
  push('能关掉', closed === false, closed);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: BASE + '/?page=articles&post=' + encodeURIComponent(post) });
  await new Promise((r) => setTimeout(r, 2000));
  const ov = await cdp.js('({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})');
  push('390 不横向溢出', ov.sw <= ov.cw + 1, ov);
} finally {
  await cdp.close();
}

const bad = rows.filter((x) => !x.ok);
console.log('\n' + (bad.length ? 'FAILED ' + bad.length + ' of ' + rows.length : 'ALL OK (' + rows.length + ')') + '  @' + BASE);
process.exit(bad.length ? 1 : 0);