// 验证脚本：模拟 Workers 运行时（caches + fetch 打桩读本地文件 / 假 GitHub API），检查本轮改动
// 用法：node scripts/check-worker.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(process.cwd());
const src = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
const copy = path.join(os.tmpdir(), 'ghrank-worker-check-' + Date.now() + '.mjs');
fs.writeFileSync(copy, src);

const store = new Map();
const cache = {
  async match(req) {
    const v = store.get(req.url);
    return v ? new Response(v.body, { status: v.status, headers: v.headers }) : undefined;
  },
  async put(req, res) {
    const body = Buffer.from(await res.clone().arrayBuffer());
    store.set(req.url, { body, status: res.status, headers: [...res.headers] });
  },
  async delete(req) {
    store.delete(req.url);
  },
};
globalThis.caches = { default: cache };

let rawCount = 0;
let apiCount = 0;
const jsonResp = (o) =>
  new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    rawCount++;
    const rel = decodeURIComponent(url.split('/main/')[1] || '');
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(p));
  }
  if (url.startsWith('https://api.github.com/')) {
    apiCount++;
    if (url.includes('/contents/data/')) {
      const rel = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
      const p = path.join(root, rel);
      const buf = fs.existsSync(p) ? fs.readFileSync(p) : Buffer.from('');
      return jsonResp({ sha: 'sha-' + rel.replace(/\W/g, ''), content: buf.toString('base64') });
    }
    if (url.includes('/commits')) {
      return jsonResp([{ commit: { committer: { date: new Date(Date.now() - 2 * 86400000).toISOString() } } }]);
    }
    if (url.includes('/actions/workflows')) {
      return jsonResp({
        workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: new Date(Date.now() - 3600000).toISOString() }],
      });
    }
    return jsonResp({ sha: 'abc123', content: { sha: 'abc123' } });
  }
  throw new Error('unexpected fetch: ' + url);
};

const mod = await import('file://' + copy.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':'));
const env = {
  GITHUB_TOKEN: 'token',
  REPO_OWNER: 'xiaoh2018',
  REPO_NAME: 'github-rank',
  ADMIN_PASSWORD: 'pw',
};
const ctx = { waitUntil() {} };
const hit = (p, opt) => mod.default.fetch(new Request('https://github.661026.xyz' + p, opt || {}), env, ctx);

let fail = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log('  PASS  ' + label);
  else {
    fail++;
    console.log('  FAIL  ' + label + (detail ? '  →  ' + detail : ''));
  }
};

console.log('== 1. 首页 head 注入 ==');
let r = await hit('/');
let html = await r.text();
ok(r.status === 200, 'GET / → 200', 'status=' + r.status);
ok(html.includes('content="https://github.661026.xyz/og-image.png"'), 'og:image 指向新域名分享图');
ok(/<meta name="twitter:card" content="summary_large_image">/.test(html), 'twitter:card = summary_large_image');
ok(/<meta name="twitter:image" content="https:\/\/github\.661026\.xyz\/og-image\.png">/.test(html), 'twitter:image 已注入');
ok(html.includes('rel="canonical" href="https://github.661026.xyz/"'), 'canonical = github.661026.xyz');
ok(html.includes('property="og:url" content="https://github.661026.xyz/"'), 'og:url = github.661026.xyz');

console.log('== 2. 分享图托管 ==');
r = await hit('/og-image.png');
let pngBuf = Buffer.from(await r.arrayBuffer());
ok(r.status === 200 && pngBuf.length === fs.statSync(path.join(root, 'og-image.png')).size, 'GET /og-image.png → 200 且字节数一致', r.status + ' ' + pngBuf.length);
ok(pngBuf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', '返回的是合法 PNG（文件头 89 50 4E 47）');
ok((r.headers.get('content-type') || '').includes('image/png'), 'content-type = image/png', r.headers.get('content-type'));
ok(/max-age=300/.test(r.headers.get('cache-control') || ''), '分享图走 shell 档缓存（浏览器 300 秒，边缘 1 天）', r.headers.get('cache-control'));
ok(!!r.headers.get('etag'), '分享图带 ETag', r.headers.get('etag'));
r = await hit('/og-image.png', { method: 'HEAD' });
ok(r.status === 200 && !(await r.arrayBuffer()).byteLength, 'HEAD /og-image.png → 200 且 0 字节');

console.log('== 3. /api/status 边缘缓存 ==');
const before = apiCount;
r = await hit('/api/status');
const s1 = await r.json();
const firstCost = apiCount - before;
ok(s1.configured === true && s1.lastKeepalive, '/api/status 正常返回', JSON.stringify(s1).slice(0, 120));
ok(firstCost === 2, '首次请求打 2 次 GitHub API（并行）', 'apiCount+' + firstCost);
const mid = apiCount;
r = await hit('/api/status');
const s2 = await r.json();
ok(apiCount === mid, '第二次请求不回源（命中边缘缓存）', 'apiCount+' + (apiCount - mid));
ok(s2.lastKeepalive === s1.lastKeepalive, '两次返回内容一致');

console.log('== 4. 保活后自动清状态缓存 ==');
r = await hit('/api/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw' }),
});
const keep = await r.json();
ok(keep.ok === true, 'POST /api/run 保活成功', JSON.stringify(keep).slice(0, 120));
const afterKeep = apiCount;
r = await hit('/api/status');
await r.json();
ok(apiCount - afterKeep === 2, '保活后状态缓存已被 purge，重新回源', 'apiCount+' + (apiCount - afterKeep));

console.log('== 5. 文章页 canonical ==');
r = await hit('/articles');
const art = await r.text();
ok(art.includes('rel="canonical" href="https://github.661026.xyz/articles"'), 'articles canonical = github.661026.xyz/articles');

console.log('== 6. 后台保存后静态文件立刻换新（warmEdge）==');
// 先访问一次，让 /data/links.json 进成品缓存（内容是仓库里的旧值）
const linksFile = JSON.parse(fs.readFileSync(path.join(root, 'data/links.json'), 'utf8'));
r = await hit('/data/links.json');
const linksServed = await r.json();
ok(JSON.stringify(linksServed) === JSON.stringify(linksFile), 'GET /data/links.json 与仓库文件一致', JSON.stringify(linksServed).slice(0, 80));
// 后台加一条友链
r = await hit('/api/links', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', action: 'add', name: '测试站', url: 'https://example.com/' }),
});
const addRes = await r.json();
ok(addRes.ok === true, 'POST /api/links 添加成功', JSON.stringify(addRes).slice(0, 100));
// 不睡眠、不重试，立刻读静态文件：必须已经是新内容
r = await hit('/data/links.json');
const linksAfter = await r.json();
ok(linksAfter.some((l) => l && l.url === 'https://example.com/'), '保存后立刻 GET /data/links.json 就能看到新友链', JSON.stringify(linksAfter).slice(0, 120));
ok(r.headers.get('x-edge') === 'HIT', '这次读的是 warmEdge 写好的成品缓存（x-edge=HIT）', r.headers.get('x-edge'));

console.log('== 7. 榜单布局保存后立刻生效 ==');
r = await hit('/data/site.json');
const siteBefore = await r.json();
ok(siteBefore.layout && typeof siteBefore.layout.mode === 'string', 'GET /data/site.json 有 layout.mode', JSON.stringify(siteBefore.layout));
const want = siteBefore.layout.mode === 'single' ? 'double' : 'single';
r = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'layout', value: { mode: want } }),
});
const siteRes = await r.json();
ok(siteRes.ok === true && siteRes.site.layout.mode === want, 'POST /api/site 保存 layout=' + want, JSON.stringify(siteRes).slice(0, 100));
r = await hit('/data/site.json');
const siteAfter = await r.json();
ok(siteAfter.layout.mode === want, '保存后立刻 GET /data/site.json 就是新布局（不再等 5~15 分钟）', siteAfter.layout.mode);
const cfgCC = r.headers.get('cache-control') || '';
ok(/max-age=60/.test(cfgCC) && !/max-age=600/.test(cfgCC), '后台可改的 JSON 只缓存 60 秒（不再是 600/900）', cfgCC);
r = await hit('/data/repos-week.js');
const dataCC = r.headers.get('cache-control') || '';
ok(/max-age=600/.test(dataCC), '榜单数据文件仍然是长缓存 600 秒（省流量靠它）', dataCC);

console.log('== 8. 既有能力没被破坏 ==');
r = await hit('/');
const firstEdge = r.headers.get('x-edge');
ok(!!firstEdge, '首页带 x-edge 头（' + firstEdge + '）');
await hit('/');
const secondEdge = (await hit('/')).headers.get('x-edge');
ok(secondEdge === 'HIT', '二次访问命中边缘缓存', secondEdge);
r = await hit('/nope');
ok(r.status === 404, '未知路径 → 404', String(r.status));

console.log('== 9. 后台改版（SEO+GEO 合并 / 文章独立 / 翻译页）==');
r = await hit('/admin');
const adminHtml = await r.text();
ok(r.status === 200, 'GET /admin → 200', String(r.status));
ok(adminHtml.indexOf('pane-articles') >= 0, '文章已有独立面板（pane-articles）');
ok(adminHtml.indexOf('pane-geo') < 0, '旧的 GEO 独立面板已并进 SEO');
ok(adminHtml.indexOf('id="geo-summary"') >= 0, 'GEO 摘要在 SEO 面板里');
ok(adminHtml.indexOf('navgroup') >= 0, '侧栏按 常用/内容/站点信息/运维 分组');
ok(adminHtml.indexOf('id="artDlg" class="wide"') >= 0, '写文章弹窗已放大（wide）');
ok(adminHtml.indexOf('id="artSearch"') >= 0, '文章列表带搜索框');
ok(adminHtml.indexOf('id="trStatus"') >= 0, '翻译页显示密钥与绑定状态');

r = await hit('/api/status');
const st9 = await r.json();
ok(st9.translator && typeof st9.translator.ai === 'boolean', '/api/status 报告 Workers AI 是否绑定', JSON.stringify(st9.translator));

r = await hit('/api/translate');
const trGet = await r.json();
ok(trGet.ok === true && trGet.status && typeof trGet.status.ai === 'boolean', 'GET /api/translate 返回翻译能力状态', JSON.stringify(trGet).slice(0, 120));

r = await hit('/api/translate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', text: 'hello world' }),
});
const trPost = await r.json();
ok(trPost.ok === true && trPost.myMemory && trPost.ai, 'POST /api/translate 同时试 MyMemory 与 Workers AI', JSON.stringify(trPost).slice(0, 140));

console.log('== 10. 榜单布局三档 + 缓存细节 ==');
r = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'layout', value: { mode: 'triple', side: 'below', users: 'double' } }),
});
const layRes = await r.json();
const lay = (layRes.site && layRes.site.layout) || {};
ok(layRes.ok === true && lay.mode === 'triple' && lay.side === 'below' && lay.users === 'double', '布局可存 三列 / 侧栏下沉 / 用户榜两列', JSON.stringify(lay));

r = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'layout', value: { mode: 'quad' } }),
});
const badLay = await r.json();
ok(badLay.ok === false, '非法布局值被拒绝', JSON.stringify(badLay).slice(0, 80));

r = await hit('/data/repos-week.js?v=test123');
const immCC = r.headers.get('cache-control') || '';
ok(/immutable/.test(immCC), '带 ?v= 的数据文件一年 immutable', immCC);

r = await hit('/?t=' + Date.now());
ok((r.headers.get('link') || '').indexOf('rel=preload') >= 0, '首页带 Link: preload 头', r.headers.get('link'));

// ---- 11. 广告位（5 个位置独立开关）----
console.log('== 11. 广告位 ==');
r = await hit('/admin');
const adAdminHtml = await r.text();
const slotIds = ['home-top', 'list-top', 'list-bottom', 'sidebar', 'article'];
const slotMissing = slotIds.filter((id) => adAdminHtml.indexOf('data-ad-slot="' + id + '"') < 0);
ok(slotMissing.length === 0, '后台 5 个广告位都在', slotMissing.join(',') || 'ok');

r = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    password: 'pw',
    section: 'ad',
    value: {
      slots: {
        'list-top': { enabled: true, html: '<b id="x">ad</b>' },
        sidebar: { enabled: false, html: 's' },
      },
    },
  }),
});
const adRes = await r.json();
const adSlots = (adRes.site && adRes.site.ad && adRes.site.ad.slots) || {};
ok(adRes.ok === true && adSlots['list-top'] && adSlots['list-top'].enabled === true, '广告位按槽保存', JSON.stringify(adSlots).slice(0, 120));
ok(!!adSlots['home-top'] && adSlots['home-top'].enabled === false, '没勾的槽保持关闭', JSON.stringify(adSlots['home-top']));
ok(!!adSlots.sidebar && adSlots.sidebar.html === 's', '各槽 html 互相独立', JSON.stringify(adSlots.sidebar));

r = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'ad', value: { slots: { bogus: { enabled: true, html: '' } } } }),
});
const badAd = await r.json();
ok(badAd.ok === false && /广告位/.test(badAd.error || ''), '未知广告位被拒绝', String(badAd.error).slice(0, 60));

r = await hit('/');
const adHomeHtml = await r.text();
ok(adHomeHtml.indexOf('id="adHomeTop"') >= 0 && adHomeHtml.indexOf('id="adSidebar"') >= 0, '前台 5 个广告容器都在');

// ---- 12. 导航页 + 收录提交 ----
console.log('== 12. 导航页 + 收录提交 ==');
r = await hit('/admin');
const navAdminHtml = await r.text();
ok(navAdminHtml.indexOf('id="pane-nav"') >= 0 && navAdminHtml.indexOf('id="navAdmin"') >= 0, '后台有导航页面板');
ok(navAdminHtml.indexOf('data-tab="submit"') >= 0 && navAdminHtml.indexOf('id="pane-submit"') >= 0, '后台有收录提交面板');

r = await hit('/api/nav');
const navRes = await r.json();
const navGroups = (navRes.nav && navRes.nav.groups) || [];
ok(navRes.ok === true && navGroups.length >= 5, 'GET /api/nav 返回分类', navGroups.length + ' 组');
const navItemTotal = navGroups.reduce((n, g) => n + ((g.items || []).length), 0);
ok(navItemTotal >= 20, '导航站点数合理', navItemTotal + ' 站');

const navBody = JSON.stringify({
  password: 'pw',
  nav: { groups: [{ id: 'T1', name: '测试分类', desc: '', items: [{ name: '', url: 'https://example.com', desc: '', icon: '' }] }] },
});
r = await hit('/api/nav', { method: 'POST', headers: { 'content-type': 'application/json' }, body: navBody });
const navSave = await r.json();
const savedG = (navSave.nav && navSave.nav.groups && navSave.nav.groups[0]) || {};
ok(navSave.ok === true, 'POST /api/nav 保存成功');
ok(savedG.id === 't1' && savedG.name === '测试分类', '分类 id 被规范化成小写', JSON.stringify(savedG).slice(0, 80));
ok(savedG.items && savedG.items[0] && savedG.items[0].name === 'example.com', '站点没填名称时用域名兜底', JSON.stringify(savedG.items));

r = await hit('/api/nav', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong', nav: { groups: [] } }) });
ok((await r.json()).ok === false, '导航页保存要密码');

r = await hit('/data/nav.json');
await r.text();
ok(((r.headers.get('cache-control') || '').indexOf('max-age=60') >= 0), '导航 JSON 也是 60 秒短缓存', r.headers.get('cache-control'));

r = await hit('/api/fetch-meta?url=' + encodeURIComponent('http://127.0.0.1/'));
ok((await r.json()).ok === false, '拒绝抓取本机地址');
r = await hit('/api/fetch-meta?url=' + encodeURIComponent('file:///etc/passwd'));
ok((await r.json()).ok === false, '拒绝非 http(s) 地址');

r = await hit('/robots.txt');
const robots = await r.text();
ok(robots.indexOf('User-agent: GPTBot') >= 0 && robots.indexOf('User-agent: Bytespider') >= 0 && robots.indexOf('Sitemap:') >= 0, 'robots.txt 放行 AI 抓取器并带 sitemap');
ok(((r.headers.get('cache-control') || '').indexOf('max-age=') >= 0), 'robots.txt 有缓存头', r.headers.get('cache-control'));

r = await hit('/llms.txt');
const llms = await r.text();
ok(r.status === 200 && llms.indexOf('# ') === 0 && llms.indexOf('## 页面') > 0, 'llms.txt 有站点说明');
ok(llms.indexOf('/sitemap.xml') > 0 && llms.indexOf('## 数据说明') > 0, 'llms.txt 含 sitemap 与数据说明');

r = await hit('/sitemap.xml');
const sitemap = await r.text();
ok(r.status === 200 && sitemap.indexOf('<urlset') >= 0, 'sitemap.xml 可访问');
ok(sitemap.indexOf('articles') > 0, 'sitemap 含文章页');

r = await hit('/api/submit');
const subStatus = await r.json();
const subKey = (subStatus.status && subStatus.status.indexNowKey) || '';
ok(subStatus.ok === true && !!subKey, 'GET /api/submit 返回 IndexNow key', subKey);
r = await hit('/' + subKey + '.txt');
ok((await r.text()).trim() === subKey, 'IndexNow key 文件可访问');

r = await hit('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw', action: 'all' }) });
const subRun = await r.json();
ok(Array.isArray(subRun.urlList) && subRun.urlList.length > 0, '提交返回里带本次推送地址清单（urlList）', String(subRun.urlList && subRun.urlList.length));
ok(subRun.ok === true && subRun.results && subRun.results.indexNow && subRun.results.indexNow.ok === false, 'IndexNow 不通时返回原因而不是报错', JSON.stringify(subRun.results.indexNow || {}).slice(0, 100));
ok(subRun.results && subRun.results.baidu && subRun.results.baidu.ok === false, '没配 BAIDU_TOKEN 时跳过百度推送');

r = await hit('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x', action: 'all' }) });
ok((await r.json()).ok === false, '提交也要密码');

// ---- 13. 导航视图可以直接打开（/nav、/?page=nav） ----
console.log('13. 导航视图');
r = await hit('/nav');
const navPage = await r.text();
ok(r.status === 200, '/nav 返回 200');
ok((r.headers.get('content-type') || '').indexOf('text/html') >= 0, '/nav 是 HTML');
ok(navPage.indexOf('id="tabNav"') > 0, '/nav 的页面里有导航标签');
ok(navPage.indexOf('page=nav') > 0, '页面里记下了 page=nav 的意图（bundle.js 会重写地址栏）');
const navCc = r.headers.get('cache-control') || '';
ok(navCc.indexOf('max-age=300') >= 0, '/nav 与首页同一档缓存', navCc);
r = await hit('/?page=nav');
ok(r.status === 200, '/?page=nav 返回 200');

console.log('');
// ---- 14. 总榜 + README 渲染 ----
console.log('14. 总榜与 README');
r = await hit('/data/repos-total.js');
const totalJs = await r.text();
ok(r.status === 200, '/data/repos-total.js 返回 200');
ok((r.headers.get('content-type') || '').indexOf('javascript') >= 0, '总榜文件是 JS');
const totalCc = r.headers.get('cache-control') || '';
ok(totalCc.indexOf('max-age=600') >= 0 && totalCc.indexOf('s-maxage=900') >= 0, '总榜走榜单数据缓存档（600/900）', totalCc);
const totalRange = /window\.__GHRANK_RANGES__\["total"\]/.test(totalJs);
ok(totalRange, '总榜文件里有 __GHRANK_RANGES__["total"]');
// 数据文件是 JS 字面量（键不加引号），不能用 JSON.parse，直接当脚本跑一遍取 window
let totalRepos = [];
try {
  const sandbox = {};
  new Function('window', totalJs)(sandbox);
  const bag = sandbox.__GHRANK_RANGES__ || {};
  const rr = bag.total || bag.all || {};
  totalRepos = rr.repos || [];
} catch (e) {
  ok(false, '总榜文件能被当成脚本执行', e.message);
}
ok(totalRepos.length >= 400, '总榜条数足够（≥400）', totalRepos.length);
ok(totalRepos.every((x, i) => i === 0 || totalRepos[i - 1].stars >= x.stars), '总榜按星标降序');
ok(totalRepos[0] && totalRepos[0].stars > 500000, '总榜第一名星标 >50 万', totalRepos[0] && totalRepos[0].stars);
const fullTop = await hit('/');
const fullHtml = await fullTop.text();
ok(fullHtml.indexOf('data-range="total"') > 0, '首页有总榜标签');
ok(fullHtml.indexOf('总榜') > 0, '首页文案里有「总榜」');
ok(fullHtml.indexOf('readme-body') > 0, '首页带了 README 渲染样式');
r = await hit('/js/bundle.js');
const bundleJs = await r.text();
ok(bundleJs.indexOf('sanitizeReadme') > 0, 'bundle.js 里有 README 的 HTML→Markdown 转换');
ok(bundleJs.indexOf("el('pre', 'readme'") < 0, 'README 不再用 <pre> 显示原始文本');
ok(bundleJs.indexOf('中文翻译中') < 0, '去掉了「中文翻译中…」提示');
ok(bundleJs.indexOf('aria-busy') > 0, '加载中给榜单加了 aria-busy');
ok(bundleJs.indexOf('empty-item') > 0 && bundleJs.indexOf('清空筛选') > 0, '无结果时渲染空态卡片（带「清空筛选」按钮）');
ok(bundleJs.indexOf('readmeWrap') > 0, '译文到了只替换 README 块');

// ---- 15. 信息流广告（榜单 / 文章 / 导航卡片之间）----
console.log('15. 信息流广告');
const inlAdmin = await hit('/admin');
const inlAdminHtml = await inlAdmin.text();
for (const id of ['list-inline', 'article-inline', 'nav-inline']) {
  ok(inlAdminHtml.indexOf('data-ad-slot="' + id + '"') > 0, '后台有信息流广告位：' + id);
}
const inlSave = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'ad', value: { slots: { 'list-inline': { enabled: true, html: '<b>中间广告</b>' } } } })
});
const inlSaveJson = await inlSave.json();
ok(inlSaveJson.ok === true, '信息流广告位可以保存');
const inlSlots = (inlSaveJson.site && inlSaveJson.site.ad && inlSaveJson.site.ad.slots) || {};
ok(inlSlots['list-inline'] && inlSlots['list-inline'].enabled === true, '保存响应里 list-inline 已打开', JSON.stringify(inlSlots['list-inline']));
ok(String((inlSlots['list-inline'] || {}).html).indexOf('中间广告') >= 0, '保存响应里 html 正确');
ok(inlSlots['nav-inline'] && inlSlots['nav-inline'].enabled === false, '没勾的信息流位置保持关闭');
const inlHome = await (await hit('/')).text();
ok(inlHome.indexOf('ghrankMountInline') > 0 || inlHome.indexOf('data-ad-inline') > 0, '首页脚本带信息流挂载逻辑');
const inlBundle = await (await hit('/js/bundle.js')).text();
ok(inlBundle.indexOf("'data-ad-inline', 'list'") > 0 || inlBundle.indexOf("data-ad-inline") > 0, '榜单渲染时插入信息流占位');
ok(inlBundle.indexOf('ghrankAdEvery') > 0 && inlBundle.indexOf('% adEvery') > 0, '榜单信息流间隔从配置读取');
const inlBad = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'ad', value: { slots: { 'nope-inline': { enabled: true, html: 'x' } } } })
});
const inlBadJson = await inlBad.json();
ok(inlBadJson.ok === false, '未知信息流位置被拒绝');
console.log('16. 顶部导航 / 滚动条 / 广告点击 / 间隔可配');
const uiHome = await (await hit('/')).text();
ok(uiHome.indexOf('id="mainNav"') > 0, '首页顶部有主导航容器');
ok(uiHome.indexOf('class="mnav') > 0, '主导航有榜单/导航入口');
ok(uiHome.indexOf('href="/articles"') > 0, '顶部有文章入口');
ok(uiHome.indexOf('id="adTicker"') > 0, '首页有顶部滚动条容器');
ok(uiHome.indexOf('id="adModal"') > 0, '首页有广告弹窗容器');
const uiAdm = await (await hit('/admin')).text();
ok(uiAdm.indexOf('id="ticker-enabled"') > 0, '后台可以设置滚动条');
ok(uiAdm.indexOf('data-ad-field="every"') > 0, '后台可以设置信息流间隔');
ok(uiAdm.indexOf('data-ad-field="modal"') > 0, '后台可以设置点击弹窗');
const evSave = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'ad', value: { slots: { 'list-inline': { enabled: true, html: '<b>ad</b>', every: 5 } }, ticker: { enabled: true, text: '公告一句话', speed: 12, link: 'https://example.com' } } })
});
const evJson = await evSave.json();
ok(evJson.ok === true, '广告设置（间隔 + 滚动条）可以保存');
const evAd = (evJson.site && evJson.site.ad) || {};
ok(!!(evAd.slots && evAd.slots['list-inline'] && evAd.slots['list-inline'].every === 5), '间隔按后台填的值保存');
ok(!!(evAd.ticker && evAd.ticker.enabled === true && evAd.ticker.text === '公告一句话'), '滚动条设置保存成功');
const evSpeedBad = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'ad', value: { slots: { 'list-inline': { enabled: true, html: 'x', every: 0 } } } })
});
ok((await evSpeedBad.json()).ok === false, '间隔 0 被拒绝');
const tkBad = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'ad', value: { slots: {}, ticker: { enabled: true, text: '' } } })
});
ok((await tkBad.json()).ok === false, '滚动条开启但没文字被拒绝');
const smXml = await (await hit('/sitemap.xml')).text();
ok(smXml.indexOf('/nav</loc>') > 0, 'sitemap 里带上导航页');


console.log('');
console.log('== 17. 后台内联脚本可解析 + 面板齐全 ==');
const adminPage = await (await hit('/admin')).text();
ok(adminPage.includes('subTimer') && adminPage.includes('冷却中'), '收录提交面板有冷却倒计时');
ok(adminPage.includes('urlList'), '收录提交面板能展开本次推送地址');
ok(adminPage.includes('healthBox') && adminPage.includes('loadHealth'), '概览页有站点体检卡');
ok(adminPage.includes('data-copy="https://github.661026.xyz/sitemap.xml"'), '体检卡能一键复制 sitemap 地址');
ok(adminPage.includes('id="healthBar"'), '体检异常时概览页顶部有红条提示');
{
  const qaFaq = await (await hit('/faq')).text();
  ok(qaFaq.includes('data-qcopy'), '问答页每条能复制直达链接');
  ok(adminPage.includes('id="qaFilter"'), '后台问答列表有筛选框');
  const qaRaw = JSON.parse(fs.readFileSync('data/qa.json', 'utf8'));
  const qaLlms = await (await hit('/llms.txt')).text();
  if ((qaRaw.items || []).length) ok(qaLlms.includes('## 常见问答'), 'llms.txt 带常见问答段落');
  else ok(true, 'llms.txt 问答段（本地 qa.json 为空，跳过）');
}
ok(adminPage.includes('setInterval(tick, 1000)'), '倒计时每秒刷新');
ok(adminPage.includes('id="pane-submit"'), '后台有 pane-submit 面板');
const inlineScripts = [...adminPage.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
let badSyntax = '';
for (const code of inlineScripts) {
  try { new Function(code); } catch (e) { badSyntax = String((e && e.message) || e); }
}
ok(!badSyntax, '后台内联脚本语法正确（模板字面量里的 \\n 会被吃掉）', badSyntax);
const tabIds = [...adminPage.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
const missingPane = [...new Set(tabIds)].filter((t) => !adminPage.includes('id="pane-' + t + '"'));
ok(missingPane.length === 0, '每个侧栏标签都有对应面板', missingPane.join(','));

console.log('');
console.log('== 18. 翻译运行设置（后台可改） ==');
const rtAdmin = await (await hit('/admin')).text();
ok(rtAdmin.includes('id="rtEmails"') && rtAdmin.includes('id="rtAiCap"'), '后台有翻译邮箱与 AI 上限输入框');
ok(rtAdmin.includes('id="rtAlias"'), '后台有「按 +别名 生成」按钮');
ok(rtAdmin.includes('data-save="runtime"'), '运行设置有独立保存按钮');
const rtSave = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'runtime', value: { emails: ' a@x.com, b@y.com ,', aiCap: 1200 } })
});
const rtJson = await rtSave.json();
ok(rtJson.ok === true, '运行设置能保存');
ok(!!(rtJson.site && rtJson.site.runtime && rtJson.site.runtime.emails === 'a@x.com,b@y.com'), '邮箱去空格并按逗号归一化');
ok(!!(rtJson.site && rtJson.site.runtime && rtJson.site.runtime.aiCap === 1200), 'AI 上限按填的数字保存');
const rtBad = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'runtime', value: { emails: 'not-an-email', aiCap: 100 } })
});
ok((await rtBad.json()).ok === false, '邮箱格式不对被拒绝');
const rtBad2 = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'runtime', value: { emails: '', aiCap: 999999 } })
});
ok((await rtBad2.json()).ok === false, 'AI 上限超过 100000 被拒绝');
const rtZero = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'runtime', value: { emails: '', aiCap: 0 } })
});
const rtZeroJson = await rtZero.json();
ok(!!(rtZeroJson.ok && rtZeroJson.site.runtime.aiCap === 0), '填 0 = 不限制，也能保存');
const trStatus = await (await hit('/api/translate')).json();
ok(!!(trStatus.status && trStatus.status.aiCapSource), '链路状态里带上限来源（后台 / 环境变量）');

console.log('== 19. AI 用量 / 后台密钥 / IndexNow 自检 / llms.txt ==');
const a19UsageRes = await hit('/api/ai-usage');
const a19UsageJson = await a19UsageRes.json();
ok(a19UsageRes.status === 200 && a19UsageJson.ok === true, '/api/ai-usage 返回 200 与 ok');
ok(!!(a19UsageJson.usage && typeof a19UsageJson.usage.used === 'number'), '用量里带 used 数字');
ok(!!(a19UsageJson.usage && typeof a19UsageJson.usage.cap === 'number' && typeof a19UsageJson.usage.capSource === 'string'), '用量里带 cap 与来源');

const a19KeySave = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'runtime', value: { emails: '', aiCap: 400, baiduToken: 'tok_abc-123', indexNowKey: 'testkey-2026' } })
});
const a19KeyJson = await a19KeySave.json();
ok(!!(a19KeyJson.ok && a19KeyJson.site.runtime.indexNowKey === 'testkey-2026' && a19KeyJson.site.runtime.baiduToken === 'tok_abc-123'), '后台能存百度密钥与 IndexNow key');

const a19KeyBad = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'runtime', value: { emails: '', aiCap: 400, baiduToken: 'a b!', indexNowKey: '' } })
});
ok((await a19KeyBad.json()).ok === false, '百度密钥含空格/符号被拒');

// 测试桩不落盘，所以这里临时改一份 data/site.json 验证「后台填的 key 真的被用上」，跑完还原
const sitePath = 'data/site.json';
const siteBackup = fs.readFileSync(sitePath);
let a19Sub = null;
let a19KeyFile = null;
let a19KeyText = '';
try {
  const j = JSON.parse(siteBackup.toString('utf8'));
  j.runtime = { aiCap: 400, emails: '', baiduToken: 'tok_abc-123', indexNowKey: 'testkey-2026' };
  fs.writeFileSync(sitePath, JSON.stringify(j, null, 2) + '\n', 'utf8');
  a19Sub = await (await hit('/api/submit')).json();
  a19KeyFile = await hit('/testkey-2026.txt');
  a19KeyText = (await a19KeyFile.text()).trim();
} finally {
  fs.writeFileSync(sitePath, siteBackup);
  store.clear();
}

ok(!!(a19Sub.status && a19Sub.status.indexNowKey === 'testkey-2026'), '提交页用的是后台填的 key');
ok(!!(a19Sub.status && a19Sub.status.baiduTokenSource === 'admin'), '百度密钥来源标成 admin');
ok(typeof a19Sub.status.keyFileOk === 'boolean', '状态里带 key 文件自检结果');
ok(!!(a19Sub.status && a19Sub.status.aiUsage), '提交页状态带 AI 用量');
ok(a19KeyFile.status === 200 && a19KeyText === 'testkey-2026', '自定义 key 的 /<key>.txt 能打开且内容正确');

const a19Llms = await (await hit('/llms.txt')).text();
ok(a19Llms.includes('## 数据来源与口径') && a19Llms.includes('## 机器可读接口'), 'llms.txt 有数据口径与接口章节');
ok(a19Llms.includes('/nav') && a19Llms.includes('引用与抓取建议'), 'llms.txt 提到导航页与引用建议');

const a19Admin = await (await hit('/admin')).text();
ok(a19Admin.includes('IndexNow 一直失败') && a19Admin.includes('百度准入密钥在哪拿'), '后台有 IndexNow 排查与百度密钥教程');
ok(a19Admin.includes('id="rtUsage"') && a19Admin.includes('id="rtBaiduToken"') && a19Admin.includes('id="rtIndexKey"'), '运行设置里有用量块与两个密钥输入');

console.log('== 20. 文章加密（后台开关 + 前台解锁） ==');
const a20Admin = await (await hit('/admin')).text();
ok(a20Admin.includes('id="artLock"') && a20Admin.includes('id="artPw"'), '后台写文章弹窗有加密开关与密码框');
ok(a20Admin.includes('加密这篇'), '加密开关有中文说明');

const a20Add = await (await hit('/api/articles', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', action: 'add', article: { title: '加密测试', summary: '摘要', body: '这是密文正文', locked: true, password: 'abcd' } })
})).json();
ok(a20Add.ok === true, '加密文章能保存');
const a20One = (a20Add.articles || []).find((x) => x.title === '加密测试');
ok(!!(a20One && a20One.locked === true && a20One.hasLock === true), '列表里带 locked 与 hasLock');
ok(!!(a20One && a20One.body === '' && a20One.lock === undefined && a20One.password === undefined), '公开字段不含正文/口令/密文');

const a20Miss = await hit('/api/article', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'nope', password: 'x' })
});
ok(a20Miss.status === 404, '不存在的文章返回 404');

const a20Short = await (await hit('/api/articles', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', action: 'add', article: { title: '短密码', body: 'x', locked: true, password: 'ab' } })
})).json();
ok(a20Short.ok === false && String(a20Short.error).includes('至少 4 位'), '加密密码少于 4 位被拒');

const a20NoPw = await (await hit('/api/articles', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', action: 'add', article: { title: '没密码', body: 'x', locked: true } })
})).json();
ok(a20NoPw.ok === false && String(a20NoPw.error).includes('访问密码'), '勾了加密却没填密码被拒');
ok(a20Admin.includes('编辑时留空 = 沿用原密码'), '后台提示编辑时留空沿用原密码');

await hit('/api/articles', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', action: 'remove', id: a20One.id })
});

console.log('');
console.log('§21 问答（GEO）');

const qaAdmin = await (await hit('/admin')).text();
ok(qaAdmin.includes('id="pane-qa"'), '后台有问答面板');
ok(qaAdmin.includes('data-tab="qa"'), '侧栏有问答入口');
ok(qaAdmin.includes('id="qaList"'), '后台有问答列表容器');

const qaGet = await (await hit('/api/qa')).json();
ok(qaGet.ok === true && Array.isArray(qaGet.qa.items) && qaGet.qa.items.length >= 5, 'GET /api/qa 返回问答列表');

const qaBad = await hit('/api/qa', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'wrong', qa: { items: [] } })
});
ok(qaBad.status === 401, '密码不对保存问答被拒');

const qaSave = await (await hit('/api/qa', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    password: 'pw',
    qa: {
      intro: '测试导语',
      items: [
        { q: '问题一', a: '答案一', tag: '测试' },
        { q: '', a: '没有问题的答案会被丢掉', tag: '' }
      ]
    }
  })
})).json();
ok(qaSave.ok === true && qaSave.qa.intro === '测试导语', '保存问答：导语写回');
ok(Array.isArray(qaSave.qa.items) && qaSave.qa.items.length === 1, '保存问答：空问题被丢弃');

const faqPage = await hit('/faq');
const faqHtml = await faqPage.text();
ok(faqPage.status === 200, '/faq 返回 200');
ok(faqHtml.includes('application/ld+json') && faqHtml.includes('FAQPage'), '/faq 输出 FAQPage 结构化数据');
ok(faqHtml.includes('id="list"'), '/faq 有问答列表容器');

const qaFile = await hit('/data/qa.json');
ok((qaFile.headers.get('cache-control') || '').indexOf('max-age=60') >= 0, '/data/qa.json 走 60 秒配置档');

const sm21 = await (await hit('/sitemap.xml')).text();
ok(sm21.includes('/faq</loc>'), 'sitemap 含 /faq');
const llms21 = await (await hit('/llms.txt')).text();
ok(llms21.includes('/faq'), 'llms.txt 提到 /faq');


console.log('');
console.log('== 22. 后台 tab 化 / GEO 平台清单 / 平台验证码 ==');
const a22Admin = await (await hit('/admin')).text();
ok(a22Admin.includes('class="segtabs"'), '后台有分段 tab 容器');
ok(a22Admin.includes('data-adsec="fixed"') && a22Admin.includes('data-adsec="inline"') && a22Admin.includes('data-adsec="ticker"'), '广告面板分三段 tab');
ok(a22Admin.includes('geo-plat') && a22Admin.includes('字节 / 豆包'), '收录页有 GEO 平台矩阵');
ok(a22Admin.includes('side-extra') && a22Admin.includes('打开前台首页'), '侧栏有返回首页入口');
ok(a22Admin.includes('class="brandlink"'), '侧栏标题可点回首页');
ok(/var TABS = \[[^\]]*'qa'/.test(a22Admin), 'TABS 含 qa（否则点问答会跳概览）');
ok(a22Admin.includes('data-vf="bytedance"') && a22Admin.includes('data-vf="sogou"') && a22Admin.includes('data-vf="shenma"'), '设置页有平台验证码输入');
const a22Home = await (await hit('/')).text();
ok(a22Home.indexOf('{{GHRANK_VERIFY}}') < 0, '首页没有未替换的验证码占位');
ok(a22Home.includes('baidu-site-verification'), '首页保留百度验证 meta');
const a22Bad = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'runtime', value: { verify: { bytedance: 'x'.repeat(201) } } }),
});
const a22BadJson = await a22Bad.json();
ok(a22Bad.status === 400 || a22BadJson.ok === false, '验证码过长被拒');
const a22Good = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'runtime', value: { verify: { bytedance: 'byte-abc' } } }),
});
const a22GoodJson = await a22Good.json();
ok(a22Good.status === 200 && a22GoodJson.ok === true, '验证码可以保存');
console.log('');
console.log('== 23. 每个设置板块的保存→回读闭环 ==');
// 目的：后台每个面板点保存时，值要真的落到 /data/site.json，且前台读到的就是新值。
// 逐段 POST → 读 POST 响应 → 再 GET /data/site.json 比对，最后把原值写回去，互不污染。
const secs = [
  { section: 'contact', value: { enabled: true, title: '联系我', wechat: 'gr-test', email: 'a@b.co', note: 'n' }, path: (j) => j.contact && j.contact.title, want: '联系我' },
  { section: 'beian', value: { enabled: true, icp: '京ICP备00000000号', text: '备案' }, path: (j) => j.beian && j.beian.icp, want: '京ICP备00000000号' },
  { section: 'seo', value: { siteName: '测试站', title: 'T', description: 'D', keywords: 'k1,k2' }, path: (j) => j.seo && j.seo.siteName, want: '测试站' },
  { section: 'geo', value: { summary: '这是测试用的站点摘要' }, path: (j) => j.geo && j.geo.summary, want: '这是测试用的站点摘要' },
  { section: 'theme', value: { name: 'stripe', allowUser: false }, path: (j) => j.theme && j.theme.name, want: 'stripe' },
  { section: 'article', value: { catEn: true, unlockHint: '密码找站长要' }, path: (j) => j.article && j.article.unlockHint, want: '密码找站长要' },
  { section: 'layout', value: { mode: 'double', side: 'right', users: 'single' }, path: (j) => j.layout && j.layout.mode, want: 'double' },
  { section: 'runtime', value: { aiCap: 321 }, path: (j) => j.runtime && j.runtime.aiCap, want: 321 },
];
const origin = await (await hit('/data/site.json')).json();
for (const c of secs) {
  const post = await hit('/api/site', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw', section: c.section, value: c.value }),
  });
  const pj = await post.json();
  const back = await (await hit('/data/site.json')).json();
  ok(pj.ok === true, '保存 ' + c.section + ' 成功', JSON.stringify(pj).slice(0, 120));
  ok(c.path(back) === c.want, '保存 ' + c.section + ' 后立刻回读是新值', String(c.path(back)));
  // 还原
  const restore = {};
  for (const k of Object.keys(c.value)) restore[k] = (origin[c.section] || {})[k];
  await hit('/api/site', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw', section: c.section, value: restore }),
  });
}
const backFinal = await (await hit('/data/site.json')).json();
ok((backFinal.theme && backFinal.theme.name) === (origin.theme && origin.theme.name), '测试后主题已还原', String(backFinal.theme && backFinal.theme.name));

// ---- 25. 分类管理 + 文章规范地址（.html）----
console.log('\n== 25. 分类管理 + 文章 .html 地址 ==');
{
  const catSave = await hit('/api/site', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw', section: 'article', value: { unlockHint: '', catEn: false, categories: [{ key: 'tech', name: '技术', desc: '开发' }, { key: 'note', name: '随笔', desc: '' }] } }),
  });
  const cj = await catSave.json();
  ok(cj.ok === true && cj.site && cj.site.article && cj.site.article.categories.length === 2, '保存分类表（2 个）', JSON.stringify(cj.site && cj.site.article && cj.site.article.categories));
  const catBack = await (await hit('/data/site.json')).json();
  ok(catBack.article && catBack.article.categories && catBack.article.categories[0].key === 'tech', '分类立刻回读', JSON.stringify(catBack.article && catBack.article.categories));

  const dup = await hit('/api/site', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw', section: 'article', value: { catEn: false, categories: [{ key: 'tech', name: '技术' }, { key: 'tech', name: '技术2' }] } }),
  });
  const dj = await dup.json();
  ok(dj.ok === false && String(dj.error).indexOf('重复') >= 0, '重复英文词被拒', String(dj.error));

  const bad = await hit('/api/site', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw', section: 'article', value: { catEn: false, categories: [{ key: '技术', name: '技术' }] } }),
  });
  const bj = await bad.json();
  ok(bj.ok === false, '中文当英文词被拒', String(bj.error));

  const addRes = await hit('/api/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw', action: 'add', article: { title: '分类地址测试', summary: 's', body: 'b', category: '技术' } }),
  });
  const aj = await addRes.json();
  const made = (aj.articles || []).filter((a) => a.title === '分类地址测试').pop() || (aj.articles || []).filter((a) => a.slug && a.slug.indexOf('tech/') === 0).pop();
  ok(!!made, '按分类表生成 slug（tech/N）', made ? made.slug : JSON.stringify(aj.error || ''));

  if (made) {
    const bare = '/articles/' + String(made.slug).split('/').map(encodeURIComponent).join('/');
    const r1 = await hit(bare, { redirect: 'manual' });
    ok(r1.status === 301 && String(r1.headers.get('location') || '').endsWith('.html'), '不带 .html 的地址 301 到规范地址', r1.status + ' ' + r1.headers.get('location'));
    const r2 = await hit(bare + '.html');
    ok(r2.status === 200, '规范地址 .html 返回 200', String(r2.status));
    const del = await hit('/api/articles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw', action: 'remove', id: made.id }),
    });
    const djson = await del.json().catch(() => ({}));
    ok(del.status === 200 || del.status === 404, '清理测试文章', del.status + ' ' + JSON.stringify(djson.error || ''));
  }

  const sm = await (await hit('/sitemap.xml')).text();
  ok(sm.indexOf('.html</loc>') >= 0 || sm.indexOf('.html<') >= 0, '站点地图用 .html 地址', '');
  const adminHtml2 = await (await hit('/admin')).text();
  ok(adminHtml2.indexOf('catTbody') >= 0 && adminHtml2.indexOf('catAdd') >= 0, '后台有分类管理表', '');
}

  console.log('== 20. 体检与推送明细 ==');
  {
    const sub = await hit('/api/submit');
    const sj = await sub.json().catch(() => ({}));
    ok(sub.status === 200 && !!(sj.status && sj.status.counts), '状态接口带内容量', sub.status + '');
    const c = (sj.status && sj.status.counts) || {};
    ok(typeof c.articles === 'number' && typeof c.navSites === 'number' && typeof c.qa === 'number', '内容量字段齐全', JSON.stringify(c).slice(0, 90));
    const adm = await (await hit('/admin')).text();
    ok(adm.indexOf("typeof o.ms === 'number'") >= 0, '推送结果展示耗时', '');
    ok(adm.indexOf('内容量') >= 0, '体检卡有内容量一行', '');
    ok(adm.indexOf('文章 ') >= 0 && adm.indexOf(' 篇（分类 ') >= 0, '内容量文案可读', '');
    const siteJ = await (await hit('/api/site')).json().catch(() => ({}));
    const cats = (siteJ.site && siteJ.site.article && siteJ.site.article.categories) || [];
    ok(Array.isArray(cats) && cats.length >= 1, '默认分类兜底（normalizeSite 不丢 categories）', cats.length + ' 个');
    const faqHtml = await (await hit('/faq')).text();
    ok(faqHtml.indexOf('applyTheme') >= 0 && faqHtml.indexOf('ghrank-theme') >= 0, '问答页也跟随站点主题', '');
    ok(faqHtml.indexOf('color-scheme:dark') >= 0, '问答页深色主题声明 color-scheme', '');
    const homeHtml = await (await hit('/')).text();
    ok(homeHtml.indexOf('html[data-theme="ink"] .article-body tbody tr:nth-child(even)') >= 0, '首页表格斑马纹适配深色主题', '');
    const artHtml = await (await hit('/articles')).text();
    const artToc = artHtml;
    ok(artHtml.indexOf('html[data-theme="ink"] .abody tbody tr:nth-child(even)') >= 0, '文章页表格斑马纹适配深色主题', '');
    const admMobile = await (await hit('/admin')).text();
    ok(admMobile.indexOf('overflow-x:hidden;max-width:100%') >= 0, '后台移动端无横向溢出保护', '');
    ok(admMobile.indexOf('.grid2,.ad-grid,.art-grid{grid-template-columns:1fr}') >= 0, '后台移动端单列', '');
    ok(artToc.indexOf('a.is-cur') >= 0 && artToc.indexOf('spyToc') >= 0, '文章页目录随滚动高亮', '');
    ok(artToc.indexOf('scroll-margin-top:18px') >= 0, '文章页标题滚动留白', '');
    ok(admMobile.indexOf('.side .nav:focus-visible') >= 0, '后台键盘焦点环', '');
    ok(admMobile.indexOf('skip-link') >= 0, '后台跳到内容链接', '');
    ok(admMobile.indexOf('thead th{position:sticky') >= 0, '后台长表格表头吸附', '');
    ok(homeHtml.indexOf('bindDialogA11y') >= 0, '首页弹窗焦点陷阱', '');
    ok(artHtml.indexOf('searchTimer') >= 0 && artHtml.indexOf('clearTimeout') >= 0, '文章搜索防抖', '');
    const nf = await hit('/nope-xyz');
    const nfText = await nf.text();
    ok(nf.status === 404 && (nf.headers.get('content-type') || '').indexOf('text/html') >= 0, '404 返回 HTML 页', '');
    ok(nfText.indexOf('这个页面不存在') >= 0 && nfText.indexOf('href="/nav"') >= 0, '404 页带导航入口', '');
    ok(admMobile.indexOf('id="cmdk"') >= 0 && admMobile.indexOf('CK_NAMES') >= 0, '后台命令面板（Ctrl+K 跳面板）', '');
    ok(artHtml.indexOf("e.key === 'ArrowLeft'") >= 0 && artHtml.indexOf('rpos') >= 0, '阅读器左右键翻篇', '');
    const bundleSrc = await (await hit('/js/bundle.js')).text();
    ok(bundleSrc.indexOf("img.decoding = 'async'") >= 0, '头像图片异步解码', '');
    ok((nf.headers.get('cache-control') || '').indexOf('no-store') >= 0, '404 不缓存', '');
    ok(homeHtml.indexOf('@keyframes cardIn') >= 0, '首页卡片入场动画', '');
  }
console.log(fail === 0 ? '全部通过（回源 ' + rawCount + ' 次，API ' + apiCount + ' 次）' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);