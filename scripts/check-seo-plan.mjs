// 校验「SEO 规划」这张清单与实现是否一致：
// 1) 分页/筛选视图 noindex、canonical 回首页、不进缓存，但视图路由（?page=articles）不误伤
// 2) 文章列表的 ItemList、文章页的自指 canonical、404 页的 noindex
// 3) 文档里勾掉的项，代码里必须真有；文档没承诺的接口，llms.txt 也不能许诺
import fs from 'node:fs';
const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const rows = [];
const push = (name, ok, seen) => { rows.push({ name, ok: !!ok, seen }); };

const get = async (p) => {
  const r = await fetch(BASE + p, { headers: { 'cache-control': 'no-cache' } });
  return { s: r.status, h: r.headers, t: await r.text() };
};
const pick = (t, re) => { const m = t.match(re); return m ? m[0] : ''; };
const robotsOf = (t) => pick(t, /<meta name="robots" content="[^"]*">/).replace(/.*content="([^"]*)".*/, '$1');
const canonOf = (t) => pick(t, /<link rel="canonical"[^>]*>/).replace(/.*href="([^"]*)".*/, '$1');

const home = await get('/');
const homeOrigin = new URL(canonOf(home.t)).origin;
push('/ 可索引', robotsOf(home.t).startsWith('index'), robotsOf(home.t));
push('/ canonical 自指', canonOf(home.t) === homeOrigin + '/', canonOf(home.t));

const cases = [
  ['/?range=month', '筛选：时间范围'],
  ['/?page=2', '分页：第 2 页'],
  ['/?q=rust', '筛选：关键词'],
  ['/?cat=ai', '筛选：分类'],
  ['/?lang=en', '筛选：语言'],
];
for (const [p, label] of cases) {
  const r = await get(p);
  push(`${label} noindex`,
    robotsOf(r.t) === 'noindex,follow' && canonOf(r.t) === homeOrigin + '/' && /no-store/.test(r.h.get('cache-control') || ''),
    { robots: robotsOf(r.t), canon: canonOf(r.t), cc: r.h.get('cache-control') });
}

const viewRoute = await get('/?page=articles');
push('视图路由 ?page=articles 不误伤', robotsOf(viewRoute.t).startsWith('index'), robotsOf(viewRoute.t));
const defaultSort = await get('/?sort=stars');
push('默认值 ?sort=stars 不误伤', robotsOf(defaultSort.t).startsWith('index'), robotsOf(defaultSort.t));

const list = await get('/articles');
const ld = pick(list.t, /<script type="application\/ld\+json">[^<]*ItemList[^<]*<\/script>/);
let items = 0;
let firstUrl = '';
try {
  const json = JSON.parse(ld.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
  items = Array.isArray(json.itemListElement) ? json.itemListElement.length : 0;
  firstUrl = items ? json.itemListElement[0].url || '' : '';
} catch (e) {}
push('/articles 有 ItemList', items >= 2, items);
push('ItemList 的 url 是文章页', firstUrl.indexOf(homeOrigin + '/articles/') === 0, firstUrl);

const art = await get('/articles/tech/4.html');
push('文章页 canonical 自指', canonOf(art.t) === homeOrigin + '/articles/tech/4.html', canonOf(art.t));
push('文章页有 BlogPosting', /"BlogPosting"/.test(art.t), '');

const nf = await get('/no-such-page-' + Date.now());
push('404 页 noindex', nf.s === 404 && /noindex/.test(robotsOf(nf.t)), { status: nf.s, robots: robotsOf(nf.t) });

const doc = fs.readFileSync('docs/SEO-GEO规划.md', 'utf8');
push('文档：404 页已勾选', /\[x\] 404 页面/.test(doc), '');
push('文档：ItemList 已勾选', /\[x\] 文章列表 `ItemList`/.test(doc), '');
push('文档：noindex 已写明', /noindex,follow/.test(doc), '');
const llms = (await get('/llms.txt')).t;
push('llms.txt 写到了已实现的 /api/rank', /\/api\/rank/.test(llms), '');

let failed = 0;
for (const r of rows) {
  console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (typeof r.seen === 'object' ? '  → ' + JSON.stringify(r.seen) : (r.seen === '' ? '' : '  → ' + r.seen)));
  if (!r.ok) failed++;
}
console.log(failed ? `\n${failed} FAILED of ${rows.length}` : `\nALL OK (${rows.length})  @${BASE}`);
process.exit(failed ? 1 : 0);
