// SEO 自检：标题/描述/canonical/分享卡/结构化数据/sitemap 一致性
// 不依赖浏览器：全部走 HTTP，既可对本地 dev-server 跑，也可对线上跑。
//   node scripts/check-seo.mjs                      # 本地 8123
//   node scripts/check-seo.mjs https://site.example # 线上
const base = (process.argv[2] || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const t = Date.now();

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fails.push(name + (extra ? '  → ' + extra : ''));
}

const cache = new Map();
async function get(path) {
  const key = path;
  if (cache.has(key)) return cache.get(key);
  const r = await fetch(base + path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + t);
  const body = await r.text();
  const rec = { status: r.status, body };
  cache.set(key, rec);
  return rec;
}

const meta = (h, name) => {
  const re = new RegExp('<meta\\s+(?:name|property)=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
  const m = h.match(re);
  return m ? m[1] : null;
};
const canonical = (h) => {
  const m = h.match(/<link\s+rel=["']canonical["'][^>]*href=["']([^"']*)["']/i);
  return m ? m[1] : null;
};
const title = (h) => {
  const m = h.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
};
const h1s = (h) => (h.match(/<h1[\s>]/g) || []).length;
function lds(h) {
  return [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

// 站点对外的规范域名取自页面自己的 canonical（本地跑时它是线上域名，这是对的）
const SITE = new URL(canonical((await get('/')).body) || base).origin;
const PAGES = [
  { path: '/', canon: SITE + '/', name: '首页' },
  { path: '/articles', canon: SITE + '/articles', name: '文章页' },
  { path: '/faq', canon: SITE + '/faq', name: '问答页' },
  { path: '/nav', canon: SITE + '/nav', name: '导航页' },
];

const titles = new Map();
for (const p of PAGES) {
  const { status, body } = await get(p.path);
  ok(p.name + ' 返回 200', status === 200, 'status=' + status);
  const tt = title(body);
  ok(p.name + ' 有 <title>', !!tt);
  ok(p.name + ' 标题不与别的页重复', tt && !titles.has(tt), tt && titles.get(tt));
  titles.set(tt, p.name);
  const d = meta(body, 'description');
  ok(p.name + ' 有 description 且 30–200 字', !!d && d.length >= 30 && d.length <= 200, d ? d.length + ' 字' : '缺失');
  ok(p.name + ' canonical 指向自己', canonical(body) === p.canon, canonical(body) + ' ≠ ' + p.canon);
  const ogt = meta(body, 'og:title');
  const ogd = meta(body, 'og:description');
  const ogu = meta(body, 'og:url');
  const ogi = meta(body, 'og:image');
  ok(p.name + ' 有分享卡标题/描述', !!ogt && !!ogd);
  ok(p.name + ' og:url 与 canonical 一致', ogu === canonical(body), ogu + ' ≠ ' + canonical(body));
  ok(p.name + ' 有 1200 宽的分享图', !!ogi && /\.png$/i.test(ogi), ogi);
  ok(p.name + ' twitter:card 是大图', meta(body, 'twitter:card') === 'summary_large_image');
  ok(p.name + ' 只有一个 h1', h1s(body) === 1, 'h1 × ' + h1s(body));
  ok(p.name + ' 没有 noindex', !/name=["']robots["'][^>]*noindex/i.test(body));
  const ld = lds(body);
  if (p.path === '/' || p.path === '/faq' || p.path === '/nav') {
    ok(p.name + ' 结构化数据可解析', ld.length > 0 && ld.every((s) => { try { JSON.parse(s); return true; } catch (e) { return false; } }));
  }
}

// 文章页：标题/描述/分享图/canonical 都要是这一篇的
const sm = await (await fetch(base + '/sitemap.xml?t=' + t)).text();
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
ok('sitemap 有 4 个以上地址', locs.length >= 4, String(locs.length));
ok('sitemap 无重复地址', new Set(locs).size === locs.length);
ok('sitemap lastmod 是 YYYY-MM-DD', locs.length > 0 && /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sm));

const artLoc = locs.find((u) => /\/articles\/[^/]+\/\d+\.html$/.test(u));
ok('sitemap 里有文章详情地址', !!artLoc, locs.join(','));
if (artLoc) {
  const path = new URL(artLoc).pathname;
  const { status, body } = await get(path);
  ok('文章详情页返回 200', status === 200);
  ok('文章详情页 canonical 指向自己', canonical(body) === artLoc, canonical(body));
  ok('文章详情页 og:url 一致', meta(body, 'og:url') === artLoc, meta(body, 'og:url'));
  ok('文章详情页有自己的标题', (title(body) || '').indexOf('GitHub 热门项目排行榜') >= 0 && (title(body) || '').length > 8);
  ok('文章详情页有分享图', !!meta(body, 'og:image'));
  const ld = lds(body);
  ok('文章详情页 BlogPosting 可解析', ld.length > 0 && ld.some((s) => s.indexOf('BlogPosting') >= 0 && (() => { try { JSON.parse(s); return true; } catch (e) { return false; } })()));
  ok('文章详情页允许索引', !/name=["']robots["'][^>]*noindex/i.test(body));
}

// sitemap 里每个地址都必须 canonical 到自己——这条能抓住「/nav 其实是首页副本」那类问题
const dup = [];
for (const loc of locs) {
  const path = new URL(loc).pathname;
  const { status, body } = await get(path);
  if (status !== 200) { dup.push(loc + ' → ' + status); continue; }
  if (canonical(body) !== loc) dup.push(loc + ' → ' + canonical(body));
}
ok('sitemap 每个地址的 canonical 都指向自己', dup.length === 0, dup.join(' | '));

// sitemap 里不能有 noindex 的地址（例如加密文章整页 noindex，却还挂在 sitemap 上）
const noidx = [];
for (const loc of locs.filter((u) => /\/articles\/[^/]+\/\d+\.html$/.test(u))) {
  const { body } = await get(new URL(loc).pathname);
  if (/name=["']robots["'][^>]*noindex/i.test(body)) noidx.push(loc);
}
ok('sitemap 不含 noindex 的文章页', noidx.length === 0, noidx.join(' | '));

const robots = await (await fetch(base + '/robots.txt?t=' + t)).text();
ok('robots.txt 声明了 sitemap', /Sitemap:\s*https?:\/\/\S+/.test(robots));
const llms = await fetch(base + '/llms.txt?t=' + t);
ok('llms.txt 可访问', llms.status === 200);

console.log('');
if (fails.length) {
  console.log('FAIL ' + fails.length + ' / ' + (pass + fails.length));
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('ALL OK (' + pass + ')');
