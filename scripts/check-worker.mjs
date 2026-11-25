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
ok(/max-age=604800/.test(r.headers.get('cache-control') || ''), '分享图按 shell 文件长缓存（max-age=604800）', r.headers.get('cache-control'));
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
ok(inlBundle.indexOf('每 10 个项目') > 0 || inlBundle.indexOf('% 10') > 0, '榜单每 10 条插一条');
const inlBad = await hit('/api/site', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pw', section: 'ad', value: { slots: { 'nope-inline': { enabled: true, html: 'x' } } } })
});
const inlBadJson = await inlBad.json();
ok(inlBadJson.ok === false, '未知信息流位置被拒绝');
console.log('');

console.log(fail === 0 ? '全部通过（回源 ' + rawCount + ' 次，API ' + apiCount + ' 次）' : fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);