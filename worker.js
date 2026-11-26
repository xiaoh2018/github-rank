// GitHub 排行榜 + 定时保活（单文件 Worker，直接粘贴到 Cloudflare 网页编辑器即可）
// 排行榜页面的文件（index.html、js、sw.js、数据、图标）从公开仓库的 raw 地址读取并转发，
// 所以 Action 每次更新 data/repos.js 后，网站自动显示新数据，不需要重新部署 Worker。
// 变量：REPO_OWNER、REPO_NAME（文本）；GITHUB_TOKEN、RUN_PASSWORD（密钥）；BRANCH、FILE_PATH 可选
// 访客自动更新：STALE_HOURS（数据超过几小时才触发，默认 6）、COOLDOWN_MINUTES（两次触发的最短间隔，默认 60）
// 友链后台：/admin 页面，/api/links（GET 读取，POST 增删），数据存在仓库 data/links.json，不需要 KV
// ADMIN_PASSWORD（密钥）需要在 Cloudflare 的 Settings → Variables and Secrets 添加；初始密码由你自己设定，本代码不写死任何密码。没设置则后台的增删操作全部关闭
// GITHUB_TOKEN 需要：Contents 读写 + Actions 读写（用于触发 Update data 工作流）
// 定时：Cron Trigger "0 2 * * 1"（UTC），即北京时间每周一 10:00

const WORKFLOW_FILE = 'update-data.yml';
const DEFAULT_FILE = 'keepalive.txt';
const DEFAULT_BRANCH = 'main';

// 对外提供的站点文件（白名单，不是通用代理）：访问路径 → [仓库里的文件, 类型]
const SITE = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/nav': ['index.html', 'text/html; charset=utf-8'],
  '/js/bundle.js': ['js/bundle.js', 'application/javascript; charset=utf-8'],
  '/js/md.js': ['js/md.js', 'application/javascript; charset=utf-8'],
  '/data/repos.js': ['data/repos.js', 'application/javascript; charset=utf-8'],
  // 按时间范围拆分的数据文件：页面只下载当前 range，首屏数据量从约 400KB 降到约 100KB
  '/data/repos-meta.js': ['data/repos-meta.js', 'application/javascript; charset=utf-8'],
  '/data/repos-week.js': ['data/repos-week.js', 'application/javascript; charset=utf-8'],
  '/data/repos-month.js': ['data/repos-month.js', 'application/javascript; charset=utf-8'],
  '/data/repos-year.js': ['data/repos-year.js', 'application/javascript; charset=utf-8'],
  '/data/repos-total.js': ['data/repos-total.js', 'application/javascript; charset=utf-8'],
  '/data/repos-all.js': ['data/repos-all.js', 'application/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  // 社交平台抓取用的分享图（1200×630，由 scripts/make-og-image.ps1 生成）
  '/og-image.png': ['og-image.png', 'image/png'],
  '/data/links.json': ['data/links.json', 'application/json; charset=utf-8'],
  '/data/articles.json': ['data/articles.json', 'application/json; charset=utf-8'],
  '/data/site.json': ['data/site.json', 'application/json; charset=utf-8'],
  '/data/nav.json': ['data/nav.json', 'application/json; charset=utf-8'],
  '/data/qa.json': ['data/qa.json', 'application/json; charset=utf-8'],
  '/articles': ['articles.html', 'text/html; charset=utf-8'],
  '/articles.html': ['articles.html', 'text/html; charset=utf-8'],
  '/faq': ['faq.html', 'text/html; charset=utf-8'],
  '/faq.html': ['faq.html', 'text/html; charset=utf-8'],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // HEAD 也放行：监控探针、链接预检、社交平台抓取大量使用 HEAD，只认 GET 会被当成死链
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/data/articles.json') {
        return serveArticlesPublic(env, request);
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && SITE[url.pathname]) {
        if (url.pathname === '/' || url.pathname === '/index.html') {
          ctx.waitUntil(maybeRefresh(env).catch((e) => console.log('auto refresh error: ' + String(e))));
        }
        return serveSiteEdge(env, url.pathname, SITE[url.pathname], request);
      }
      if (url.pathname === '/robots.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(robotsTxt(url.origin), {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }
      if (url.pathname === '/rss.xml' && (request.method === 'GET' || request.method === 'HEAD')) {
        const seoRss = (await loadSiteRaw(env)).seo;
        const originRss = seoRss.siteUrl ? seoRss.siteUrl.replace(/\/+$/, '') : url.origin;
        const xmlRss = await rssXml(env, originRss);
        const headRss = new Headers({
          'content-type': 'application/rss+xml; charset=utf-8',
          'cache-control': 'public, max-age=600, s-maxage=600',
        });
        return new Response(request.method === 'HEAD' ? null : xmlRss, { status: 200, headers: headRss });
      }
      if (url.pathname === '/llms.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(await llmsTxt(env, url.origin), {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }
      if (url.pathname.endsWith('.txt') && url.pathname.slice(1).replace(/.txt$/, '') === indexNowKey(env, await siteRuntime(env)) && (request.method === 'GET' || request.method === 'HEAD')) {
        const key = indexNowKey(env, await siteRuntime(env));
        return new Response(request.method === 'HEAD' ? null : key, {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }
      // 文章规范地址：/articles/<分类>/<序号>.html（旧的 /articles/cat%2F1、不带 .html 的都 301 过来）
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.indexOf('/articles/') === 0) {
        let dec = url.pathname;
        try {
          dec = decodeURIComponent(url.pathname);
        } catch (e) {
          dec = url.pathname;
        }
        const segOk = /^\/articles\/[\p{L}\p{N}][\p{L}\p{N}_-]{0,23}(\/[\p{L}\p{N}][\p{L}\p{N}_-]{0,29})?\.html$/u;
        const bare = dec.replace(/\.html?$/i, '');
        const canonical = bare + '.html';
        if (segOk.test(canonical) && /^\/articles\/[^/]+(\/[^/]+)?$/u.test(bare)) {
          if (dec !== canonical) {
            return new Response(null, {
              status: 301,
              headers: { location: encodeURI(canonical) + (url.search || ''), 'cache-control': 'public, max-age=600' },
            });
          }
          return serveArticlePage(env, canonical, request);
        }
      }
      if (url.pathname === '/sitemap.xml' && (request.method === 'GET' || request.method === 'HEAD')) {
        const seoSite = (await loadSiteRaw(env)).seo;
        const origin = seoSite.siteUrl ? seoSite.siteUrl.replace(/\/+$/, '') : url.origin;
        const arts = await rawJson(env, 'data/articles.json');
        const list = Array.isArray(arts) ? arts : [];
        fillArticleSlugs(list);
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        const today = todayBJ().slice(0, 10);
        xml += '  <url><loc>' + origin + '/</loc><lastmod>' + today + '</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n';
        xml += '  <url><loc>' + origin + '/nav</loc><lastmod>' + today + '</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>\n';
        xml += '  <url><loc>' + origin + '/faq</loc><lastmod>' + today + '</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>\n';
        xml += '  <url><loc>' + origin + '/articles</loc><lastmod>' + today + '</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>\n';
        for (const a of list.slice(0, 2000)) {
          if (!a || !a.id) continue;
          // 加密文章的详情页是 noindex（不把密文页交给搜索引擎），就不该出现在 sitemap 里：
          // 一条「我存在但别索引我」的地址只会拉低整站的抓取质量。
          if (a.locked && a.lock && a.lock.ct) continue;
          const lm = a.date ? String(a.date).slice(0, 10) : '';
          const artPath = a.slug
    ? '/articles/' + String(a.slug).split('/').map(encodeURIComponent).join('/') + '.html'
    : '/articles#' + encodeURIComponent(String(a.id));
          xml += '  <url><loc>' + origin + artPath + '</loc>' +
            (lm ? '<lastmod>' + lm + '</lastmod>' : '') + '<changefreq>monthly</changefreq><priority>0.5</priority></url>\n';
        }
        xml += '</urlset>\n';
        return new Response(request.method === 'HEAD' ? null : xml, {
          headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=600' },
        });
      }
      if (url.pathname === '/keepalive' && request.method === 'GET') {
        return Response.redirect(url.origin + '/admin#keepalive', 302);
      }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return handleHealth(env, url.origin);
      }
      if (url.pathname === '/api/ai-usage' && request.method === 'GET') {
        return json({ ok: true, usage: await aiUsage(env, await siteRuntime(env)) });
      }
      if (url.pathname === '/api/status' && request.method === 'GET') {
        // 状态接口要打两次 GitHub API，冷启动接近 1 秒；用边缘缓存挡 60 秒
        return json(await getStatusCached(env));
      }
      if (url.pathname === '/api/run' && request.method === 'POST') {
        if (!env.RUN_PASSWORD && !env.ADMIN_PASSWORD) {
          return json({ ok: false, error: '没有设置 RUN_PASSWORD，手动保活已关闭' }, 403);
        }
        const body = await request.json().catch(() => ({}));
        const pw = body.password == null ? '' : String(body.password);
        const pass =
          (!!env.RUN_PASSWORD && safeEqual(pw, env.RUN_PASSWORD)) ||
          (!!env.ADMIN_PASSWORD && safeEqual(pw, env.ADMIN_PASSWORD));
        if (!pass) {
          return json({ ok: false, error: '密码不对' }, 403);
        }
        const r = await keepalive(env);
        return json(r, r.ok ? 200 : 500);
      }
      if (url.pathname === '/admin' && request.method === 'GET') {
        return new Response(ADMIN_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
      }
      if (url.pathname === '/api/links' && (request.method === 'GET' || request.method === 'POST')) {
        return handleLinks(request, env);
      }
      if (url.pathname === '/api/site' && (request.method === 'GET' || request.method === 'POST')) {
        return handleSite(request, env);
      }
      if (url.pathname === '/api/translate' && (request.method === 'GET' || request.method === 'POST')) {
        return handleTranslate(request, env);
      }
      if (url.pathname === '/api/qa' && (request.method === 'GET' || request.method === 'POST')) {
        return handleQa(request, env);
      }
      if (url.pathname === '/api/nav' && (request.method === 'GET' || request.method === 'POST')) {
        return handleNav(request, env);
      }
      if (url.pathname === '/api/fetch-meta' && (request.method === 'POST' || request.method === 'GET')) {
        const q = url.searchParams.get('url') || '';
        return handleFetchMeta(q, env);
      }
      if (url.pathname === '/api/submit' && (request.method === 'GET' || request.method === 'POST')) {
        return handleSubmit(request, env, url.origin);
      }
      if (url.pathname === '/api/articles' && (request.method === 'GET' || request.method === 'POST')) {
        return handleArticles(request, env);
      }
      if (url.pathname === '/api/article' && request.method === 'POST') {
        return handleArticleOpen(request, env);
      }
      if (url.pathname === '/api/admin/check' && request.method === 'POST') {
        if (!env.ADMIN_PASSWORD) {
          return json({ ok: false, error: '没有设置 ADMIN_PASSWORD，后台已关闭' }, 403);
        }
        const body = await request.json().catch(() => null);
        const pw = body && typeof body === 'object' && body.password != null ? String(body.password) : '';
        if (!safeEqual(pw, env.ADMIN_PASSWORD)) {
          return json({ ok: false, error: '密码不对' }, 401);
        }
        return json({ ok: true });
      }
      if (url.pathname === '/api/readme-zh' && request.method === 'GET') {
        return readmeZh(request, env, ctx);
      }
      if (url.pathname === '/api/desc-zh' && request.method === 'POST') {
        return descZh(request, env, ctx);
      }
      if (url.pathname === '/api/gh' && request.method === 'GET') {
        return ghProxy(request, env, ctx);
      }
      if (url.pathname === '/api/gh-search' && request.method === 'GET') {
        return ghSearch(request, env);
      }
      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        const r = await triggerRefresh(env);
        return json(r, r.ok ? 200 : (r.status || 500));
      }
      return notFoundPage(url.origin);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(keepalive(env).then((r) => console.log(JSON.stringify(r))));
  },
};

// ---------- 抽屉详情代理：访客浏览器不再直连 api.github.com（未登录每小时只有 60 次，容易 403）----------
// 只放行仓库详情、README、最新 Release、贡献者四类路径；用 GITHUB_TOKEN 转发；成功结果缓存 10 分钟
async function ghProxy(request, env, ctx) {
  const u = new URL(request.url);
  const p = u.searchParams.get('path') || '';
  const raw = u.searchParams.get('raw') === '1';
  const parts = p.split('?');
  const base = parts[0];
  const qs = parts[1] || '';
  const m = base.match(/^\/repos\/([\w.-]+\/[\w.-]+)(\/readme|\/releases\/latest|\/contributors)?$/);
  if (!m || (qs && qs !== 'per_page=8')) return json({ ok: false, error: '不支持的路径' }, 400);
  const upstream = 'https://api.github.com' + base + (qs ? '?' + qs : '');
  const cache = globalThis.caches.default;
  const key = new Request(new URL('/__gh/' + (raw ? 'raw:' : 'json:') + p, request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const headers = {
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-rank-detail',
    };
    const tok = await serverGhToken(env);
    if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch(upstream, { headers: headers });
  if (r.status === 204) return new Response(null, { status: 204 });
  if (!r.ok) return new Response('HTTP ' + r.status, { status: r.status, headers: { 'cache-control': 'no-store' } });
  const body = await r.text();
  const res = new Response(body, {
    status: 200,
    headers: {
      'content-type': raw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// 服务端 GitHub Token 只从 Cloudflare 环境变量 GITHUB_TOKEN 读取
async function serverGhToken(env) {
  return env.GITHUB_TOKEN || null;
}


// 「立即刷新」用的搜索代理：只放行仓库搜索，用服务端 Token 转发，不缓存
async function ghSearch(request, env) {
  const u = new URL(request.url);
  const q = u.searchParams.get('q') || '';
  const sort = u.searchParams.get('sort') || 'stars';
  const page = Math.min(Math.max(parseInt(u.searchParams.get('page') || '1', 10) || 1, 1), 10);
  const perPage = Math.min(Math.max(parseInt(u.searchParams.get('per_page') || '100', 10) || 100, 1), 100);
  if (!q || q.length > 500 || ['stars', 'forks', 'updated'].indexOf(sort) < 0) return json({ ok: false, error: '参数不对' }, 400);
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'github-rank-search' };
  const tok = await serverGhToken(env);
  if (tok) headers.Authorization = 'Bearer ' + tok;
  let r;
  try {
    r = await fetch('https://api.github.com/search/repositories?q=' + encodeURIComponent(q) + '&sort=' + sort + '&order=desc&per_page=' + perPage + '&page=' + page,
      { headers: headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return json({ ok: false, error: 'GitHub 响应超时，请稍后重试' }, 504);
  }
  if (!r.ok) return new Response('HTTP ' + r.status, { status: r.status, headers: { 'cache-control': 'no-store' } });
  return new Response(await r.text(), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

// ---------- README 中文译文（免 Key：MyMemory 公开接口；结果缓存 7 天）----------
async function readmeZh(request, env, ctx) {
  const repo = new URL(request.url).searchParams.get('repo') || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ ok: false, error: '仓库名不对' }, 400);
  const cache = globalThis.caches.default;
  const key = new Request(new URL('/__readme_zh/' + repo, request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  // 先用仓库里 GitHub Action 预翻译好的译文（data/readme-zh.json），不占实时翻译额度
  const pre = await staticReadmeZh(env, repo);
  if (pre) {
    const preResp = json({ ok: true, partial: !!pre.partial, text: pre.text });
    preResp.headers.set('cache-control', 'public, max-age=' + (pre.partial ? 600 : 3600));
    ctx.waitUntil(cache.put(key, preResp.clone()));
    return preResp;
  }
  const headers = { Accept: 'application/vnd.github.raw', 'User-Agent': 'github-rank-readme' };
  const tok = await serverGhToken(env);
  if (tok) headers.Authorization = 'Bearer ' + tok;
  const r = await fetch('https://api.github.com/repos/' + repo + '/readme', { headers: headers });
  if (!r.ok) return json({ ok: false, error: 'README 读取失败（HTTP ' + r.status + '）' }, 502);
  const parts = splitForTranslate((await r.text()).slice(0, 12000)).slice(0, 30);
  const out = [];
  let partial = false;
  for (const p of parts) {
    if (p.raw) { out.push(p.text); continue; }
    const t = await translateText(p.text, env);
    if (t == null) { out.push(p.text); partial = true; continue; }   // 额度不够时该段保留英文，其余段落照常翻译
    out.push(t);
  }
  const resp = json({ ok: true, partial: partial, text: out.join('\n\n') });
  // 全部译完缓存 7 天；有段落是英文时只缓存 10 分钟，额度恢复后再访问可以补全
  resp.headers.set('cache-control', 'public, max-age=' + (partial ? 600 : 604800));
  ctx.waitUntil(cache.put(key, resp.clone()));
  return resp;
}

// 列表简介批量翻译：POST {texts:[...]}（最多 20 条），返回 {items:{原文:译文}}；译不出来的不返回；每条结果缓存 30 天
async function descZh(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.texts)) return json({ ok: false, error: '参数不对' }, 400);
  const list = body.texts.slice(0, 20).map((t) => String(t || '').slice(0, 300)).filter(Boolean);
  const items = {};
  // 第一步：所有缓存键并发查一遍（只读，不打外部接口）
  const keys = list.map((t) => new Request(new URL('/__desc_zh/' + encodeURIComponent(t), request.url).toString()));
  const hits = await Promise.all(keys.map((k) => EDGE_CACHE.match(k).catch(() => null)));
  const miss = [];
  for (let i = 0; i < list.length; i++) {
    if (hits[i]) {
      const v = await hits[i].text();
      if (v) { items[list[i]] = v; continue; }
    }
    miss.push(list[i]);
  }
  // 第二步：只翻没命中的，限 6 并发，避免一次 20 条把 MyMemory 打出 429
  await poolMap(miss, 6, async (t) => {
    const zh = await translateText(t, env);
    if (!zh) return;
    items[t] = zh;
    const key = new Request(new URL('/__desc_zh/' + encodeURIComponent(t), request.url).toString());
    ctx.waitUntil(EDGE_CACHE.put(key, new Response(zh, { headers: { 'cache-control': 'public, max-age=2592000' } })));
  });
  return json({ ok: true, items: items, cached: list.length - miss.length, translated: Object.keys(items).length - (list.length - miss.length) });
}

// 按段落切分：含代码块、表格、图片、HTML 的段落原样保留；普通文字每段最多 300 字符（MyMemory 单次上限 500 字节）
function splitForTranslate(md) {
  const out = [];
  for (const b of md.replace(/\r/g, '').split(/\n\s*\n/)) {
    const t = b.trim();
    if (!t) continue;
    if (t.includes('```') || /^(\||<|!\[|\[!\[)/.test(t)) { out.push({ raw: true, text: t }); continue; }
    for (let i = 0; i < t.length; i += 300) out.push({ raw: false, text: t.slice(i, i + 300) });
  }
  return out;
}

// 并发池：一次最多跑 limit 个异步任务，避免把外部接口打成 429
async function poolMap(list, limit, fn) {
  const queue = list.slice();
  const size = Math.max(1, Math.min(limit, queue.length));
  const workers = [];
  for (let i = 0; i < size; i++) {
    workers.push((async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await fn(item);
        } catch (e) {}
      }
    })());
  }
  await Promise.all(workers);
}

// 长文本按句子切成小块：MyMemory 单次 q 上限约 500 字符，m2m100 太长也会被截断
function chunkText(text, max) {
  const out = [];
  let rest = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!rest) return out;
  while (rest.length > max) {
    const win = rest.slice(0, max);
    const m = win.match(/^[\s\S]*[.!?;\u3002\uff01\uff1f\uff1b]\s?/);
    let cut = m ? m[0].length : -1;
    if (cut < max * 0.5) {
      const sp = win.lastIndexOf(' ');
      cut = sp > max * 0.5 ? sp : max;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// 译文缓存：同一段英文只翻一次（键在 Worker 自己名下，不会和站点文件撞）
function trKey(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 'https://edge.ghrank.internal/__tr/' + h.toString(16) + '-' + text.length;
}

async function readTranslation(text) {
  if (!text || text.length > 4000) return null;
  try {
    const hit = await EDGE_CACHE.match(trKey(text));
    if (!hit) return null;
    const body = await hit.text();
    return body && body.trim() ? body : null;
  } catch (e) {
    return null;
  }
}

async function saveTranslation(text, zh) {
  if (!text || !zh || text.length > 4000) return;
  try {
    await EDGE_CACHE.put(
      trKey(text),
      new Response(zh, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=31536000' } })
    );
  } catch (e) {
    /* 缓存写失败不影响结果 */
  }
}

// MyMemory 的可用邮箱列表：TRANSLATE_EMAILS（逗号/空格分隔）优先，其次 TRANSLATE_EMAIL
// Gmail / Outlook 的 +别名都进同一个信箱，但 MyMemory 按邮箱算额度，所以默认就轮换几个
const MM_ALIAS_COUNT = 5;
function mmEmails(env, rt) {
  const r = rt || {};
  const src = (typeof r.emails === 'string' && r.emails.trim()) || env.TRANSLATE_EMAILS || env.TRANSLATE_EMAIL || 'xiaoh2018@gmail.com';
  const list = String(src).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  const base = 'xiaoh2018@gmail.com';
  const at = base.indexOf('@');
  const out = [base];
  for (let i = 1; i <= MM_ALIAS_COUNT; i++) out.push(base.slice(0, at) + '+' + i + base.slice(at));
  return out;
}

// MyMemory：免费、无需 Key。返回 { ok, text, error }，error 带类型前缀方便后台显示
async function translateMM(text, env, rt) {
  const chunks = chunkText(text, 450);
  if (!chunks.length) return { ok: false, error: 'empty: 没有可翻译的内容' };
  const emails = mmEmails(env, rt);
  const parts = [];
  let emailIdx = 0;
  for (const piece of chunks) {
    let done = false;
    let lastErr = '';
    while (!done && emailIdx < emails.length) {
      let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(piece) + '&langpair=en|zh-CN';
      // 带上联系邮箱，MyMemory 每日额度更高；多个邮箱时轮换
      url += '&de=' + encodeURIComponent(emails[emailIdx]);
      let r;
      try {
        r = await fetch(url);
      } catch (e) {
        return { ok: false, error: 'network: 连不上 MyMemory（' + (e && e.message ? e.message : 'fetch failed') + '）' };
      }
      if (r.status === 429 || r.status === 403) {
        lastErr = 'quota: MyMemory 当天免费额度用完了（HTTP ' + r.status + '）';
        emailIdx++;
        continue;
      }
      if (!r.ok) return { ok: false, error: 'http: MyMemory 返回 HTTP ' + r.status };
      let d = null;
      try {
        d = await r.json();
      } catch (e) {
        return { ok: false, error: 'parse: MyMemory 返回的不是 JSON' };
      }
      const detail = String((d && d.responseDetails) || '').slice(0, 90);
      const tt = d && d.responseData && d.responseData.translatedText;
      if ((d && d.responseStatus !== 200) || (tt && /MYMEMORY WARNING|QUOTA/i.test(String(tt)))) {
        const why = detail + ' ' + String(tt || '');
        if (/quota|limit|MYMEMORY WARNING/i.test(why)) {
          lastErr = 'quota: MyMemory 额度用尽（' + (detail || 'WARNING').slice(0, 60) + '）';
          emailIdx++;
          continue;
        }
        return { ok: false, error: 'status: MyMemory 报错「' + detail + '」' };
      }
      if (!tt) return { ok: false, error: 'empty: MyMemory 返回空译文' };
      parts.push(String(tt));
      done = true;
    }
    if (!done) {
      return { ok: false, error: (lastErr || 'quota: MyMemory 额度用尽') + '（已试 ' + emails.length + ' 个邮箱）' };
    }
  }
  return { ok: true, text: parts.join(' ') };
}

// Workers AI 每天最多用多少次（防止把额度打光）：AI_DAILY_CAP，默认 400
function aiCap(env, rt) {
  const r = rt || {};
  if (typeof r.aiCap === 'number') return r.aiCap === 0 ? Infinity : r.aiCap;
  const n = Number(env.AI_DAILY_CAP || 400);
  return Number.isFinite(n) && n > 0 ? n : 400;
}

// 读后台设置（data/site.json 的 runtime 分组），带 60 秒边缘缓存
function normRuntime(j) {
  const r = j && typeof j === 'object' ? j : {};
  return {
    aiCap: typeof r.aiCap === 'number' ? r.aiCap : null,
    emails: typeof r.emails === 'string' ? r.emails : '',
    baiduToken: typeof r.baiduToken === 'string' ? r.baiduToken : '',
    indexNowKey: typeof r.indexNowKey === 'string' ? r.indexNowKey : '',
  };
}

async function siteRuntime(env) {
  const DFLT = { aiCap: null, emails: '', baiduToken: '', indexNowKey: '' };
  try {
    const key = EDGE_KEY_BASE + '/__runtime';
    const hit = await EDGE_CACHE.match(key);
    if (hit) {
      const j = await hit.json().catch(() => null);
      if (j && typeof j === 'object') return normRuntime(j);
    }
    const r = await readSite(env);
    const rt = (r && r.ok && r.site && r.site.runtime) || DFLT;
    const out = normRuntime(rt);
    await EDGE_CACHE.put(key, new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } }));
    return out;
  } catch (e) {
    return DFLT;
  }
}

async function aiCountKey(env) {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间当天
  return EDGE_KEY_BASE + '/__ai/' + repoOf(env).owner + '/' + d.toISOString().slice(0, 10);
}

async function aiUsedToday(env) {
  try {
    const hit = await EDGE_CACHE.match(await aiCountKey(env));
    if (!hit) return 0;
    const n = Number(await hit.text());
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    return 0;
  }
}

async function aiBumpUsage(env) {
  try {
    const key = await aiCountKey(env);
    const n = (await aiUsedToday(env)) + 1;
    await EDGE_CACHE.put(key, new Response(String(n), { headers: { 'cache-control': 'max-age=172800' } }));
  } catch (e) {
    /* 计数失败不影响翻译 */
  }
}

// Workers AI 翻译（m2m100）：需要在 Worker 上绑定 AI（变量名 AI）；没有绑定时直接跳过
async function translateAI(text, env, rt) {
  if (!env.AI) return { ok: false, error: 'not-bound: 没有绑定 Workers AI（变量名必须是 AI）' };
  const cap = aiCap(env, rt);
  const used = await aiUsedToday(env);
  if (used >= cap) {
    return { ok: false, error: 'cap: 今天的 Workers AI 调用已达上限（' + used + '/' + (cap === Infinity ? '不限' : cap) + '），明天恢复，或把上限调大/设为 0' };
  }
  const chunks = chunkText(text, 900);
  if (!chunks.length) return { ok: false, error: 'empty: 没有可翻译的内容' };
  const parts = [];
  for (const piece of chunks) {
    let r;
    try {
      r = await env.AI.run('@cf/meta/m2m100-1.2b', { text: piece, source_lang: 'english', target_lang: 'chinese' });
    } catch (e) {
      return { ok: false, error: 'run: 模型调用失败（' + (e && e.message ? e.message : 'unknown') + '）' };
    }
    const t = r && (r.translated_text || r.translation);
    if (!t) return { ok: false, error: 'empty: 模型返回空结果' };
    parts.push(String(t));
    await aiBumpUsage(env);
  }
  return { ok: true, text: parts.join('') };
}

// 翻译顺序：缓存 → MyMemory（免 Key）→ Workers AI（绑定即用）
async function translateText(text, env) {
  const cached = await readTranslation(text);
  if (cached) return cached;
  const mm = await translateMM(text, env);
  if (mm.ok && mm.text) {
    await saveTranslation(text, mm.text);
    return mm.text;
  }
  const ai = await translateAI(text, env);
  if (ai.ok && ai.text) {
    await saveTranslation(text, ai.text);
    return ai.text;
  }
  return null;
}

// 读取 GitHub Action 预翻译的 README 译文（data/readme-zh.json，格式 {"owner/repo": {partial, text}}）
// 这张表有 200KB+，每次冷启动都去 raw 拉一遍会白白多花 0.7~1s，所以分三级取：
//   1) 当前 isolate 内存（最快，10 分钟内复用）
//   2) 边缘缓存整张表（跨 isolate，命中通常 20~100ms）
//   3) 回源 raw（只有真正冷启动且边缘也没有时才付这个代价）
const README_ZH_TTL = 1800;
let README_ZH_MAP = null;
let README_ZH_READ_AT = 0;
async function readmeZhMap(env) {
  const now = Date.now();
  if (README_ZH_MAP && now - README_ZH_READ_AT < README_ZH_TTL * 1000) return README_ZH_MAP;
  const key = new Request(EDGE_KEY_BASE + '/__readme_zh_all');
  try {
    const hit = await EDGE_CACHE.match(key);
    if (hit) {
      README_ZH_MAP = await hit.json();
      README_ZH_READ_AT = now;
      return README_ZH_MAP;
    }
  } catch (e) {}
  try {
    const url = 'https://raw.githubusercontent.com/' + repoOf(env).owner + '/' + repoOf(env).name + '/' + branch(env) + '/data/readme-zh.json';
    const r = await fetch(url, { cf: { cacheTtl: README_ZH_TTL, cacheEverything: true } });
    if (!r.ok) return README_ZH_MAP || null;
    const body = await r.text();
    README_ZH_MAP = JSON.parse(body);
    README_ZH_READ_AT = now;
    EDGE_CACHE.put(key, new Response(body, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=' + README_ZH_TTL,
      },
    })).catch(() => {});
    return README_ZH_MAP;
  } catch (e) {
    return README_ZH_MAP || null;
  }
}
async function staticReadmeZh(env, repo) {
  const map = await readmeZhMap(env);
  return (map && map[repo]) || null;
}

function text(msg, status) {
  return new Response(msg, { status: status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// 从仓库 raw 地址读取站点文件，边缘缓存 RAW_TTL 秒（后台保存后靠 warmEdge 立刻换新）
// 平台验证码：把后台填的验证码拼成 meta 标签注入首页 head
async function injectVerifyMeta(env, html) {
  let vf = {};
  try {
    const rt = (await siteRuntime(env)) || {};
    vf = rt.verify || {};
  } catch (e) {}
  const out = [];
  const push = (name, code) => {
    const v = String(code || '').trim();
    if (!v) return;
    out.push('<meta name="' + name + '" content="' + v.replace(/"/g, "'") + '" />');
  };
  push('bytedance-verification', vf.bytedance);
  push('sogou_site_verification', vf.sogou);
  push('shenma-site-verification', vf.shenma);
  return html.split('{{GHRANK_VERIFY}}').join(out.join(
));
}

async function serveSite(env, entry, pathname) {
  if (!repoOf(env).owner || !repoOf(env).name) {
    return text('还没配置 REPO_OWNER / REPO_NAME 变量，请按部署说明添加', 503);
  }
  const raw =
    'https://raw.githubusercontent.com/' + repoOf(env).owner + '/' + repoOf(env).name + '/' + branch(env) + '/' + entry[0];
  const r = await fetch(raw, { cf: { cacheTtl: RAW_TTL, cacheEverything: true } });
  if (!r.ok) {
      return text('读取站点文件失败：' + r.status + '（请确认仓库是公开的，且文件已经推送到 ' + branch(env) + ' 分支）', 502);
    }
    if (entry[0] === 'faq.html') {
      let html = await r.text();
      try {
        html = await injectFaqLd(env, html);
      } catch (e) {}
      return new Response(html, {
        headers: { 'content-type': entry[1], 'cache-control': 'public, max-age=300' },
      });
    }
    if (entry[0] === 'index.html') {
      const siteCfg = await loadSiteRaw(env);
      let html = applySeo(await r.text(), siteCfg.seo);
      // /nav 复用的是 index.html，但它是独立地址：标题/描述/canonical 必须指向自己，
      // 否则搜索引擎把它当首页的重复内容（sitemap 里还挂着 /nav，等于自相矛盾）。
      if (pathname === '/nav') html = applyNavSeo(html, siteCfg.seo);
      try {
        html = await injectVerifyMeta(env, html);
      } catch (e) {}
      html = html.replace(/(["'])(\/?js\/[\w.-]+\.js)(["'])/g, function (m, q1, p1, q2) {
        return q1 + p1 + '?v=' + ASSET_V + q2;
      });
      return new Response(html, {
        headers: { 'content-type': entry[1], 'cache-control': 'public, max-age=300' },
      });
    }
    return new Response(r.body, {
      headers: { 'content-type': entry[1], 'cache-control': 'public, max-age=300' },
    });
}

// ---------- 边缘缓存：缓存「成品响应」，而不只是缓存回源请求 ----------
// 以前只用 cf.cacheTtl 缓存「对 raw.githubusercontent 的那次 fetch」，Worker 每次仍要执行、
// 未命中时还要跨太平洋回源一次（实测每个文件多 300ms）。这里把最终响应存进 Cache API：
// 命中时既不发子请求也不重组页面，TTFB 从 300~440ms 降到 20~50ms。
const EDGE_CACHE = caches.default;
const EDGE_KEY_BASE = 'https://edge.ghrank.internal';

// HTML 页面的缓存键要带 ASSET_V：每次发版自动换键，旧条目立刻失效。
// 不带版本号时，改完页面最长要等边缘 TTL 过期（历史上 /faq 掉进 js/css 档，白等过 24 小时）。
function isHtmlPage(pathname) {
  return pathname === '/' || pathname === '/nav' || pathname === '/articles' || pathname === '/faq' || /\.html$/.test(pathname);
}

function edgeKeyOf(pathname, ver) {
  let v = ver || '';
  if (!v && isHtmlPage(pathname)) v = 'a' + ASSET_V;
  return new Request(EDGE_KEY_BASE + pathname + (v ? '?v=' + encodeURIComponent(v) : ''), { method: 'GET' });
}
// 回源 raw.githubusercontent 时 CF 给子请求的缓存时长。以前是 300s，等于后台保存后
// 最多还要旧 5 分钟才换新；压到 60s，再用 warmEdge 主动换新，改完基本立刻生效。
const RAW_TTL = 60;

// 后台随时会改的三个 JSON：缓存必须很短，否则改完前台还是旧值（实测过）
const CONFIG_FILES = ['/data/site.json', '/data/links.json', '/data/articles.json', '/data/nav.json', '/data/qa.json'];

// ttl=边缘保留秒数；browser=浏览器 max-age；swr=stale-while-revalidate
function cachePolicy(pathname) {
  if (pathname === '/sw.js') return { ttl: 60, browser: 60, sMaxAge: 60 };
  if (CONFIG_FILES.indexOf(pathname) >= 0) return { ttl: 60, browser: 60, sMaxAge: 60, swr: 300 };
  if (pathname.indexOf('/data/') === 0) return { ttl: 900, browser: 600, sMaxAge: 900, swr: 86400 };
  // 所有 HTML 页面都走这一档：改了文案/样式要能在几分钟内生效。
  // 以前白名单漏了 /faq（掉到下面 js/css 那一档 = 边缘 24 小时 + swr 7 天），
  // 结果问答页改一次要等一天才换新，属于「改完看不见」的隐形故障。
  // 注意 /faq 是「无扩展名的页面路由」，不能只靠 /\.html$/ 判断（漏过它一次：
  // 结果问答页继续按 js/css 那档缓存 24 小时，改完一天才生效）。
  if (pathname === '/' || pathname === '/nav' || pathname === '/articles' || pathname === '/faq' || /\.html$/.test(pathname)) {
    return { ttl: 600, browser: 300, sMaxAge: 600, swr: 3600 };
  }
  // js / css / 图标 / manifest 这类 shell 文件几个月才变一次，浏览器可以放心长缓存
  return { ttl: 86400, browser: 300, sMaxAge: 86400, swr: 604800 };
}

function cacheControlOf(p, immutable) {
  // 带 ?v= 的内容永不改变，浏览器存一年，边缘也存 7 天（否则每次回源都要多走一跳）
  if (immutable) return 'public, max-age=31536000, s-maxage=604800, immutable';
  let v = 'public, max-age=' + p.browser;
  if (p.sMaxAge) v += ', s-maxage=' + p.sMaxAge;
  if (p.swr) v += ', stale-while-revalidate=' + p.swr;
  return v;
}

// 便宜的 32 位哈希，用来生成 ETag（只在未命中时算一次，命中直接复用）
function hash32(buf) {
  const u8 = new Uint8Array(buf);
  let h = 5381;
  for (let i = 0; i < u8.length; i++) h = ((h * 33) ^ u8[i]) >>> 0;
  return h.toString(16);
}

// 后台改了配置/文章后清掉对应成品缓存，否则要等 TTL 过期才看得到
async function purgeEdge(paths) {
  try {
    await Promise.all(paths.map((p) => EDGE_CACHE.delete(edgeKeyOf(p))));
  } catch (e) {
    console.log('purge edge cache failed: ' + String(e));
  }
}

// 只 purge 还不够：purge 清的是「成品响应」缓存，清不掉 Cloudflare 给
// raw.githubusercontent 那次子请求的缓存（还能旧 RAW_TTL 秒）。所以保存成功后
// 直接把新内容写成成品响应塞回去，下一次请求立刻拿到新值，不必等回源。
async function warmEdge(pathname, body, type) {
  const pol = cachePolicy(pathname);
  if (!pol.ttl) return;
  const buf = new TextEncoder().encode(body);
  const headers = new Headers();
  headers.set('content-type', type);
  headers.set('cache-control', cacheControlOf(pol));
  headers.set('x-edge', 'WARM');
  headers.set('etag', '"h' + hash32(buf) + '"');
  try {
    await EDGE_CACHE.put(edgeKeyOf(pathname), new Response(buf, { status: 200, headers: headers }));
  } catch (e) {
    console.log('warm edge failed: ' + String(e));
  }
}

async function serveSiteEdge(env, pathname, entry, request) {
  const pol = cachePolicy(pathname);
  // 数据文件前端会带 ?v=generatedAt，让它进不同的缓存键：新数据一发布立刻生效，旧条目自己过期
  const ver = new URL(request.url).searchParams.get('v') || '';
  // 带 ?v= 的数据/脚本内容永不改变（版本号换了就是另一个 URL），浏览器可以 immutable 存一年
  const immutable = !!ver && (pathname.indexOf('/data/') === 0 || pathname.indexOf('/js/') === 0);
  const cacheKey = edgeKeyOf(pathname, ver);

  let hit = null;
  if (pol.ttl > 0) {
    try { hit = await EDGE_CACHE.match(cacheKey); } catch (e) { hit = null; }
  }

  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-edge', 'HIT');
    const etag = headers.get('etag');
    if (etag && request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: headers });
    }
    if (request.method === 'HEAD') return new Response(null, { status: hit.status, headers: headers });
    return new Response(await hit.arrayBuffer(), { status: hit.status, headers: headers });
  }

  const res = await serveSite(env, entry, pathname);
  const status = res.status;
  const buf = status === 200 ? await res.arrayBuffer() : null;
  const headers = new Headers();
  headers.set('content-type', entry[1]);
  headers.set('cache-control', cacheControlOf(pol, immutable));
  headers.set('x-edge', 'MISS');
  if (buf) headers.set('etag', '"h' + hash32(buf) + '"');
  // 首页提前告诉浏览器马上要用的两个脚本，少一轮「先拿 HTML 再发现脚本」
  if (pathname === '/' || pathname === '/index.html') {
    headers.set('link', '</data/repos-meta.js>; rel=preload; as=script, </data/repos-week.js>; rel=preload; as=script');
  }

  if (!buf) {
    return new Response(res.body, { status: status, headers: headers });
  }

  if (pol.ttl > 0) {
    try {
      await EDGE_CACHE.put(cacheKey, new Response(buf, { status: status, headers: new Headers(headers) }));
    } catch (e) {
      console.log('edge cache put failed: ' + String(e));
    }
  }
  if (request.method === 'HEAD') return new Response(null, { status: status, headers: headers });
  return new Response(buf, { status: status, headers: headers });
}

// 对外的文章列表：只发公开字段。lock（PBKDF2 盐 + AES-GCM 密文）留在仓库里，
// 不往外发——否则任何人都能拿密文离线爆破密码。locked 的文章用 hasLock 告诉前端"能不能解"。
function publicArticlesJson(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  fillArticleSlugs(arr);
  return JSON.stringify(arr.map(publicArticle));
}

async function serveArticlesPublic(env, request) {
  const pathname = '/data/articles.json';
  const pol = cachePolicy(pathname);
  const ver = new URL(request.url).searchParams.get('v') || '';
  const cacheKey = new Request(EDGE_KEY_BASE + pathname + (ver ? '?v=' + encodeURIComponent(ver) : ''), { method: 'GET' });

  let hit = null;
  if (pol.ttl > 0) {
    try { hit = await EDGE_CACHE.match(cacheKey); } catch (e) { hit = null; }
  }
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-edge', 'HIT');
    const etag = headers.get('etag');
    if (etag && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: headers });
    if (request.method === 'HEAD') return new Response(null, { status: hit.status, headers: headers });
    return new Response(await hit.arrayBuffer(), { status: hit.status, headers: headers });
  }

  const cur = await readArticles(env);
  if (!cur.ok) return serveSiteEdge(env, pathname, SITE[pathname], request);

  const buf = new TextEncoder().encode(publicArticlesJson(cur.articles)).buffer;
  const headers = new Headers();
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', cacheControlOf(pol, false));
  headers.set('x-edge', 'MISS');
  headers.set('etag', '"h' + hash32(buf) + '"');
  if (pol.ttl > 0) {
    try { await EDGE_CACHE.put(cacheKey, new Response(buf, { status: 200, headers: new Headers(headers) })); } catch (e) {}
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: headers });
  return new Response(buf, { status: 200, headers: headers });
}

// 后台可以保存的站点配置分组
const SITE_SECTIONS = ['ad', 'layout', 'contact', 'beian', 'seo', 'geo', 'theme', 'article', 'runtime'];

// 读取仓库 data/site.json（raw 地址，边缘缓存 RAW_TTL 秒），给站点页和 sitemap 用；失败时用默认值
async function loadSiteRaw(env) {
  if (!repoOf(env).owner || !repoOf(env).name) return normalizeSite(null);
  const u = 'https://raw.githubusercontent.com/' + repoOf(env).owner + '/' + repoOf(env).name + '/' + branch(env) + '/' + SITE_FILE;
  const r = await fetch(u, { cf: { cacheTtl: RAW_TTL, cacheEverything: true } });
  if (!r.ok) return normalizeSite(null);
  try {
    return normalizeSite(JSON.parse(await r.text()));
  } catch (e) {
    return normalizeSite(null);
  }
}

// HTML 属性值转义
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 把 site.seo 写进站点页 head 的标题和 meta；字段为空就保留页面原来的内容
function applySeo(html, seo) {
  let out = html;
  const put = (re, val, build) => {
    if (!val) return;
    const v = escAttr(val);
    out = out.replace(re, () => build(v));
  };
  const base = seo.siteUrl ? String(seo.siteUrl).replace(/\/+$/, '') : '';
  put(/<title>[\s\S]*?<\/title>/i, seo.title, (v) => '<title>' + v + '</title>');
  put(/<meta\s+name=["']description["'][^>]*>/i, seo.description, (v) => '<meta name="description" content="' + v + '">');
  put(/<meta\s+name=["']keywords["'][^>]*>/i, seo.keywords, (v) => '<meta name="keywords" content="' + v + '">');
  put(/<meta\s+property=["']og:title["'][^>]*>/i, seo.title, (v) => '<meta property="og:title" content="' + v + '">');
  put(/<meta\s+property=["']og:description["'][^>]*>/i, seo.description, (v) => '<meta property="og:description" content="' + v + '">');
  put(/<meta\s+property=["']og:image["'][^>]*>/i, seo.ogImage, (v) => '<meta property="og:image" content="' + v + '">');
  put(/<meta\s+property=["']og:url["'][^>]*>/i, base, (v) => '<meta property="og:url" content="' + v + '/">');
  // 有分享图才值得用大图卡片，否则社交平台会留一块空白
  put(
    /<meta\s+name=["']twitter:card["'][^>]*>/i,
    seo.ogImage ? 'summary_large_image' : 'summary',
    (v) => '<meta name="twitter:card" content="' + v + '">'
  );
  put(/<meta\s+name=["']twitter:image["'][^>]*>/i, seo.ogImage, (v) => '<meta name="twitter:image" content="' + v + '">');
  put(/<link\s+rel=["']canonical["'][^>]*>/i, base, (v) => '<link rel="canonical" href="' + v + '/">');
  return out;
}

// ── 单篇文章页：外壳仍是 articles.html，但按文章注入标题/描述/分享图/JSON-LD。
// 搜索引擎与社交平台抓到的是这一篇的元信息，而不是整站默认值。
function artPathOf(a) {
  if (!a) return '';
  const s = String(a.slug || a.id || '');
  return '/articles/' + s.split('/').map(encodeURIComponent).join('/') + '.html';
}

function plainTextOf(md, max) {
  const t = String(md == null ? '' : md)
    .replace(/[\u0060]{3}[\s\S]*?[\u0060]{3}/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// /nav：同一份 index.html 的另一个地址，换成自己的标题/描述/canonical
function applyNavSeo(html, seo) {
  const base = seo && seo.siteUrl ? String(seo.siteUrl).replace(/\/+$/, '') : '';
  const full = base + '/nav';
  const siteName = (seo && (seo.siteName || seo.title)) || '';
  const title = '站点导航' + (siteName ? ' · ' + siteName : '');
  const desc = '按分类整理的常用站点：开发工具、AI 与大模型、设计素材、学习资料、效率工具，每条都带一句说明。';
  let out = html;
  const put = (re, tag) => {
    if (re.test(out)) out = out.replace(re, () => tag);
    else out = out.replace(/<\/head>/i, () => tag + '\n</head>');
  };
  put(/<title>[\s\S]*?<\/title>/i, '<title>' + escAttr(title) + '</title>');
  put(/<meta\s+name=["']description["'][^>]*>/i, '<meta name="description" content="' + escAttr(desc) + '">');
  put(/<meta\s+property=["']og:title["'][^>]*>/i, '<meta property="og:title" content="' + escAttr(title) + '">');
  put(/<meta\s+property=["']og:description["'][^>]*>/i, '<meta property="og:description" content="' + escAttr(desc) + '">');
  put(/<meta\s+property=["']og:url["'][^>]*>/i, '<meta property="og:url" content="' + escAttr(full) + '">');
  put(/<link\s+rel=["']canonical["'][^>]*>/i, '<link rel="canonical" href="' + escAttr(full) + '">');
  return out;
}

function applyArticleSeo(html, seo, art, origin, path) {
  const base = seo && seo.siteUrl ? String(seo.siteUrl).replace(/\/+$/, '') : origin;
  const full = base + path;
  const siteName = (seo && (seo.siteName || seo.title)) || '';
  const title = (art.title || '文章') + (siteName ? ' · ' + siteName : '');
  const desc = plainTextOf(art.summary || art.body, 160) || siteName;
  const img = art.cover || (seo && seo.ogImage) || '';
  // 只有「真的带密文」才算加密：老数据可能只标了 locked 却没保存密文，内容其实是公开的
  const locked = !!(art.locked && art.lock && art.lock.ct);
  let out = applySeo(html, seo || {});
  const upsert = (re, tag) => {
    if (re.test(out)) out = out.replace(re, function () { return tag; });
    else out = out.replace(/<\/head>/i, function () { return tag + '\n</head>'; });
  };
  upsert(/<title>[\s\S]*?<\/title>/i, '<title>' + escAttr(title) + '</title>');
  upsert(/<meta\s+name=["']description["'][^>]*>/i, '<meta name="description" content="' + escAttr(desc) + '">');
  upsert(/<meta\s+property=["']og:title["'][^>]*>/i, '<meta property="og:title" content="' + escAttr(title) + '">');
  upsert(/<meta\s+property=["']og:description["'][^>]*>/i, '<meta property="og:description" content="' + escAttr(desc) + '">');
  upsert(/<meta\s+property=["']og:url["'][^>]*>/i, '<meta property="og:url" content="' + escAttr(full) + '">');
  if (img) {
    upsert(/<meta\s+property=["']og:image["'][^>]*>/i, '<meta property="og:image" content="' + escAttr(img) + '">');
    upsert(/<meta\s+name=["']twitter:image["'][^>]*>/i, '<meta name="twitter:image" content="' + escAttr(img) + '">');
    upsert(/<meta\s+name=["']twitter:card["'][^>]*>/i, '<meta name="twitter:card" content="summary_large_image">');
  }
  upsert(/<link\s+rel=["']canonical["'][^>]*>/i, '<link rel="canonical" href="' + escAttr(full) + '">');
  upsert(
    /<meta\s+name=["']robots["'][^>]*>/i,
    '<meta name="robots" content="' + (locked ? 'noindex,follow' : 'index,follow,max-image-preview:large') + '">'
  );
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: art.title || '文章',
    description: desc,
    url: full,
    mainEntityOfPage: full,
    image: img ? [img] : undefined,
    isAccessibleForFree: locked ? false : true,
    publisher: siteName ? { '@type': 'Organization', name: siteName } : undefined,
  };
  if (art.date) {
    ld.datePublished = String(art.date).slice(0, 10);
    ld.dateModified = String(art.date).slice(0, 10);
  }
  let head = '<meta property="og:type" content="article">';
  if (art.date) head += '<meta property="article:published_time" content="' + escAttr(String(art.date).slice(0, 10)) + '">';
  head += '<script type="application/ld+json">' + JSON.stringify(ld) + '</script>';
  out = out.replace(/<\/head>/i, function () { return head + '\n</head>'; });
  return out;
}

async function serveArticlePage(env, path, request) {
  const u = new URL(request.url);
  const ver = u.searchParams.get('v') || '';
  const key = EDGE_KEY_BASE + path + (ver ? '?v=' + ver : '');
  const hit = await EDGE_CACHE.match(key);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-edge', 'HIT');
    const etag = headers.get('etag');
    if (etag && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    if (request.method === 'HEAD') return new Response(null, { status: hit.status, headers });
    return new Response(await hit.arrayBuffer(), { status: hit.status, headers });
  }
  const shell = await serveSite(env, SITE['/articles']);
  if (!shell || shell.status !== 200) return shell;
  let html = await shell.text();
  const seo = (await loadSiteRaw(env)).seo || {};
  let arts = await rawJson(env, 'data/articles.json');
  arts = Array.isArray(arts) ? arts : [];
  fillArticleSlugs(arts);
  let pool = arts;
  let art = arts.filter(function (a) { return a && a.id; }).find(function (a) { return artPathOf(a) === path; });
  if (!art) {
    // raw 有 60~300 秒的子请求缓存，刚提交的文章可能还没出现；回退一次 GitHub API 拿真值
    try {
      const fresh = await readArticles(env);
      if (fresh && fresh.ok && Array.isArray(fresh.articles)) {
        pool = fresh.articles;
        fillArticleSlugs(fresh.articles);
        art = fresh.articles.filter(function (a) { return a && a.id; }).find(function (a) { return artPathOf(a) === path; });
      }
    } catch (e) {
      art = null;
    }
  }
  if (!art) {
    // 改过分类/序号的文章：旧地址 301 到现在的规范地址，别让外链和收录变 404
    const alias = pool.filter(function (a) { return a && a.id && Array.isArray(a.prevSlugs) && a.prevSlugs.length; })
      .find(function (a) {
        // prevSlugs 存的是「分类词/序号」不带 /articles 前缀，这里两种写法都认
        return a.prevSlugs.some(function (x) { return ('/articles/' + x) === path || ('/articles/' + x + '.html') === path; });
      });
    if (alias) {
      return new Response(null, {
        status: 301,
        headers: { location: encodeURI(artPathOf(alias)) + (u.search || ''), 'cache-control': 'public, max-age=600' },
      });
    }
  }
  if (!art) return notFoundPage(u.origin);
  html = applyArticleSeo(html, seo, art, u.origin, path);
  const body = new TextEncoder().encode(html);
  const etag = '"' + hash32(body.buffer) + '"';
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=60, s-maxage=60',
    etag: etag,
  });
  if (request.method !== 'HEAD') {
    await EDGE_CACHE.put(key, new Response(body.slice(0), { headers: new Headers(headers) }));
  }
  headers.set('x-edge', 'MISS');
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: headers });
}

function checkConfig(env) {
  const miss = [];
  ['GITHUB_TOKEN', 'REPO_OWNER', 'REPO_NAME'].forEach((k) => {
    if (!env[k]) miss.push(k);
  });
  return miss;
}

function filePath(env) {
  return env.FILE_PATH || DEFAULT_FILE;
}

// 仓库位置：优先读环境变量，读不到就用站点自身的默认值。
// 这样即使有人部署时把变量清掉了（Cloudflare 部署会整体替换绑定），站点也不会 503。
const DEFAULT_OWNER = 'xiaoh2018';
const DEFAULT_REPO = 'github-rank';
function repoOf(env) {
  const o = String((env && env.REPO_OWNER) || '').trim() || DEFAULT_OWNER;
  const n = String((env && env.REPO_NAME) || '').trim() || DEFAULT_REPO;
  return { owner: o, name: n };
}

function branch(env) {
  return env.BRANCH || DEFAULT_BRANCH;
}

function repoApi(env, p) {
  return 'https://api.github.com/repos/' + repoOf(env).owner + '/' + repoOf(env).name + p;
}

function ghHeaders(env, extra) {
  return Object.assign(
    {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-rank-keepalive',
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
    },
    extra || {}
  );
}

async function gh(env, p, init) {
  const r = await fetch(repoApi(env, p), Object.assign({ headers: ghHeaders(env) }, init || {}));
  const txt = await r.text();
  let data = null;
  try {
    data = JSON.parse(txt);
  } catch (e) {
    data = null;
  }
  return { ok: r.ok, status: r.status, data: data, text: txt };
}

function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

// 往仓库的 keepalive.txt 写入当前时间，产生一次提交
async function keepalive(env) {
  const miss = checkConfig(env);
  if (miss.length) return { ok: false, error: '还没配置变量：' + miss.join('、') };

  const path = filePath(env);
  const br = branch(env);
  const iso = new Date().toISOString();

  const cur = await gh(env, '/contents/' + path + '?ref=' + encodeURIComponent(br));
  let sha = null;
  if (cur.ok && cur.data && cur.data.sha) {
    sha = cur.data.sha;
  } else if (cur.status !== 404) {
    return { ok: false, error: '读取文件失败：' + cur.status + ' ' + cur.text.slice(0, 200) };
  }

  const body = {
    message: 'chore: keepalive ' + iso,
    content: utf8ToBase64(iso + '\n'),
    branch: br,
  };
  if (sha) body.sha = sha;

  const put = await gh(env, '/contents/' + path, {
    method: 'PUT',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!put.ok) {
    return { ok: false, error: '写入失败：' + put.status + ' ' + put.text.slice(0, 200) };
  }
  await purgeEdge(['/api/status']);
  return { ok: true, time: fmtBJ(new Date(iso)) };
}

// 访客打开首页时调用：数据太旧、且没有在跑、也不在冷却期，就触发一次 Update data 工作流
// 检查结果用边缘缓存记 5 分钟，避免每次访问都请求 GitHub API（限额 5000 次/小时）
async function maybeRefresh(env) {
  if (checkConfig(env).length) return;

  const cache = globalThis.caches.default;
  const key = new Request('https://ghrank.internal/refresh-check');
  if (await cache.match(key)) return;
  await cache.put(key, new Response('1', { headers: { 'cache-control': 'public, max-age=300' } }));

  const staleH = Number(env.STALE_HOURS) || 6;
  const coolMin = Number(env.COOLDOWN_MINUTES) || 60;

  const dataUrl =
    'https://raw.githubusercontent.com/' + repoOf(env).owner + '/' + repoOf(env).name + '/' + branch(env) + '/data/repos.js';
  const dataRes = await fetch(dataUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!dataRes.ok) return;
  const m = (await dataRes.text()).match(/generatedAt:\s*"([^"]+)"/);
  const genAt = m ? Date.parse(m[1]) : NaN;
  if (!isNaN(genAt) && Date.now() - genAt < staleH * 3600000) return;

  const runs = await gh(env, '/actions/workflows/' + WORKFLOW_FILE + '/runs?per_page=1');
  const last = runs.ok && runs.data && runs.data.workflow_runs && runs.data.workflow_runs[0];
  if (last) {
    if (last.status !== 'completed') return;
    if (Date.now() - Date.parse(last.created_at) < coolMin * 60000) return;
  }

  const d = await gh(env, '/actions/workflows/' + WORKFLOW_FILE + '/dispatches', {
    method: 'POST',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ref: branch(env) }),
  });
  console.log(d.ok ? '已触发 Update data' : '触发失败：' + d.status + ' ' + d.text.slice(0, 200));
}

// 访客点「立即刷新」时调用：触发一次 Update data，让仓库数据更新，之后所有访客打开都能看到新数据
// 仍受冷却时间和「正在运行」限制，防止被刷爆 Action 额度
async function triggerRefresh(env) {
  if (checkConfig(env).length) return { ok: false, status: 500, msg: '服务器没有配置 GITHUB_TOKEN' };
  const coolMin = Number(env.COOLDOWN_MINUTES) || 60;
  const runs = await gh(env, '/actions/workflows/' + WORKFLOW_FILE + '/runs?per_page=1');
  const last = runs.ok && runs.data && runs.data.workflow_runs && runs.data.workflow_runs[0];
  if (last) {
    if (last.status !== 'completed') return { ok: true, started: false, msg: '数据正在更新中，几分钟后刷新即可看到最新数据' };
    if (Date.now() - Date.parse(last.created_at) < coolMin * 60000) {
      return { ok: true, started: false, msg: '数据刚更新过，约 ' + coolMin + ' 分钟后才能再次更新' };
    }
  }
  const d = await gh(env, '/actions/workflows/' + WORKFLOW_FILE + '/dispatches', {
    method: 'POST',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ref: branch(env) }),
  });
  if (!d.ok) return { ok: false, status: 502, msg: '触发更新失败：' + d.status };
  await purgeEdge(['/api/status']);
  return { ok: true, started: true, msg: '已开始更新仓库数据，通常 2～5 分钟后所有访客打开都能看到新数据' };
}

// 下一次定时执行的时间（cron "0 2 * * 1"：UTC 周一 02:00）
function nextRunUTC(now) {
  const d = new Date(now);
  d.setUTCHours(2, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (d.getTime() > now.getTime() && d.getUTCDay() === 1) return d;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function fmtBJ(d) {
  const t = new Date(d.getTime() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) + ' ' +
    p(t.getUTCHours()) + ':' + p(t.getUTCMinutes())
  );
}

// 翻译链路的自检信息：只回布尔值，不暴露任何密钥内容
function translatorStatus(env, rt) {
  const cap = aiCap(env, rt);
  return {
    githubToken: !!env.GITHUB_TOKEN,
    ai: !!env.AI,
    contactEmail: !!env.TRANSLATE_EMAIL || !!env.TRANSLATE_EMAILS || !!(rt && rt.emails),
    emails: mmEmails(env, rt).length,
    aiCap: cap === Infinity ? 0 : cap,
    aiCapSource: rt && typeof rt.aiCap === 'number' ? 'admin' : (env.AI_DAILY_CAP ? 'env' : 'default'),
  };
}

async function getStatus(env) {
  const now = new Date();
  const next = fmtBJ(nextRunUTC(now)) + '（北京时间）';

  const miss = checkConfig(env);
  if (miss.length) {
    return { configured: false, error: '还没配置变量：' + miss.join('、') + '，请按部署说明添加', next: next, translator: translatorStatus(env) };
  }

  const path = filePath(env);
  const [commits, runs] = await Promise.all([
    gh(env, '/commits?path=' + encodeURIComponent(path) + '&per_page=1'),
    gh(env, '/actions/workflows/' + WORKFLOW_FILE + '/runs?per_page=1'),
  ]);

  const list = commits.ok && Array.isArray(commits.data) ? commits.data : [];
  const lastIso = list.length ? list[0].commit.committer.date : null;

  let age = null;
  let level = 'warn';
  let stateText = '还没有保活记录';
  let stateNote = '点页面上的「立即保活一次」，或等待下次定时执行';

  if (lastIso) {
    age = Math.floor((now.getTime() - Date.parse(lastIso)) / 86400000);
    if (age <= 10) {
      level = 'ok';
      stateText = '正常';
      stateNote = '距上次保活不到 10 天，离 60 天停用线还很远';
    } else if (age <= 30) {
      level = 'warn';
      stateText = '注意';
      stateNote = '已超过一个周期没有保活，请检查 Cron 定时是否生效';
    } else {
      level = 'bad';
      stateText = '有风险';
      stateNote = '超过 30 天没有保活，接近 60 天停用线，请尽快手动保活';
    }
  }

  if (!commits.ok) {
    level = 'bad';
    stateText = '读取失败';
    stateNote = 'GitHub 返回 ' + commits.status + '，请检查 Token 权限和仓库名';
  }

  const run = runs.ok && runs.data && runs.data.workflow_runs && runs.data.workflow_runs[0];
  const workflow = run
    ? { status: run.status, conclusion: run.conclusion, time: fmtBJ(new Date(run.created_at)) }
    : null;

  return {
    configured: true,
    level: level,
    stateText: stateText,
    stateNote: stateNote,
    lastKeepalive: lastIso ? fmtBJ(new Date(lastIso)) : null,
    age: age,
    next: next,
    workflow: workflow,
    workflowError: runs.ok ? null : '读取数据更新任务失败：GitHub 返回 ' + runs.status,
    translator: translatorStatus(env),
  };
}

// /api/status 的薄缓存：两个 GitHub 请求本身已经并行，剩下的延迟就是 API 往返。
// 用 Cache API 挡 60 秒，后台反复刷新页面不会每次都打到 GitHub（5000 次/小时的额度也省了）。
// 保活、触发更新之后会主动 purge，所以状态不会因此变旧。
async function getStatusCached(env) {
  const key = new Request(EDGE_KEY_BASE + '/api/status', { method: 'GET' });
  const hit = await EDGE_CACHE.match(key);
  if (hit) {
    try {
      return await hit.json();
    } catch (e) {
      // 缓存里是坏数据，删掉重新算
      await EDGE_CACHE.delete(key);
    }
  }
  const data = await getStatus(env);
  const res = new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=60',
    },
  });
  try {
    await EDGE_CACHE.put(key, res);
  } catch (e) {
    console.log('status cache put failed: ' + String(e));
  }
  return data;
}

// ---- 友链后台 ----
const LINKS_FILE = 'data/links.json';
const LINKS_MAX = 50;

// 常量时间比较，避免按返回时间逐字符猜密码
function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// 从仓库读 data/links.json：返回 { ok, status, links, sha } 或 { ok: false, status, error }；文件不存在视为 []
async function readLinks(env) {
  const miss = checkConfig(env);
  if (miss.length) return { ok: false, status: 500, error: '还没配置变量：' + miss.join('、') };
  const cur = await gh(env, '/contents/' + LINKS_FILE + '?ref=' + encodeURIComponent(branch(env)));
  if (cur.status === 404) return { ok: true, status: 404, links: [], sha: null };
  if (!cur.ok || !cur.data) {
    return { ok: false, status: cur.status, error: '读取友链失败：' + cur.status + ' ' + cur.text.slice(0, 200) };
  }
  let links = [];
  try {
    const bin = atob(String(cur.data.content || '').replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const txt = new TextDecoder().decode(bytes);
    if (txt.trim()) {
      const parsed = JSON.parse(txt);
      if (!Array.isArray(parsed)) throw new Error('not array');
      links = parsed;
    }
  } catch (e) {
    return { ok: false, status: 500, error: 'data/links.json 不是合法的 JSON 数组，请先在仓库里修正' };
  }
  return { ok: true, status: 200, links: links, sha: cur.data.sha || null };
}

// 把友链数组写回 data/links.json（带上当前 sha）
async function writeLinks(env, links, sha, msg) {
  const body = {
    message: msg,
    content: utf8ToBase64(JSON.stringify(links, null, 2) + '\n'),
    branch: branch(env),
  };
  if (sha) body.sha = sha;
  const put = await gh(env, '/contents/' + LINKS_FILE, {
    method: 'PUT',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!put.ok) return { ok: false, error: '写入失败：' + put.status + ' ' + put.text };
  return { ok: true };
}

async function handleLinks(request, env) {
  if (request.method === 'GET') {
    const r = await readLinks(env);
    if (!r.ok) return json({ ok: false, error: r.error }, 502);
    return json({ ok: true, links: r.links });
  }

  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '没有设置 ADMIN_PASSWORD，后台已关闭' }, 403);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: '请求体必须是 JSON 对象' }, 400);
  }
  if (!safeEqual(body.password == null ? '' : body.password, env.ADMIN_PASSWORD)) {
    return json({ ok: false, error: '密码不对' }, 403);
  }
  if (body.action !== 'add' && body.action !== 'remove' && body.action !== 'update' && body.action !== 'move') {
    return json({ ok: false, error: 'action 只能是 add、remove、update 或 move' }, 400);
  }

  const cur = await readLinks(env);
  if (!cur.ok) return json({ ok: false, error: cur.error }, 502);
  const links = cur.links;

  const pickLink = () => {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const desc = typeof body.desc === 'string' ? body.desc.trim() : '';
    if (!name) return { ok: false, error: '名称不能为空' };
    if (name.length > 40) return { ok: false, error: '名称不能超过 40 个字符' };
    if (!/^https?:\/\//i.test(url) || url.length > 300) {
      return { ok: false, error: '网址必须以 http:// 或 https:// 开头，且不超过 300 个字符' };
    }
    try {
      new URL(url);
    } catch (e) {
      return { ok: false, error: '网址格式不正确' };
    }
    if (desc.length > 80) return { ok: false, error: '描述最多 80 字' };
    return { ok: true, value: { name: name, url: url, desc: desc } };
  };

  if (body.action === 'move') {
    const bad = (x) => typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= links.length;
    if (bad(body.from) || bad(body.to)) return json({ ok: false, error: '要移动的位置不正确' }, 400);
    if (body.from !== body.to) {
      const item = links.splice(body.from, 1)[0];
      links.splice(body.to, 0, item);
    }
  } else if (body.action === 'remove') {
    const idx = body.index;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= links.length) {
      return json({ ok: false, error: '序号不正确' }, 400);
    }
    links.splice(idx, 1);
  } else {
    const v = pickLink();
    if (!v.ok) return json({ ok: false, error: v.error }, 400);
    if (body.action === 'update') {
      const idx = body.index;
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= links.length) {
        return json({ ok: false, error: '序号不正确' }, 400);
      }
      const dup = links.some((l, i) => l && l.url === v.value.url && i !== idx);
      if (dup) return json({ ok: false, error: '这个网址已经在友链里了' }, 409);
      links[idx] = v.value;
    } else {
      if (links.length >= LINKS_MAX) return json({ ok: false, error: '友链最多 ' + LINKS_MAX + ' 条，请先删除再添加' }, 400);
      if (links.some((l) => l && l.url === v.value.url)) return json({ ok: false, error: '这个网址已经在友链里了' }, 409);
      links.push(v.value);
    }
  }

  const w = await writeLinks(env, links, cur.sha, 'chore: update friend links');
  if (!w.ok) return json({ ok: false, error: w.error }, 500);
  await purgeEdge(['/data/links.json']);
  await warmEdge('/data/links.json', JSON.stringify(links, null, 2) + '\n', 'application/json; charset=utf-8');
  return json({ ok: true, links: links });
}

// ---- 站点配置（广告 / 联系方式）：数据存在仓库 data/site.json ----
// ---------- 导航页（data/nav.json）----------
// 结构：{ updatedAt, groups:[ {id, name, desc, items:[{name, url, desc, icon}]} ] }
const THEME_NAMES = ['paper', 'ink', 'stripe', 'notion'];
const NAV_FILE = 'data/nav.json';
// ---------- 问答（GEO）----------
// 存在 data/qa.json：前台 /faq 展示，并把 FAQPage 结构化数据注入页面 head，
// 让搜索引擎和 AI 检索器直接读到问答对（这是 GEO 最有效的抓手之一）。
const QA_FILE = 'data/qa.json';

function emptyQa() {
  return { updatedAt: '', intro: '', items: [] };
}

function normalizeQa(raw) {
  const out = emptyQa();
  const src = raw && typeof raw === 'object' ? raw : {};
  out.intro = String(src.intro || '').slice(0, 600);
  const items = Array.isArray(src.items) ? src.items : [];
  out.items = items
    .slice(0, 200)
    .map(function (it) {
      const o = it && typeof it === 'object' ? it : {};
      return {
        q: String(o.q || '').trim().slice(0, 200),
        a: String(o.a || '').trim().slice(0, 4000),
        tag: String(o.tag || '').trim().slice(0, 20),
      };
    })
    .filter(function (it) {
      return it.q && it.a;
    });
  out.updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : '';
  return out;
}

async function readQa(env) {
  const miss = checkConfig(env);
  if (miss.length) return { ok: false, status: 500, error: '还没配置变量：' + miss.join('、') };
  const cur = await gh(env, '/contents/' + QA_FILE + '?ref=' + encodeURIComponent(branch(env)));
  if (cur.status === 404) return { ok: true, status: 404, qa: emptyQa(), sha: null };
  if (!cur.ok || !cur.data) {
    return { ok: false, status: cur.status, error: '读取问答失败：' + cur.status + ' ' + cur.text.slice(0, 200) };
  }
  let qa = emptyQa();
  try {
    const bin = atob(String(cur.data.content || '').replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const txt = new TextDecoder().decode(bytes);
    if (txt.trim()) qa = normalizeQa(JSON.parse(txt));
  } catch (e) {
    return { ok: false, status: 500, error: 'data/qa.json 不是合法的 JSON，请先在仓库里修正' };
  }
  return { ok: true, status: 200, qa: qa, sha: cur.data.sha || null };
}

async function writeQa(env, qa, sha, msg) {
  const body = {
    message: msg,
    content: utf8ToBase64(JSON.stringify(qa, null, 2) + '\n'),
    branch: branch(env),
  };
  if (sha) body.sha = sha;
  const put = await gh(env, '/contents/' + QA_FILE, {
    method: 'PUT',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!put.ok) return { ok: false, error: '写入失败：' + put.status + ' ' + put.text };
  return { ok: true };
}

async function handleQa(request, env) {
  if (request.method === 'GET') {
    const r = await readQa(env);
    if (!r.ok) return json({ ok: false, error: r.error }, r.status || 500);
    return json({ ok: true, qa: r.qa });
  }
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: '请求体不是 JSON' }, 400);
  }
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: '还没配置 ADMIN_PASSWORD' }, 500);
  if (String(body.password || '') !== String(env.ADMIN_PASSWORD)) return json({ ok: false, error: '密码不对' }, 401);
  const cur = await readQa(env);
  if (!cur.ok) return json({ ok: false, error: cur.error }, cur.status || 500);
  const qa = normalizeQa(body.qa);
  qa.updatedAt = new Date().toISOString();
  const w = await writeQa(env, qa, cur.sha, 'chore(qa): 更新问答');
  if (!w.ok) return json({ ok: false, error: w.error }, 500);
  try {
    await warmEdge('/data/qa.json', JSON.stringify(qa), 'application/json; charset=utf-8');
  } catch (e) {}
  return json({ ok: true, qa: qa });
}

// 给 /faq 页注入 FAQPage 结构化数据：AI 与搜索引擎读源码就能拿到问答对
async function injectFaqLd(env, html) {
  let qa = emptyQa();
  try {
    const r = await readQa(env);
    if (r.ok) qa = r.qa;
  } catch (e) {}
  const items = qa.items.slice(0, 60);
  if (!items.length) return html;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(function (it) {
      return {
        '@type': 'Question',
        name: it.q,
        acceptedAnswer: { '@type': 'Answer', text: it.a },
      };
    }),
  };
  const tag = '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</' + 'script>';
  if (html.indexOf('</head>') < 0) return html;
  return html.replace('</head>', tag + '\n</head>');
}

// 静态资源版本：HTML 里的 /js/*.js 都会被加上 ?v=<这里>，于是能给浏览器一年 immutable；
// 改了前端就把它 +1（不然用户浏览器会抱着一周的旧 bundle，界面上去点了没反应）
const ASSET_V = 'v205';

function emptyNav() {
  return { updatedAt: '', groups: [] };
}

// 不管仓库里存的是什么，先过一遍清洗，前台就不用再防了
function normalizeNav(raw) {
  const out = emptyNav();
  const src = raw && typeof raw === 'object' ? raw : {};
  const groups = Array.isArray(src.groups) ? src.groups : [];
  const used = {};
  groups.forEach((g, gi) => {
    if (!g || typeof g !== 'object') return;
    let id = String(g.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
    if (!id) id = 'g' + (gi + 1);
    while (used[id]) id = id + 'x';
    used[id] = 1;
    const items = (Array.isArray(g.items) ? g.items : [])
      .map((it) => {
        if (!it || typeof it !== 'object') return null;
        const url = String(it.url || '').trim();
        if (!/^https?:\/\//i.test(url) || url.length > 300) return null;
        let name = String(it.name || '').trim().slice(0, 40);
        if (!name) name = url.replace(/^https?:\/\//i, '').split('/')[0];
        return {
          name: name,
          url: url,
          desc: String(it.desc || '').trim().slice(0, 200),
          icon: String(it.icon || '').trim().slice(0, 300),
        };
      })
      .filter(Boolean);
    out.groups.push({
      id: id,
      name: String(g.name || '未命名分类').trim().slice(0, 24),
      desc: String(g.desc || '').trim().slice(0, 80),
      items: items,
    });
  });
  out.updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : '';
  return out;
}

async function readNav(env) {
  const miss = checkConfig(env);
  if (miss.length) return { ok: false, status: 500, error: '还没配置变量：' + miss.join('、') };
  const cur = await gh(env, '/contents/' + NAV_FILE + '?ref=' + encodeURIComponent(branch(env)));
  if (cur.status === 404) return { ok: true, status: 404, nav: emptyNav(), sha: null };
  if (!cur.ok || !cur.data) {
    return { ok: false, status: cur.status, error: '读取导航失败：' + cur.status + ' ' + cur.text.slice(0, 200) };
  }
  let nav = emptyNav();
  try {
    const bin = atob(String(cur.data.content || '').replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const txt = new TextDecoder().decode(bytes);
    if (txt.trim()) nav = normalizeNav(JSON.parse(txt));
  } catch (e) {
    return { ok: false, status: 500, error: 'data/nav.json 不是合法的 JSON，请先在仓库里修正' };
  }
  return { ok: true, status: 200, nav: nav, sha: cur.data.sha || null };
}

async function writeNav(env, nav, sha, msg) {
  const body = {
    message: msg,
    content: utf8ToBase64(JSON.stringify(nav, null, 2) + '\n'),
    branch: branch(env),
  };
  if (sha) body.sha = sha;
  const put = await gh(env, '/contents/' + NAV_FILE, {
    method: 'PUT',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!put.ok) return { ok: false, error: '写入失败：' + put.status + ' ' + put.text };
  return { ok: true };
}

async function handleNav(request, env) {
  if (request.method === 'GET') {
    const r = await readNav(env);
    if (!r.ok) return json({ ok: false, error: r.error }, 502);
    return json({ ok: true, nav: r.nav });
  }
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '没有设置 ADMIN_PASSWORD，后台已关闭' }, 403);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: '请求体必须是 JSON 对象' }, 400);
  }
  if (!safeEqual(body.password == null ? '' : body.password, env.ADMIN_PASSWORD)) {
    return json({ ok: false, error: '密码不对' }, 403);
  }
  if (!body.nav || typeof body.nav !== 'object') {
    return json({ ok: false, error: '缺少 nav（整个导航结构）' }, 400);
  }
  const nav = normalizeNav(body.nav);
  nav.updatedAt = new Date().toISOString();
  if (nav.groups.length > 20) return json({ ok: false, error: '最多 20 个分类' }, 400);
  let total = 0;
  for (const g of nav.groups) total += g.items.length;
  if (total > 400) return json({ ok: false, error: '站点总数不能超过 400 个' }, 400);

  const cur = await readNav(env);
  if (!cur.ok) return json({ ok: false, error: cur.error }, 502);
  const put = await writeNav(env, nav, cur.sha, 'chore: 更新导航页（后台保存）');
  if (!put.ok) return json({ ok: false, error: put.error }, 502);
  await warmEdge('/data/nav.json', JSON.stringify(nav, null, 2) + '\n', 'application/json; charset=utf-8');
  return json({ ok: true, nav: nav });
}

// 抓一个网址的标题/描述/图标，后台「自动填描述」用
async function handleFetchMeta(rawUrl, env) {
  const input = String(rawUrl || '').trim();
  let u = null;
  try {
    u = new URL(input);
  } catch (e) {
    return json({ ok: false, error: '网址格式不对，要写完整的 https://…' }, 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return json({ ok: false, error: '只支持 http / https' }, 400);
  }
  if (/^(localhost$|127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|\[?::1$)/i.test(u.hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) {
    return json({ ok: false, error: '内网地址不抓取' }, 400);
  }
  let r = null;
  try {
    r = await fetch(u.toString(), {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ghrank-nav/1.0; +https://github.661026.xyz)' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
  } catch (e) {
    return json({ ok: false, error: '抓取失败：' + (e && e.message ? e.message : 'network') }, 502);
  }
  if (!r.ok) return json({ ok: false, error: '抓取失败：HTTP ' + r.status }, 502);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('html') < 0 && ct.indexOf('text/plain') < 0) {
    return json({ ok: false, error: '这不是网页（content-type: ' + ct + '）' }, 400);
  }
  const html = (await r.text()).slice(0, 500000);
  const decode = (s) =>
    String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const grab = (re) => {
    const m = html.match(re);
    return m && m[1] ? decode(m[1]) : '';
  };
  const title =
    grab(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i) ||
    grab(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']{1,200})/i);
  let desc =
    grab(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{1,400})/i) ||
    grab(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']{1,400})/i) ||
    grab(/<meta[^>]+content=["']([^"']{1,400})["'][^>]*name=["']description["']/i) ||
    grab(/<meta[^>]+content=["']([^"']{1,400})["'][^>]*property=["']og:description["']/i);
  if (!desc) {
    const m = html.match(/<p[^>]*>([\s\S]{1,600}?)<\/p>/i);
    if (m) desc = decode(m[1].replace(/<[^>]+>/g, '')).slice(0, 200);
  }
  let icon =
    grab(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)/i) ||
    grab(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)/i) ||
    grab(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)/i);
  if (icon && !/^https?:/i.test(icon)) {
    try {
      icon = new URL(icon, u).toString();
    } catch (e) {
      icon = '';
    }
  }
  if (!icon) icon = u.origin + '/favicon.ico';
  return json({
    ok: true,
    meta: {
      name: (title || u.hostname).slice(0, 40),
      desc: desc.slice(0, 200),
      icon: icon.slice(0, 300),
      url: u.toString(),
    },
  });
}

// ---------- 收录提交（搜索引擎 + AI 抓取器）----------
const AI_BOTS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'Claude-Web',
  'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'Bytespider', 'Baiduspider',
  'Sogou web spider', 'YisouSpider', 'PetalBot', 'Qwen-Bot', 'DeepSeek-Bot', 'Amazonbot', 'CCBot'
];

function notFoundPage(origin) {
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>页面不存在 · 排行榜</title><meta name="robots" content="noindex">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#111;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}'
    + '.box{max-width:520px;padding:34px 30px;background:#fff;border:1px solid #e6e8ec;border-radius:18px;box-shadow:0 12px 34px rgba(16,24,40,.06);text-align:center}'
    + '.code{font-size:46px;font-weight:800;letter-spacing:.02em;background:linear-gradient(90deg,#2563eb,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent}'
    + 'h1{font-size:18px;margin:6px 0 4px}p{color:#5b6472;margin:0 0 18px}'
    + '.links{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}'
    + '.links a{padding:9px 14px;border-radius:10px;border:1px solid #e6e8ec;color:#1f2937;text-decoration:none;font-weight:600;font-size:13.5px}'
    + '.links a:hover{border-color:#2563eb;color:#2563eb}'
    + '.links a.pri{background:#2563eb;border-color:#2563eb;color:#fff}'
    + '</style></head><body><div class="box">'
    + '<div class="code">404</div>'
    + '<h1>这个页面不存在</h1>'
    + '<p>链接可能过期了，或者地址打错了一个字符。</p>'
    + '<div class="links"><a class="pri" href="/">回排行榜</a><a href="/nav">导航</a><a href="/articles">文章</a><a href="/faq">问答</a></div>'
    + '</div></body></html>';
  return new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function robotsTxt(origin) {
  let t = 'User-agent: *\nAllow: /\n\n';
  t += '# 各家 AI 搜索 / 大模型的抓取器：明确放行\n';
  for (const b of AI_BOTS) t += 'User-agent: ' + b + '\nAllow: /\n\n';
  t += 'Sitemap: ' + origin + '/sitemap.xml\n';
  t += '# 给大模型读的站点说明：' + origin + '/llms.txt\n';
  return t;
}

// IndexNow 的 key 会在 /<key>.txt 上公开，用来证明域名归属
function indexNowKey(env, rt) {
  const custom = rt && typeof rt.indexNowKey === 'string' ? rt.indexNowKey.trim() : '';
  if (custom) return custom;
  if (env.INDEXNOW_KEY && String(env.INDEXNOW_KEY).trim()) return String(env.INDEXNOW_KEY).trim();
  const seed = String(repoOf(env).owner || '') + '/' + String(repoOf(env).name || '') + '/' + branch(env);
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let h2 = 5381;
  for (let i = seed.length - 1; i >= 0; i--) h2 = ((h2 * 33) ^ seed.charCodeAt(i)) >>> 0;
  return 'ghrank' + h.toString(16) + h2.toString(16);
}

async function rawJson(env, path) {
  if (!repoOf(env).owner || !repoOf(env).name) return null;
  try {
    const r = await fetch(
      'https://raw.githubusercontent.com/' + repoOf(env).owner + '/' + repoOf(env).name + '/' + branch(env) + '/' + path,
      { cf: { cacheTtl: RAW_TTL, cacheEverything: true } }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// llms.txt：给大模型看的站点说明（llmstxt.org 约定）
async function rssXml(env, origin) {
  const xe = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const site = await loadSiteRaw(env).catch(() => ({}));
  const seo = (site && site.seo) || {};
  const title = seo.siteName || 'GitHub 热门项目排行榜';
  const desc = seo.description || '按近 7 天 / 30 天 / 1 年与全站总榜看 GitHub 热门开源项目。';
  let list = [];
  try {
    const arts = await readArticles(env);
    list = (arts.articles || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  } catch (e) {
    list = [];
  }
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n';
  xml += '  <title>' + xe(title) + '</title>\n';
  xml += '  <link>' + xe(origin + '/articles') + '</link>\n';
  xml += '  <description>' + xe(desc) + '</description>\n';
  xml += '  <language>zh-CN</language>\n';
  xml += '  <lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n';
  for (const a of list.slice(0, 30)) {
    if (!a || !a.title) continue;
    const path = a.slug
      ? '/articles/' + String(a.slug).split('/').map(encodeURIComponent).join('/') + '.html'
      : '/articles#' + encodeURIComponent(String(a.id || ''));
    const link = origin + path;
    const pub = a.date ? new Date(String(a.date).slice(0, 10) + 'T00:00:00+08:00').toUTCString() : new Date().toUTCString();
    xml += '  <item>\n';
    xml += '    <title>' + xe(a.title) + '</title>\n';
    xml += '    <link>' + xe(link) + '</link>\n';
    xml += '    <guid isPermaLink="true">' + xe(link) + '</guid>\n';
    xml += '    <pubDate>' + pub + '</pubDate>\n';
    xml += '    <description>' + xe(a.summary || '') + '</description>\n';
    if (a.category) xml += '    <category>' + xe(a.category) + '</category>\n';
    xml += '  </item>\n';
  }
  xml += '</channel></rss>';
  return xml;
}

async function llmsTxt(env, origin) {
  const site = (await loadSiteRaw(env)).seo || {};
  const root = site.siteUrl ? String(site.siteUrl).replace(/\/+$/, '') : origin;
  const arts = await rawJson(env, 'data/articles.json');
  const nav = await rawJson(env, 'data/nav.json');
  const qa = await rawJson(env, 'data/qa.json');
  const lines = [];
  const name = site.siteName || 'GitHub 热门项目排行榜';
  lines.push('# ' + name);
  lines.push('');
  lines.push('> ' + (site.description || '按星标数排序的 GitHub 热门项目榜单，支持近 7 天 / 30 天 / 1 年 / 全站总榜，另有开发者榜、组织榜与常用站点导航。'));
  lines.push('');
  lines.push('本站是一个纯静态的 GitHub 热门项目看板：榜单数据由 GitHub Actions 每 3 小时抓取一次并写进仓库，页面由 Cloudflare Workers 直接返回（边缘缓存），没有账号体系、不需要登录。');
  lines.push('');
  lines.push('## 核心页面');
  lines.push('');
  lines.push('- 榜单首页：' + root + '/ — 项目榜；可切换「项目榜 / 开发者榜 / 组织榜」「近 7 天 / 近 30 天 / 近 1 年 / 总榜」，可按语言、分类、排序（星标 / 今日增量 / 活跃度 / Fork / 最近更新）筛选');
  lines.push('- 导航页：' + root + '/nav — 常用开发 / AI / 设计 / 学习 / 效率工具站点，分分类展示');
  lines.push('- 文章页：' + root + '/articles — 站点说明与更新记录（单篇地址形如 ' + root + '/articles/tech/3.html）');
  lines.push('- 中文界面：首页右上角「English / 中文」可切换，仓库简介会自动翻译成中文（译文有缓存，不会重复翻译）');
  lines.push('');
  lines.push('## 数据来源与口径');
  lines.push('');
  lines.push('- 来源：GitHub 公开 REST API（search/repositories、search/users），只统计公开仓库');
  lines.push('- 时间范围：近 7 天 / 近 30 天 / 近 1 年按仓库创建时间筛选；「总榜」= 全站按星标降序前 500（深翻 10 页），不分时间');
  lines.push('- 排序：默认按当前星标数从高到低；也可按今日增量、活跃度、Fork 数、最近更新时间');
  lines.push('- 每次最多保留 500 个项目；星标门槛：常规榜单 ≥ 50，总榜 ≥ 1000');
  lines.push('- 刷新频率：GitHub Actions 每 3 小时跑一次（cron 17 */3 * * *），页面走边缘缓存，数据落地后几分钟内可见');
  lines.push('');
  lines.push('## 机器可读接口');
  lines.push('');
  lines.push('- ' + root + '/data/repos-meta.js — 生成时间、条目数、开发者 / 组织榜数据（JS 变量 window.__GHRANK_META__）');
  lines.push('- ' + root + '/data/repos-week.js · repos-month.js · repos-year.js · repos-total.js — 各时间范围的完整榜单（window.__GHRANK_RANGES__）');
  lines.push('- ' + root + '/data/site.json — 站点配置（SEO、布局、广告位开关等）');
  lines.push('- ' + root + '/data/articles.json — 文章列表与正文');
  lines.push('- ' + root + '/data/nav.json — 导航站点列表（分类 / 名称 / 地址 / 描述 / 图标）');
  lines.push('- ' + root + '/api/status — 数据新鲜度与最近一次抓取状态（JSON，60 秒缓存）');
  lines.push('- ' + root + '/sitemap.xml — 全站页面清单（含 lastmod）');
  lines.push('- ' + root + '/rss.xml — 文章 RSS 订阅源（RSS 2.0）');
  lines.push('');
  lines.push('## 引用与抓取建议');
  lines.push('');
  lines.push('- 允许并欢迎搜索引擎与 AI 检索器抓取（robots.txt 已对 GPTBot / ClaudeBot / PerplexityBot / Bytespider / Qwen-Bot 等逐条放行）');
  lines.push('- 引用榜单时请注明「数据来自 GitHub API，由 ' + name + ' 整理」，并链接到 ' + root + '/');
  lines.push('- 页面自带 300–900 秒缓存，请勿高频轮询；需要最新数据请拉上面的 JS/JSON 文件并带 ?v=<生成时间> 参数');
  lines.push('');
  const qaItems = (qa && qa.items) || [];
  if (qaItems.length) {
    lines.push('## 常见问答');
    lines.push('');
    qaItems.slice(0, 12).forEach((it, i) => {
      if (it && it.q) lines.push('- ' + String(it.q) + ' — ' + root + '/faq#q-' + (i + 1));
    });
    lines.push('');
  }
  lines.push('## 页面');
  lines.push('');
  lines.push('- 榜单首页：' + root + '/ （项目榜，可切语言、时间范围、排序方式；另有开发者榜、组织榜）');
  lines.push('- 文章列表：' + root + '/articles （使用说明与更新记录）');
  lines.push('- 常见问答：' + root + '/faq （按主题整理的高频提问，页面带 FAQPage 结构化数据，方便 AI 直接引用）');
  lines.push('- 站点地图：' + root + '/sitemap.xml');
  lines.push('');
  const list = Array.isArray(arts) ? arts : [];
  if (list.length) {
    lines.push('## 文章');
    lines.push('');
    for (const a of list.slice(0, 50)) {
      if (!a || !a.title) continue;
      const artUrl = root + '/articles/' + String(a.slug || a.id).split('/').map(encodeURIComponent).join('/') + '.html';
      lines.push('- [' + String(a.title) + '](' + artUrl + ')' + (a.date ? '（' + String(a.date).slice(0, 10) + '）' : '') +
        (a.summary ? '：' + String(a.summary) : ''));
    }
    lines.push('');
  }
  const groups = nav && Array.isArray(nav.groups) ? nav.groups : [];
  if (groups.length) {
    lines.push('## 导航（常用站点）');
    lines.push('');
    for (const g of groups) {
      const items = (g.items || []).slice(0, 12).map((it) => '[' + it.name + '](' + it.url + ')').join('、');
      if (items) lines.push('- ' + (g.name || '未命名') + '：' + items);
    }
    lines.push('');
  }
  lines.push('## 数据说明');
  lines.push('');
  lines.push('- 榜单数据每 3 小时由 GitHub Actions 抓取一次，页面走边缘缓存，通常数分钟内可见');
  lines.push('- 只统计公开仓库；排序依据是当前星标数，另有今日增量、活跃度、Fork、最近更新');
  lines.push('');
  return lines.join(String.fromCharCode(10));
}

function baiduTokenOf(env, rt) {
  const custom = rt && typeof rt.baiduToken === 'string' ? rt.baiduToken.trim() : '';
  return custom || env.BAIDU_TOKEN || '';
}

// AI 今天用了多少 / 上限多少 / 还剩多少
async function aiUsage(env, rt) {
  const cap = aiCap(env, rt);
  const used = await aiUsedToday(env);
  return {
    date: todayBJ().slice(0, 10),
    used: used,
    cap: cap === Infinity ? 0 : cap,
    remaining: cap === Infinity ? null : Math.max(0, cap - used),
    unlimited: cap === Infinity,
    capSource: rt && typeof rt.aiCap === 'number' ? 'admin' : (env.AI_DAILY_CAP ? 'env' : 'default'),
    bound: !!env.AI,
  };
}

// 主动提交：IndexNow（Bing / Yandex / Seznam / Naver 共用）、百度普通收录推送
function engineHint(kind, status) {
  const s = Number(status) || 0;
  if (kind === 'indexnow') {
    if (s === 202 || s === 200) return '（已接收：搜索引擎会自己来抓，Bing 站长工具的 IndexNow 页通常 24-72 小时才显示记录）';
    if (s === 429) return '（被限流：等 10 分钟再试，或勾「强制再推一次」改成只推首页 1 条）';
    if (s === 422) return '（Key 校验没过：确认 key 文件和后台填的 IndexNow Key 完全一致）';
    if (s === 403) return '（Key 文件打不开：确认 /<key>.txt 能直接访问，且站点是 https）';
    if (s === 400) return '（请求格式不对：检查 host 是否带协议头，host 只填域名）';
    if (s >= 500) return '（IndexNow 侧故障：过一会儿重试）';
    return '';
  }
  if (kind === 'baidu') {
    if (s === 200) return '（已接收：看下面的原始返回，success 是本次收录条数、remain 是当天剩余配额）';
    if (s === 400) return '（site 参数不对：必须是裸域名，如 github.661026.xyz，不带 https:// 也不带路径）';
    if (s === 401) return '（准入密钥无效：到 ziyuan.baidu.com 的「普通收录 → API 提交」重新复制 token）';
    if (s === 526) return '（站点校验没通过：先在百度搜索资源平台把该域名验证掉，推送域名要和验证的一级域名一致）';
    if (s === 507) return '（当天配额用完：明天再推，或减少一次推的 URL 数）';
    return '';
  }
  return '';
}

async function countsOf(env) {
  const got = await Promise.all([
    rawJson(env, 'data/articles.json').catch(function () { return null; }),
    rawJson(env, 'data/nav.json').catch(function () { return null; }),
    rawJson(env, 'data/qa.json').catch(function () { return null; }),
    rawJson(env, 'data/links.json').catch(function () { return null; }),
    rawJson(env, 'data/site.json').catch(function () { return null; }),
  ]);
  const a1 = got[0] || {};
  const n1 = got[1] || {};
  const q1 = got[2] || {};
  const l1 = got[3] || {};
  const s1 = got[4] || {};
  let navSites = 0;
  ((n1.groups || [])).forEach(function (g) { navSites += (g.items || []).length; });
  const arrOf = function (x) { return Array.isArray(x) ? x : []; };
  let categories = [];
  try { categories = normalizeSite(s1).article.categories || []; } catch (e) { categories = []; }
  return {
    articles: (Array.isArray(a1) ? a1.length : arrOf(a1.articles).length),
    categories: categories.length,
    navSites: navSites,
    navGroups: ((n1.groups || [])).length,
    qa: arrOf(q1.items).length,
    links: (Array.isArray(l1) ? l1.length : arrOf(l1.links).length),
  };
}

async function handleHealth(env, origin) {
  const rt = await siteRuntime(env);
  const key = indexNowKey(env, rt);
  let keyFileOk = null;
  let keyNote = '';
  try {
    const r = await fetch(origin + '/' + key + '.txt', { cf: { cacheTtl: 0 } });
    const body = r.ok ? (await r.text()).trim() : '';
    keyFileOk = r.ok && body === key;
    keyNote = r.ok ? body.slice(0, 60) : ('HTTP ' + r.status);
  } catch (e) {
    keyFileOk = false;
    keyNote = '抓取失败：' + ((e && e.message) || 'network');
  }
  let counts = null;
  try { counts = await countsOf(env); } catch (e) { counts = null; }
  let dataAge = null;
  try {
    const metaRes = await fetch(
      'https://raw.githubusercontent.com/' + repoOf(env).owner + '/' + repoOf(env).name + '/' + branch(env) + '/data/repos-meta.js',
      { cf: { cacheTtl: RAW_TTL, cacheEverything: true } }
    );
    if (metaRes.ok) {
      const metaText = await metaRes.text();
      const g = /generatedAt:\s*"([^"]+)"/.exec(metaText);
      if (g) {
        const mins = Math.max(0, Math.round((Date.now() - new Date(g[1]).getTime()) / 60000));
        dataAge = { generatedAt: g[1], minutes: mins };
      }
    }
  } catch (e) { dataAge = null; }
  let st = null;
  try { st = await getStatusCached(env); } catch (e) {}
  const baiduNow = baiduTokenOf(env, rt);
  const last = await readLastSubmit();
  const cooldownSec = (function (x) {
    if (!x || !x.at) return 0;
    const gap = Date.now() - new Date(x.at).getTime();
    return gap < 600000 ? Math.ceil((600000 - gap) / 1000) : 0;
  })(last);
  return json({
    ok: true,
    version: ASSET_V,
    now: new Date().toISOString(),
    configured: !!(st && st.configured),
    stateText: st ? st.stateText : '',
    workflow: st ? st.workflow : null,
    ai: await aiUsage(env, rt),
    keyFileOk: keyFileOk,
    counts: counts,
    dataAge: dataAge,
    level: st ? st.level : '',
    stateNote: st ? st.stateNote : '',
    lastKeepalive: st ? st.lastKeepalive : '',
    age: st ? st.age : null,
    next: st ? st.next : '',
    translator: translatorStatus(env, rt),
    submit: {
      keyFileOk: keyFileOk,
      keyFileMatch: keyFileOk,
      keyFileNote: keyNote,
      indexNowKey: key,
      indexKeySource: rt && rt.indexNowKey ? 'admin' : (env.INDEXNOW_KEY ? 'env' : 'auto'),
      baiduToken: !!baiduNow,
      baiduTokenSource: (rt && rt.baiduToken) ? 'admin' : (env.BAIDU_TOKEN ? 'env' : 'none'),
      lastRun: last,
      cooldown: { seconds: cooldownSec },
    },
  });
}

async function handleSubmit(request, env, origin) {
  const rtSubmit = await siteRuntime(env);
  const keyNow = indexNowKey(env, rtSubmit);
  const baiduNow = baiduTokenOf(env, rtSubmit);
  if (request.method === 'GET') {
    let keyOk = false;
    let keyNote = '';
    try {
      const kf = await fetch(origin + '/' + keyNow + '.txt', { headers: { 'cache-control': 'no-cache' } });
      keyOk = kf.ok;
      keyNote = keyOk ? '可以访问（' + (await kf.text()).trim().slice(0, 60) + '）' : 'HTTP ' + kf.status;
    } catch (e) {
      keyNote = '抓取失败：' + ((e && e.message) || 'network');
    }
    let urlCount = 2;
    let urlSample = [origin + '/', origin + '/articles'];
    try {
      const avPrev = await readArticles(env);
      const itemsPrev = (avPrev.articles || []).slice();
      itemsPrev.slice(0, 100).forEach(function (a) {
        if (!a || !a.id) return;
        const pth = a.slug
          ? '/articles/' + String(a.slug).split('/').map(encodeURIComponent).join('/') + '.html'
          : '/articles#' + encodeURIComponent(String(a.id));
        urlSample.push(origin + pth);
      });
      urlCount = urlSample.length;
      urlSample = urlSample.slice(0, 5);
    } catch (e) {}
    return json({
      ok: true,
      status: {
        indexNowKey: keyNow,
        keyFile: origin + '/' + keyNow + '.txt',
        keyFileOk: keyOk,
        keyFileNote: keyNote,
        keyFileMatch: keyOk && String(keyNote).indexOf(keyNow) >= 0,
        indexKeySource: rtSubmit && rtSubmit.indexNowKey ? 'admin' : (env.INDEXNOW_KEY ? 'env' : 'auto'),
        sitemap: origin + '/sitemap.xml',
        llms: origin + '/llms.txt',
        urlCount: urlCount,
        urlSample: urlSample,
        baiduToken: !!baiduNow,
        baiduTokenSource: (rtSubmit && rtSubmit.baiduToken) ? 'admin' : (env.BAIDU_TOKEN ? 'env' : 'none'),
        aiUsage: await aiUsage(env, rtSubmit),
        counts: await countsOf(env),
        lastRun: await readLastSubmit(),
        cooldown: (function (last) {
          if (!last || !last.at) return { seconds: 0 };
          const gap = Date.now() - new Date(last.at).getTime();
          return { seconds: gap < 600000 ? Math.ceil((600000 - gap) / 1000) : 0 };
        })(await readLastSubmit()),
      },
    });
  }
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: '没有设置 ADMIN_PASSWORD，后台已关闭' }, 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ ok: false, error: '请求体必须是 JSON' }, 400);
  if (!safeEqual(body.password == null ? '' : body.password, env.ADMIN_PASSWORD)) {
    return json({ ok: false, error: '密码不对' }, 403);
  }
  const prevRun = await readLastSubmit();
  if (prevRun && prevRun.at && body.force !== true) {
    const gap = Date.now() - new Date(prevRun.at).getTime();
    if (gap < 600000) {
      const wait = Math.ceil((600000 - gap) / 1000);
      return json({
        ok: false,
        wait: wait,
        error: '10 分钟内已经推过一次，再推 IndexNow 会回 429（限流）。等 ' + wait + ' 秒，或勾上「强制再推一次」。',
      }, 429);
    }
  }
  const site = (await loadSiteRaw(env)).seo || {};
  const root = site.siteUrl ? String(site.siteUrl).replace(/\/+$/, '') : origin;
  let host = '';
  try {
    host = new URL(root).host;
  } catch (e) {
    host = '';
  }
  const arts = await rawJson(env, 'data/articles.json');
  const urls = [root + '/', root + '/articles'];
  (Array.isArray(arts) ? arts : []).slice(0, 100).forEach((a) => {
    if (a && a.id) urls.push(root + '/articles/' + String(a.slug || a.id).split('/').map(encodeURIComponent).join('/') + '.html');
  });
  const want = String(body.action || 'all');
  if (body.test === true) {
    urls.length = 0;
    urls.push(root + '/');
  }
  const out = { ok: true, urls: urls.length, urlList: urls.slice(0, 50), urlListNote: urls.length > 50 ? '只显示前 50 条（共 ' + urls.length + ' 条）' : '', root: root, host: host, keyLocation: root + '/' + keyNow + '.txt', test: body.test === true, results: {} };

  const sigNow = urls.join(String.fromCharCode(10));
  const sameBatch = !!(prevRun && prevRun.sig === sigNow && body.force !== true);
  if ((want === 'all' || want === 'indexnow') && sameBatch) {
    out.results.indexNow = {
      ok: true,
      skipped: true,
      note: '这批地址上次已经推过，IndexNow 对同一批有频率限制，1 小时内不重复推（要强推就勾「强制再推一次」）',
    };
  }
  if ((want === 'all' || want === 'indexnow') && !sameBatch) {
    const key = keyNow;
    try {
      const t0 = Date.now();
      const r = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: host, key: key, keyLocation: root + '/' + key + '.txt', urlList: urls }),
      });
      const rawText = await r.text().catch(() => '');
      const good = r.ok || r.status === 202;
      let note;
      if (good) note = r.status === 202
        ? '已接收（202）：Bing / Yandex 收下了。要在 Bing 站长工具的「IndexNow」页看到记录，必须先在 Bing 站长工具里添加并验证本站；实际抓取通常 24–72 小时内反馈'
        : '已接收（200）：等搜索引擎自己来抓（通常几分钟到几小时）';
      else if (r.status === 429) note = '被限流了（TooManyRequests）：IndexNow 对同一批地址有频率限制，等 10 分钟再试；本站下次会自动跳过重复批次';
      else if (r.status === 422) note = 'Key 校验没过：确认站点根目录的 key 文件能打开，且提交的 host 与 keyLocation 同域';
      else if (r.status === 403) note = 'Key 文件打不开或内容不对：先把 Worker 部署到最新版，再回本页点「刷新」看自检那行';
      else note = 'IndexNow 返回 HTTP ' + r.status + '，见下面的原始返回';
      out.results.indexNow = { ok: good, status: r.status, ms: Date.now() - t0, note: note + engineHint('indexnow', r.status), raw: String(rawText || '').slice(0, 300) };
    } catch (e) {
      out.results.indexNow = { ok: false, status: 0, note: '连不上 api.indexnow.org：' + ((e && e.message) || 'network') };
    }
  }

  if (want === 'all' || want === 'baidu') {
    if (!baiduNow) {
      out.results.baidu = { ok: false, status: 0, note: '没填百度准入密钥：后台「收录提交」里填，或配 Cloudflare 变量 BAIDU_TOKEN，二选一即可' };
    } else {
      try {
        const t1 = Date.now();
        const r = await fetch(
          'http://data.zz.baidu.com/urls?site=' +
            encodeURIComponent(String(root).replace(/^https?:\/\//i, '').replace(/\/.*$/, '')) +
            '&token=' +
            encodeURIComponent(baiduNow),
          { method: 'POST', headers: { 'content-type': 'text/plain' }, body: urls.join(String.fromCharCode(10)) }
        );
        const t = await r.text();
        let note = String(t || '').slice(0, 300);
        let good = r.ok;
        try {
          const j = JSON.parse(t);
          if (j && typeof j === 'object') {
            if (j.error) {
              good = false;
              note = '百度返回错误码 ' + j.error + (j.message ? '：' + j.message : '');
            } else if (typeof j.success === 'number') {
              good = true;
              note = '收下 ' + j.success + ' 条，剩余配额 ' + (j.remain == null ? '未知' : j.remain) + ' 条';
            }
          }
        } catch (e) {
          /* 不是 JSON，就原样展示 */
        }
        if (r.status === 526) note = '526 是 Cloudflare 报的「源站证书无效」—— 百度 https 端点握手失败，不是站点没验证；本版已改成走 http 端点（百度自己的文档也用 http）';
        if (String(t||'').indexOf('success') >= 0) note = note + '｜百度已收下：' + String(t||'').slice(0,120);
        if (!good && /^\\s*</.test(String(t || ''))) note = '百度返回的是网页错误页（不是接口 JSON），多半是 token 与站点不匹配或接口被拦，见下面的原始返回';
        out.results.baidu = { ok: good, status: r.status, ms: Date.now() - t1, note: note + engineHint('baidu', r.status), raw: String(t || '').slice(0, 300) };
      } catch (e) {
        out.results.baidu = { ok: false, status: 0, note: '连不上百度推送接口：' + ((e && e.message) || 'network') };
      }
    }
  }

  out.at = new Date().toISOString();
  out.sig = sigNow;
  if (!out.at) out.at = new Date().toISOString();
  await saveLastSubmit(out);
  return json(out);
}

// 最近一次提交结果（存边缘缓存 7 天，后台打开时直接看）
function lastSubmitKey() {
  return EDGE_KEY_BASE + '/__last_submit';
}
async function readLastSubmit() {
  try {
    const hit = await EDGE_CACHE.match(lastSubmitKey());
    if (!hit) return null;
    return await hit.json();
  } catch (e) {
    return null;
  }
}
async function saveLastSubmit(out) {
  try {
    await EDGE_CACHE.put(lastSubmitKey(), new Response(JSON.stringify(out), { headers: { 'cache-control': 'max-age=604800' } }));
  } catch (e) {
    /* 记录失败不影响提交结果 */
  }
}

const SITE_FILE = 'data/site.json';
const AD_HTML_MAX = 20000;
// 广告位：id 是前端约定的槽位名，name/where 只用于后台展示
const AD_EVERY_MAX = 50;
const AD_SLOTS = [
  { id: 'home-top', kind: 'fixed', name: '首页顶部横幅', where: '页头下面、统计卡上面，通栏' },
  { id: 'list-top', kind: 'fixed', name: '榜单上方', where: '搜索筛选栏下面、榜单开始之前' },
  { id: 'list-bottom', kind: 'fixed', name: '榜单下方', where: '分页器下面、文章区之前' },
  { id: 'sidebar', kind: 'fixed', name: '侧栏底部', where: '右侧栏最底部；侧栏下沉时跟着走' },
  { id: 'article', kind: 'fixed', name: '文章区上方', where: '首页文章列表上方（文章详情页顶部也用它）' },
  { id: 'article-side', kind: 'fixed', name: '文章页侧栏', where: '文章页右侧栏里（侧栏卡片下方）；文章页不留侧栏时不显示' },
  { id: 'article-after', kind: 'fixed', name: '文章正文之后', where: '每篇文章读完的地方（正文结束、上一篇/下一篇之前）' },
  { id: 'list-inline', kind: 'inline', every: 10, name: '榜单信息流', where: '榜单列表里插在项目之间，分页器不受影响' },
  { id: 'article-inline', kind: 'inline', every: 2, name: '文章信息流', where: '首页文章列表里插在篇目之间' },
  { id: 'nav-inline', kind: 'inline', every: 8, name: '导航信息流', where: '导航页每个分组里插在站点之间' },
];

function emptyAdSlots() {
  const o = {};
  for (const s of AD_SLOTS) {
    o[s.id] = { enabled: false, html: '', every: s.every || 0, link: '', modal: '' };
  }
  return o;
}

// 后台「广告」页里每个位置的卡片（用字符串拼接，避免模板字面量嵌套）
function adCardHtml(s) {
  const everyInput = s.kind === 'inline'
    ? '每 <input type="number" class="every-input" aria-label="每隔几个内容插一条广告" min="1" max="' + AD_EVERY_MAX + '" value="' + (s.every || 1) +
      '" data-ad-slot="' + s.id + '" data-ad-field="every"> 个插一条'
    : '';
  return '<div class="card ad-card">' +
    '<div class="card-head"><div class="ad-title"><b>' + s.name + '</b><code class="slot-id">' + s.id + '</code></div>' +
    '<label class="toggle"><input type="checkbox" data-ad-slot="' + s.id + '" data-ad-field="enabled">在这里显示</label></div>' +
    '<div class="hint">' + s.where + (everyInput ? ' · ' + everyInput : '') + '</div>' +
    '<textarea class="code ad-code" data-ad-slot="' + s.id + '" data-ad-field="html" maxlength="20000" spellcheck="false" placeholder="粘贴广告 HTML 片段…"></textarea>' +
    '<div class="ad-click"><span class="ad-click-t">点击行为</span>' +
    '<input type="url" data-ad-slot="' + s.id + '" data-ad-field="link" placeholder="跳转链接（可选，新窗口打开）">' +
    '<textarea class="code" rows="2" maxlength="20000" data-ad-slot="' + s.id + '" data-ad-field="modal" placeholder="或：弹窗内容 HTML（填了就点开弹窗，优先于链接）"></textarea>' +
    '<div class="ad-acts"><button type="button" class="ghost small" data-adprev="' + s.id + '">预览</button>' +
    '<span class="ad-acts-t">按现在填的内容渲染一张，点开看效果</span></div>' +
    '</div></div>';
}

function defaultSite() {
  return {
    ad: {
      enabled: false,
      html: '',
      slots: emptyAdSlots(),
      ticker: { enabled: false, text: '', speed: 18, link: '', modal: '' },
      article: { unlockHint: '' },
    },
    article: {
      unlockHint: '',
      catEn: false,
      cols: 'double',
      categories: [
        { key: 'tech', name: '技术', desc: '开发、部署、性能' },
        { key: 'note', name: '随笔', desc: '零散记录' },
      ],
    },
    theme: { name: 'paper', allowUser: true },
    layout: { mode: 'auto', side: 'right', users: 'auto', articleSide: 'right' },
    contact: { enabled: false, title: '联系我', wechat: '', qrUrl: '', email: '', note: '' },
    beian: { enabled: false, icp: '', icpUrl: 'https://beian.miit.gov.cn/', police: '', policeUrl: '', text: '' },
    seo: { siteName: '', title: '', description: '', keywords: '', ogImage: '', siteUrl: '' },
    geo: { summary: '', faq: [{ q: '', a: '' }] },
    // 翻译的运行设置：后台「翻译与密钥」页可直接改，不用去 Cloudflare 配变量
    runtime: { aiCap: null, emails: '', baiduToken: '', indexNowKey: '', verify: { bytedance: '', sogou: '', shenma: '' } },
  };
}

// 读出来的内容统一成标准结构，缺的字段用默认值补齐
function normalizeSite(o) {
  const d = defaultSite();
  const art = o && typeof o.article === 'object' && o.article ? o.article : {};
  d.article = {
    unlockHint: typeof art.unlockHint === 'string' ? art.unlockHint.slice(0, 300) : '',
    catEn: !!art.catEn,
    cols: ['auto', 'single', 'double', 'triple'].indexOf(art.cols) >= 0 ? art.cols : 'double',
  };
  const rawCats = o && o.article && Array.isArray(o.article.categories) ? o.article.categories : null;
  if (rawCats) {
    const seen = {};
    d.article.categories = [];
    for (const c of rawCats.slice(0, 30)) {
      if (!c || typeof c !== 'object') continue;
      const key = String(c.key || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
      if (!key || seen[key]) continue;
      seen[key] = 1;
      d.article.categories.push({
        key: key,
        name: (typeof c.name === 'string' ? c.name : '').trim().slice(0, 24) || key,
        desc: (typeof c.desc === 'string' ? c.desc : '').trim().slice(0, 80),
      });
    }
  } else {
    d.article.categories = defaultSite().article.categories.slice();
  }
  const th = o && typeof o.theme === 'object' && o.theme ? o.theme : {};
  d.theme = {
    name: THEME_NAMES.indexOf(String(th.name || '')) >= 0 ? String(th.name) : 'paper',
    allowUser: th.allowUser !== false,
  };
  const ad = o && typeof o.ad === 'object' && o.ad ? o.ad : {};
  const c = o && typeof o.contact === 'object' && o.contact ? o.contact : {};
  const str = (v, fb) => (typeof v === 'string' ? v : fb);
  d.ad.enabled = ad.enabled === true;
  d.ad.html = str(ad.html, '');
  const num = (v, fb, lo, hi) => {
    const n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const rawSlots = ad.slots && typeof ad.slots === 'object' ? ad.slots : null;
  if (rawSlots) {
    for (const s of AD_SLOTS) {
      const v = rawSlots[s.id];
      if (v && typeof v === 'object') {
        d.ad.slots[s.id] = {
          enabled: v.enabled === true,
          html: str(v.html, '').slice(0, AD_HTML_MAX),
          every: s.kind === 'inline' ? num(v.every, s.every, 1, AD_EVERY_MAX) : 0,
          link: str(v.link, '').slice(0, 500),
          modal: str(v.modal, '').slice(0, AD_HTML_MAX),
        };
      }
    }
  } else if (d.ad.enabled && d.ad.html.trim()) {
    // 老结构（只有 ad.enabled + ad.html）：当成「首页顶部横幅」，保证升级后原有广告继续显示
    d.ad.slots['home-top'] = { enabled: true, html: d.ad.html, every: 0, link: '', modal: '' };
  }
  const tk = ad.ticker && typeof ad.ticker === 'object' ? ad.ticker : {};
  d.ad.ticker = {
    enabled: tk.enabled === true,
    text: str(tk.text, '').slice(0, 200),
    speed: num(tk.speed, 18, 6, 60),
    link: str(tk.link, '').slice(0, 500),
    modal: str(tk.modal, '').slice(0, AD_HTML_MAX),
  };
  d.contact.enabled = c.enabled === true;
  d.contact.title = str(c.title, '联系我');
  d.contact.wechat = str(c.wechat, '');
  d.contact.qrUrl = str(c.qrUrl, '');
  d.contact.email = str(c.email, '');
  d.contact.note = str(c.note, '');
  const b = o && typeof o.beian === 'object' && o.beian ? o.beian : {};
  d.beian.enabled = b.enabled === true;
  d.beian.icp = str(b.icp, '');
  d.beian.icpUrl = str(b.icpUrl, 'https://beian.miit.gov.cn/');
  d.beian.police = str(b.police, '');
  d.beian.policeUrl = str(b.policeUrl, '');
  d.beian.text = str(b.text, '');
  const lo = o && typeof o.layout === 'object' && o.layout ? o.layout : {};
  d.layout.mode = ['auto', 'single', 'double', 'triple'].indexOf(lo.mode) >= 0 ? lo.mode : 'auto';
  d.layout.side = ['right', 'below'].indexOf(lo.side) >= 0 ? lo.side : 'right';
  d.layout.users = ['auto', 'single', 'double', 'triple'].indexOf(lo.users) >= 0 ? lo.users : 'auto';
  d.layout.articleSide = ['right', 'left', 'none'].indexOf(lo.articleSide) >= 0 ? lo.articleSide : 'right';
  const s = o && typeof o.seo === 'object' && o.seo ? o.seo : {};
  for (const k of Object.keys(d.seo)) d.seo[k] = str(s[k], '');
  const g = o && typeof o.geo === 'object' && o.geo ? o.geo : {};
  d.geo.summary = str(g.summary, '');
  if (Array.isArray(g.faq)) {
    d.geo.faq = g.faq
      .filter((f) => f && typeof f === 'object')
      .slice(0, 20)
      .map((f) => ({ q: str(f.q, ''), a: str(f.a, '') }));
  }
  const rt = o && typeof o.runtime === 'object' && o.runtime ? o.runtime : {};
  let cap = rt.aiCap;
  if (cap === '') cap = null;
  if (cap != null) {
    const num = Number(cap);
    cap = Number.isFinite(num) && num >= 0 ? Math.min(100000, Math.round(num)) : null;
  }
  d.runtime = {
    aiCap: cap,
    emails: typeof rt.emails === 'string' ? rt.emails.slice(0, 1000) : '',
    baiduToken: typeof rt.baiduToken === 'string' ? rt.baiduToken.trim().slice(0, 200) : '',
    indexNowKey: typeof rt.indexNowKey === 'string' ? rt.indexNowKey.trim().slice(0, 100) : '',
    verify: {
      bytedance: String((rt.verify || {}).bytedance || '').slice(0, 200),
      sogou: String((rt.verify || {}).sogou || '').slice(0, 200),
      shenma: String((rt.verify || {}).shenma || '').slice(0, 200),
    },
  };
  return d;
}

// 从仓库读 data/site.json：文件不存在或不合法都返回默认结构
async function readSite(env) {
  const miss = checkConfig(env);
  if (miss.length) return { ok: false, status: 500, error: '还没配置变量：' + miss.join('、') };
  const cur = await gh(env, '/contents/' + SITE_FILE + '?ref=' + encodeURIComponent(branch(env)));
  if (cur.status === 404) return { ok: true, site: defaultSite(), sha: null };
  if (!cur.ok || !cur.data) {
    return { ok: false, status: cur.status, error: '读取站点配置失败：' + cur.status + ' ' + cur.text.slice(0, 200) };
  }
  let site = defaultSite();
  try {
    const bin = atob(String(cur.data.content || '').replace(/\n/g, ''));
    const txt = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    if (txt.trim()) site = normalizeSite(JSON.parse(txt));
  } catch (e) {
    site = defaultSite();
  }
  return { ok: true, status: 200, site: site, sha: cur.data.sha || null };
}

// 校验一个 section 的提交内容，返回 { ok, error, clean }
function checkSection(section, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'value 必须是对象' };
  }
  if (section === 'article') {
    const hint = value && typeof value.unlockHint === 'string' ? value.unlockHint.trim() : '';
    if (hint.length > 300) return { ok: false, error: '默认密码提示最多 300 字' };
    const catsIn = value && Array.isArray(value.categories) ? value.categories : null;
    const cats = [];
    if (catsIn) {
      if (catsIn.length > 30) return { ok: false, error: '分类最多 30 个' };
      const seen = {};
      for (const c of catsIn) {
        if (!c || typeof c !== 'object') continue;
        const key = String(c.key || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
        if (!key) return { ok: false, error: '分类的英文词只能用小写字母、数字和连字符（如 tech）' };
        if (seen[key]) return { ok: false, error: '分类英文词重复：' + key };
        seen[key] = 1;
        const name = (typeof c.name === 'string' ? c.name : '').trim();
        if (!name) return { ok: false, error: '分类“' + key + '”要填显示名' };
        if (name.length > 24) return { ok: false, error: '分类显示名最多 24 字' };
        const desc = (typeof c.desc === 'string' ? c.desc : '').trim();
        if (desc.length > 80) return { ok: false, error: '分类说明最多 80 字' };
        cats.push({ key: key, name: name, desc: desc });
      }
    }
    var colsIn = value.cols === undefined ? 'double' : value.cols;
    if (['auto', 'single', 'double', 'triple'].indexOf(colsIn) < 0) {
      return { ok: false, error: '文章卡片列数只能是 auto、single、double 或 triple' };
    }
    return { ok: true, clean: { unlockHint: hint, catEn: !!value.catEn, cols: colsIn, categories: cats } };
  }
  if (section === 'theme') {
    const name = String((value && value.name) || '').trim();
    if (THEME_NAMES.indexOf(name) < 0) {
      return { ok: false, error: '主题只能是 ' + THEME_NAMES.join(' / ') };
    }
    return { ok: true, clean: { name: name, allowUser: value.allowUser !== false } };
  }
  if (section === 'ad') {
    // 结构：{ slots: { '<槽位>': { enabled, html, every, link, modal } }, ticker: {...} }；老结构 { enabled, html } 仍然接受
    const clean = { enabled: false, html: '', slots: emptyAdSlots(), ticker: { enabled: false, text: '', speed: 18, link: '', modal: '' } };
    const tkIn = value.ticker && typeof value.ticker === 'object' ? value.ticker : null;
    if (tkIn) {
      if (tkIn.enabled != null && typeof tkIn.enabled !== 'boolean') return { ok: false, error: '顶部滚动条的开关必须是 true 或 false' };
      const text = tkIn.text == null ? '' : tkIn.text;
      if (typeof text !== 'string') return { ok: false, error: '滚动文字必须是文字' };
      if (text.length > 200) return { ok: false, error: '滚动文字不能超过 200 个字符' };
      const speed = tkIn.speed == null ? 18 : Number(tkIn.speed);
      if (!isFinite(speed) || speed < 6 || speed > 60) return { ok: false, error: '滚动速度要在 6 到 60 秒之间' };
      const link = tkIn.link == null ? '' : String(tkIn.link).trim();
      if (link && !/^https?:\/\//i.test(link)) return { ok: false, error: '滚动条的跳转链接必须是 http(s) 地址' };
      const modal = tkIn.modal == null ? '' : tkIn.modal;
      if (typeof modal !== 'string') return { ok: false, error: '滚动条的弹窗内容必须是文字' };
      if (modal.length > AD_HTML_MAX) return { ok: false, error: '滚动条的弹窗内容不能超过 ' + AD_HTML_MAX + ' 个字符' };
      if (tkIn.enabled === true && !text.trim() && !modal.trim()) {
        return { ok: false, error: '开启顶部滚动条要至少填一句滚动的文字' };
      }
      clean.ticker = { enabled: tkIn.enabled === true, text: text, speed: Math.round(speed), link: link, modal: modal };
    }
    if (value.slots && typeof value.slots === 'object' && !Array.isArray(value.slots)) {
      for (const key of Object.keys(value.slots)) {
        const meta = AD_SLOTS.find((s) => s.id === key);
        if (!meta) {
          return { ok: false, error: '不认识的广告位：' + key + '（可选：' + AD_SLOTS.map((s) => s.id).join('、') + '）' };
        }
        const v = value.slots[key] || {};
        if (typeof v.enabled !== 'boolean') return { ok: false, error: '广告位「' + key + '」的开关必须是 true 或 false' };
        const html = v.html == null ? '' : v.html;
        if (typeof html !== 'string') return { ok: false, error: '广告位「' + key + '」的代码必须是文字' };
        if (html.length > AD_HTML_MAX) return { ok: false, error: '广告位「' + key + '」的代码不能超过 ' + AD_HTML_MAX + ' 个字符' };
        let every = 0;
        if (meta.kind === 'inline') {
          every = v.every == null ? meta.every : Number(v.every);
          if (!isFinite(every) || every < 1 || every > AD_EVERY_MAX) {
            return { ok: false, error: '广告位「' + key + '」的间隔要是 1 到 ' + AD_EVERY_MAX + ' 之间的整数' };
          }
          every = Math.round(every);
        }
        const link = v.link == null ? '' : String(v.link).trim();
        if (link && !/^https?:\/\//i.test(link)) return { ok: false, error: '广告位「' + key + '」的跳转链接必须是 http(s) 地址' };
        const modal = v.modal == null ? '' : v.modal;
        if (typeof modal !== 'string') return { ok: false, error: '广告位「' + key + '」的弹窗内容必须是文字' };
        if (modal.length > AD_HTML_MAX) return { ok: false, error: '广告位「' + key + '」的弹窗内容不能超过 ' + AD_HTML_MAX + ' 个字符' };
        clean.slots[key] = { enabled: v.enabled, html: html, every: every, link: link, modal: modal };
      }
      // 老字段跟着「首页顶部横幅」走，保持向后兼容
      clean.enabled = clean.slots['home-top'] ? clean.slots['home-top'].enabled : false;
      clean.html = clean.slots['home-top'] ? clean.slots['home-top'].html : '';
      return { ok: true, clean: clean };
    }
    if (typeof value.enabled !== 'boolean') return { ok: false, error: '广告开关必须是 true 或 false' };
    const html = value.html == null ? '' : value.html;
    if (typeof html !== 'string') return { ok: false, error: '广告代码必须是文字' };
    if (html.length > AD_HTML_MAX) return { ok: false, error: '广告代码不能超过 ' + AD_HTML_MAX + ' 个字符' };
    clean.enabled = value.enabled;
    clean.html = html;
    clean.slots['home-top'] = { enabled: value.enabled, html: html, every: 0, link: '', modal: '' };
    return { ok: true, clean: clean };
  }
  if (section === 'layout') {
    const mode = value.mode == null ? '' : value.mode;
    if (['auto', 'single', 'double', 'triple'].indexOf(mode) < 0) {
      return { ok: false, error: '榜单列数只能是 auto、single、double 或 triple' };
    }
    const side = value.side == null ? 'right' : value.side;
    if (['right', 'below'].indexOf(side) < 0) return { ok: false, error: '侧栏位置只能是 right 或 below' };
    const users = value.users == null ? 'auto' : value.users;
    if (['auto', 'single', 'double', 'triple'].indexOf(users) < 0) return { ok: false, error: '开发者/组织榜列数只能是 auto、single、double 或 triple' };
    const artSide = value.articleSide == null ? 'right' : value.articleSide;
    if (['right', 'left', 'none'].indexOf(artSide) < 0) return { ok: false, error: '文章页侧栏只能是 right、left 或 none' };
    return { ok: true, clean: { mode: mode, side: side, users: users, articleSide: artSide } };
  }
  if (section === 'contact') {
    if (typeof value.enabled !== 'boolean') return { ok: false, error: '联系方式开关必须是 true 或 false' };
    const limits = { title: 20, wechat: 60, qrUrl: 300, email: 120, note: 200 };
    const clean = { enabled: value.enabled };
    for (const k of Object.keys(limits)) {
      const v = value[k] == null ? '' : value[k];
      if (typeof v !== 'string') return { ok: false, error: '联系方式的「' + k + '」必须是文字' };
      const t = v.trim();
      if (t.length > limits[k]) return { ok: false, error: '联系方式的「' + k + '」不能超过 ' + limits[k] + ' 个字符' };
      clean[k] = t;
    }
    if (clean.qrUrl && !clean.qrUrl.startsWith('https://')) {
      return { ok: false, error: '二维码图片地址必须以 https:// 开头，或留空' };
    }
    return { ok: true, clean: clean };
  }
  if (section === 'beian') {
    if (typeof value.enabled !== 'boolean') return { ok: false, error: '备案开关必须是 true 或 false' };
    const limits = { icp: 60, icpUrl: 300, police: 60, policeUrl: 300, text: 200 };
    const clean = { enabled: value.enabled };
    for (const k of Object.keys(limits)) {
      const v = value[k] == null ? '' : value[k];
      if (typeof v !== 'string') return { ok: false, error: '备案信息的「' + k + '」必须是文字' };
      const t = v.trim();
      if (t.length > limits[k]) return { ok: false, error: '备案信息的「' + k + '」不能超过 ' + limits[k] + ' 个字符' };
      if ((k === 'icpUrl' || k === 'policeUrl') && t && !/^https?:\/\//i.test(t)) {
        return { ok: false, error: '备案链接必须以 http:// 或 https:// 开头，或留空' };
      }
      clean[k] = t;
    }
    return { ok: true, clean: clean };
  }
  if (section === 'seo') {
    const limits = { siteName: 60, title: 100, description: 300, keywords: 300, ogImage: 300, siteUrl: 300 };
    const urlKeys = ['ogImage', 'siteUrl'];
    const clean = {};
    for (const k of Object.keys(limits)) {
      const v = value[k] == null ? '' : value[k];
      if (typeof v !== 'string') return { ok: false, error: 'SEO 的「' + k + '」必须是文字' };
      const t = v.trim();
      if (t.length > limits[k]) return { ok: false, error: 'SEO 的「' + k + '」不能超过 ' + limits[k] + ' 个字符' };
      if (urlKeys.indexOf(k) >= 0 && t && !/^https?:\/\//i.test(t)) {
        return { ok: false, error: 'SEO 的「' + k + '」必须以 http:// 或 https:// 开头，或留空' };
      }
      clean[k] = t;
    }
    return { ok: true, clean: clean };
  }
  if (section === 'geo') {
    const summary = value.summary == null ? '' : value.summary;
    if (typeof summary !== 'string') return { ok: false, error: 'GEO 摘要必须是文字' };
    if (summary.trim().length > 500) return { ok: false, error: 'GEO 摘要不能超过 500 个字符' };
    const faqIn = value.faq == null ? [] : value.faq;
    if (!Array.isArray(faqIn)) return { ok: false, error: 'GEO 问答必须是列表' };
    if (faqIn.length > 20) return { ok: false, error: 'GEO 问答最多 20 条' };
    const faq = [];
    for (const f of faqIn) {
      const q = f && f.q == null ? '' : f && f.q;
      const a = f && f.a == null ? '' : f && f.a;
      if (typeof q !== 'string' || typeof a !== 'string') return { ok: false, error: 'GEO 问答的问题和回答必须是文字' };
      if (q.trim().length > 100) return { ok: false, error: 'GEO 问题不能超过 100 个字符' };
      if (a.trim().length > 500) return { ok: false, error: 'GEO 回答不能超过 500 个字符' };
      if (q.trim() || a.trim()) faq.push({ q: q.trim(), a: a.trim() });
    }
    return { ok: true, clean: { summary: summary.trim(), faq: faq } };
  }
  if (section === 'runtime') {
    const emailsRaw = value.emails == null ? '' : value.emails;
    if (typeof emailsRaw !== 'string') return { ok: false, error: '翻译邮箱必须是文字' };
    if (emailsRaw.length > 1000) return { ok: false, error: '翻译邮箱那一栏最多 1000 个字符' };
    const list = emailsRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (list.length > 20) return { ok: false, error: '翻译邮箱最多填 20 个' };
    for (const e of list) {
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) return { ok: false, error: '不是邮箱格式：' + e };
    }
    const capRaw = value.aiCap == null || value.aiCap === '' ? null : Number(value.aiCap);
    if (capRaw != null && (!Number.isFinite(capRaw) || capRaw < 0 || capRaw > 100000)) {
      return { ok: false, error: 'Workers AI 每日上限要填 0 到 100000 之间的整数（0 = 不限制）' };
    }
    const baiduTok = value.baiduToken == null ? '' : String(value.baiduToken).trim();
    if (baiduTok.length > 200) return { ok: false, error: '百度准入密钥太长（最多 200 个字符）' };
    if (baiduTok && !/^[A-Za-z0-9_-]+$/.test(baiduTok)) return { ok: false, error: '百度准入密钥只能是字母、数字、下划线或短横线' };
    const inkRaw = value.indexNowKey == null ? '' : String(value.indexNowKey).trim();
    if (inkRaw.length > 100) return { ok: false, error: 'IndexNow Key 太长（最多 100 个字符）' };
    if (inkRaw && !/^[A-Za-z0-9-]+$/.test(inkRaw)) return { ok: false, error: 'IndexNow Key 只能是字母、数字或短横线（8–128 位建议）' };
    const vfRaw = value.verify && typeof value.verify === 'object' ? value.verify : {};
    const vf = {};
    for (const vk of ['bytedance', 'sogou', 'shenma']) {
      const vv = vfRaw[vk] == null ? '' : String(vfRaw[vk]).trim();
      if (vv.length > 200) return { ok: false, error: '平台验证码太长了（每个最多 200 个字符）' };
      vf[vk] = vv;
    }
    return {
      ok: true,
      clean: {
        emails: list.join(','),
        aiCap: capRaw == null ? null : Math.round(capRaw),
        baiduToken: baiduTok,
        verify: vf,
        indexNowKey: inkRaw,
      },
    };
  }
  return { ok: false, error: 'section 只能是 ad、layout、contact、beian、seo、geo 或 runtime' };
  }

// 把整体结构写回 data/site.json（带上当前 sha）
async function writeSite(env, site, sha) {
  const body = {
    message: 'chore: update site config',
    content: utf8ToBase64(JSON.stringify(site, null, 2) + '\n'),
    branch: branch(env),
  };
  if (sha) body.sha = sha;
  const put = await gh(env, '/contents/' + SITE_FILE, {
    method: 'PUT',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!put.ok) return { ok: false, error: '写入失败：' + put.status + ' ' + put.text.slice(0, 200) };
  return { ok: true };
}

// 翻译与密钥：GET 返回链路状态（只回布尔值）；POST 用一段文字实测两条链路（要管理密码）
  async function handleTranslate(request, env) {
    const rt = await siteRuntime(env);
    const status = translatorStatus(env, rt);
    if (request.method === 'GET') {
      return json({ ok: true, status: status, ghConfigured: status.githubToken });
    }
    if (!env.ADMIN_PASSWORD) {
      return json({ ok: false, error: '没有设置 ADMIN_PASSWORD，后台已关闭' }, 403);
    }
    const body = await request.json().catch(() => ({}));
    const pw = body.password == null ? '' : String(body.password);
    if (!safeEqual(pw, env.ADMIN_PASSWORD)) {
      return json({ ok: false, error: '密码不对' }, 403);
    }
    const text = ((body.text == null ? '' : String(body.text)).trim() || 'A fast, static GitHub trending board built on Cloudflare Workers.').slice(0, 400);
    const out = { ok: true, text: text, status: status };
    const cached = await readTranslation(text);
    if (cached) {
      out.cached = true;
      out.myMemory = { ok: true, text: cached, ms: 0, error: null, fromCache: true };
      out.ai = { ok: false, text: '', ms: 0, error: '没试：命中译文缓存，没有产生调用' };
      out.effective = 'cache';
      return json(out);
    }
    out.cached = false;
    const t0 = Date.now();
    const mm = await translateMM(text, env, rt);
    out.myMemory = { ok: mm.ok === true, text: mm.text || '', ms: Date.now() - t0, error: mm.ok ? null : String(mm.error || 'unknown') };
    if (env.AI) {
      const t1 = Date.now();
      const ai = await translateAI(text, env, rt);
      out.ai = { ok: ai.ok === true, text: ai.text || '', ms: Date.now() - t1, error: ai.ok ? null : String(ai.error || 'unknown') };
    } else {
      out.ai = { ok: false, text: '', ms: 0, error: 'not-bound: 没有绑定 Workers AI（变量名必须是 AI）' };
    }
    if (out.myMemory.ok && out.myMemory.text) {
      await saveTranslation(text, out.myMemory.text);
      out.effective = 'myMemory';
    } else if (out.ai.ok && out.ai.text) {
      await saveTranslation(text, out.ai.text);
      out.effective = 'ai';
    } else {
      out.effective = 'none';
    }
    return json(out);
  }


async function handleSite(request, env) {
  if (request.method === 'GET') {
    const r = await readSite(env);
    if (!r.ok) return json({ ok: false, error: r.error }, 502);
    return json({ ok: true, site: r.site });
  }

  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '没有设置 ADMIN_PASSWORD，后台已关闭' }, 403);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: '请求体必须是 JSON 对象' }, 400);
  }
  if (!safeEqual(body.password == null ? '' : body.password, env.ADMIN_PASSWORD)) {
    return json({ ok: false, error: '密码不对' }, 403);
  }
  if (SITE_SECTIONS.indexOf(body.section) < 0) {
    return json({ ok: false, error: 'section 只能是 ad、layout、contact、beian、seo、geo 或 runtime' }, 400);
  }
  const check = checkSection(body.section, body.value);
  if (!check.ok) return json({ ok: false, error: check.error }, 400);

  const cur = await readSite(env);
  if (!cur.ok) return json({ ok: false, error: cur.error }, 502);
  const site = cur.site;
  site[body.section] = check.clean;

  const w = await writeSite(env, site, cur.sha);
  if (!w.ok) return json({ ok: false, error: w.error }, 500);
  await purgeEdge(['/', '/index.html', '/data/site.json']);
  await warmEdge('/data/site.json', JSON.stringify(site, null, 2) + '\n', 'application/json; charset=utf-8');
  // 运行设置（翻译邮箱 / AI 上限）另有 60 秒缓存，保存后立刻失效，免得要等一分钟
  try {
    await EDGE_CACHE.delete(EDGE_KEY_BASE + '/__runtime');
  } catch (e) {
    /* 清缓存失败不影响保存 */
  }
  return json({ ok: true, site: site });
}

// ---- 文章（GEO 内容）：数据存在仓库 data/articles.json ----
const ARTICLES_FILE = 'data/articles.json';
const ARTICLES_MAX = 200;
const ART_LIMITS = { title: 100, summary: 300, body: 20000 };

function todayBJ() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// 给没有 slug 的文章补「分类词/序号」，并保证同批不重名
function fillArticleSlugs(articles) {
  var catMax = {};
    articles.forEach(function (a) {
      if (!a || !a.slug) return;
      var parts = String(a.slug).split('/');
      if (parts.length === 2) {
        var num = parseInt(parts[1], 10);
        if (num > (catMax[parts[0]] || 0)) catMax[parts[0]] = num;
      }
    });
    var ordered = articles.slice().sort(function (a, b) {
      return String((a && a.date) || '').localeCompare(String((b && b.date) || ''));
    });
    var usedSlug = {};
    ordered.forEach(function (a) {
      if (!a) return;
      if (!a.slug) {
        var k = catKeyOf(a.category);
        catMax[k] = (catMax[k] || 0) + 1;
        a.slug = k + '/' + catMax[k];
      }
      if (usedSlug[a.slug]) a.slug = a.slug + '-' + (usedSlug[a.slug] + 1);
      usedSlug[a.slug] = (usedSlug[a.slug] || 0) + 1;
    });
}

// 从仓库读 data/articles.json：文件不存在视为 []
async function readArticles(env) {
  const miss = checkConfig(env);
  if (miss.length) return { ok: false, status: 500, error: '还没配置变量：' + miss.join('、') };
  const cur = await gh(env, '/contents/' + ARTICLES_FILE + '?ref=' + encodeURIComponent(branch(env)));
  if (cur.status === 404) return { ok: true, status: 404, articles: [], sha: null };
  if (!cur.ok || !cur.data) {
    return { ok: false, status: cur.status, error: '读取文章失败：' + cur.status + ' ' + cur.text.slice(0, 200) };
  }
  let articles = [];
  try {
    const bin = atob(String(cur.data.content || '').replace(/\n/g, ''));
    const txt = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    if (txt.trim()) {
      const parsed = JSON.parse(txt);
      if (!Array.isArray(parsed)) throw new Error('not array');
      articles = parsed;
    }
  } catch (e) {
    return { ok: false, status: 500, error: 'data/articles.json 不是合法的 JSON 数组，请先在仓库里修正' };
  }
  fillArticleSlugs(articles);
  return { ok: true, status: 200, articles: articles, sha: cur.data.sha || null };
}

// 把文章数组写回 data/articles.json（带上当前 sha）
async function writeArticles(env, articles, sha, msg) {
  const body = {
    message: msg,
    content: utf8ToBase64(JSON.stringify(articles, null, 2) + '\n'),
    branch: branch(env),
  };
  if (sha) body.sha = sha;
  const put = await gh(env, '/contents/' + ARTICLES_FILE, {
    method: 'PUT',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!put.ok) return { ok: false, error: '写入失败：' + put.status + ' ' + put.text.slice(0, 200) };
  return { ok: true };
}

const ART_PBKDF2_ITER = 100000;

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(str) {
  const bin = atob(String(str || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function artKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: iter || ART_PBKDF2_ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// 把明文正文加密成 { v, salt, iv, ct }（都 base64）
async function encryptBody(text, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await artKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(text));
  return { v: 1, iter: ART_PBKDF2_ITER, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

// 解密；密码不对返回 null
async function decryptBody(lock, password) {
  try {
    if (!lock || !lock.ct || !lock.salt || !lock.iv) return null;
    const key = await artKey(password, fromB64(lock.salt), lock.iter);
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(lock.iv) }, key, fromB64(lock.ct));
    return new TextDecoder().decode(out);
  } catch (e) {
    return null;
  }
}

// 给前端看的公开版本：去掉 lock 细节，只留 locked 标记
function publicArticle(a) {
  const out = {};
  for (const k of Object.keys(a || {})) {
    if (k === 'lock' || k === 'prevSlugs') continue;
    out[k] = a[k];
  }
  out.locked = !!a.locked;
  // 一律带上 hasLock：前端据此判断"标了加密但解不开"的旧数据，不必自己猜
  out.hasLock = !!(a.lock && a.lock.ct);
  // 改过几次链接：后台据此提示「旧地址 N 个（已 301）」，只给数量不暴露具体地址
  out.prevCount = Array.isArray(a.prevSlugs) ? a.prevSlugs.length : 0;
  return out;
}

// 生成可读 slug：小写、非字母数字折成连字符；纯中文标题会得到空串，由调用方兜底
function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// 分类词：中文分类转写不出英文时统一用 cat；序号按该分类自增
function catKeyOf(cat) {
  // 链接里只用英文：中文分类转写不出字母时退回 cat；前端展示仍用原文分类（可切换成英文）
  var s2 = slugify(cat || '').slice(0, 24);
  return s2 || 'cat';
}
// 后台分类表：分类名或英文词 -> 英文 key（都匹配不上就退回 slugify）
function catKeyFrom(site, raw) {
  const cats = site && site.article && Array.isArray(site.article.categories) ? site.article.categories : [];
  const s0 = String(raw || '').trim();
  if (s0) {
    for (const c of cats) {
      if (c && (c.key === s0.toLowerCase() || c.name === s0)) return c.key;
    }
  }
  return catKeyOf(s0);
}
function nextSeqOf(list, catKey) {
  var max = 0;
  (list || []).forEach(function (x) {
    if (!x || !x.slug) return;
    var p2 = String(x.slug).split('/');
    if (p2.length === 2 && p2[0] === catKey) {
      var n = parseInt(p2[1], 10);
      if (n > max) max = n;
    }
  });
  return max + 1;
}

// 校验一篇文章：title / summary / body 为文字，date 为 YYYY-MM-DD（缺省为今天）
function checkArticle(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: '文章内容必须是对象' };
  const clean = {};
  const rawSlug = typeof v.slug === 'string' ? v.slug.trim().toLowerCase() : '';
  if (rawSlug) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,23}(\/[\p{L}\p{N}][\p{L}\p{N}_-]{0,29})?$/u.test(rawSlug)) {
      return { ok: false, error: '链接格式是 分类词/序号（如 tech/3），不要用空格和 # ? & % 这些符号' };
    }
    clean.slug = rawSlug;
  }
  if (v.unlockHint != null) {
    const hint = typeof v.unlockHint === 'string' ? v.unlockHint.trim() : '';
    if (hint.length > 300) return { ok: false, error: '获取密码的提示最多 300 字' };
    clean.unlockHint = hint;
  }
  for (const k of ['title', 'summary', 'body']) {
    const s = v[k] == null ? '' : v[k];
    if (typeof s !== 'string') return { ok: false, error: '文章的「' + k + '」必须是文字' };
    const t = s.replace(/\r\n/g, '\n').trim();
    if (t.length > ART_LIMITS[k]) return { ok: false, error: '文章的「' + k + '」不能超过 ' + ART_LIMITS[k] + ' 个字符' };
    clean[k] = t;
  }
  if (!clean.title) return { ok: false, error: '文章标题不能为空' };
  const cat = v.category == null ? '' : String(v.category).trim();
  if (cat.length > 24) return { ok: false, error: '分类最多 24 个字符' };
  clean.category = cat;
  const cover = v.cover == null ? '' : String(v.cover).trim();
  if (cover && (!/^https?:\/\//i.test(cover) || cover.length > 300)) {
    return { ok: false, error: '封面图地址必须是 http(s) 链接，且不超过 300 字符' };
  }
  clean.cover = cover;
  // 置顶：首页/文章页把置顶的排在最前（同一天多篇时也算数）
  clean.pinned = v.pinned === true;
  let tags = v.tags;
  if (typeof tags === 'string') tags = tags.split(/[,\s，、]+/);
  if (!Array.isArray(tags)) tags = [];
  tags = tags.map((t) => String(t == null ? '' : t).trim()).filter(Boolean);
  if (tags.length > 6) return { ok: false, error: '标签最多 6 个' };
  for (const t of tags) if (t.length > 20) return { ok: false, error: '单个标签最多 20 个字符' };
  clean.tags = tags;
  clean.locked = v.locked === true;
  const pwd = v.password == null ? '' : String(v.password);
  if (pwd.length > 100) return { ok: false, error: '文章密码最多 100 个字符' };
  clean.password = pwd;
  const date = v.date == null || v.date === '' ? todayBJ() : String(v.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  clean.date = date;
  return { ok: true, clean: clean };
}

// GET 读取；POST 体 { password, action: add|update|remove, id, article }
async function handleArticles(request, env) {
  if (request.method === 'GET') {
    const r = await readArticles(env);
    if (!r.ok) return json({ ok: false, error: r.error }, 502);
    return json({ ok: true, articles: r.articles.map(publicArticle) });
  }

  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '没有设置 ADMIN_PASSWORD，后台已关闭' }, 403);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: '请求体必须是 JSON 对象' }, 400);
  }
  if (!safeEqual(body.password == null ? '' : body.password, env.ADMIN_PASSWORD)) {
    return json({ ok: false, error: '密码不对' }, 403);
  }
  if (body.action !== 'add' && body.action !== 'update' && body.action !== 'remove' && body.action !== 'bulk' && body.action !== 'replace') {
    return json({ ok: false, error: 'action 只能是 add、update、remove、bulk 或 replace' }, 400);
  }

  const cur = await readArticles(env);
  if (!cur.ok) return json({ ok: false, error: cur.error }, 502);
  const list = cur.articles;

  if (body.action === 'replace') {
    if (!Array.isArray(body.articles)) return json({ ok: false, error: 'articles 必须是数组' }, 400);
    if (body.articles.length > ARTICLES_MAX) return json({ ok: false, error: '文章太多（最多 ' + ARTICLES_MAX + ' 篇）' }, 400);
    const next = body.articles
      .filter((a) => a && typeof a === 'object' && String(a.id || '').length)
      .map((a) => Object.assign({}, a, { id: String(a.id) }));
    const w = await writeArticles(env, next, cur.sha, 'chore: 撤销一次批量操作');
    if (!w.ok) return json({ ok: false, error: w.error }, 500);
    await purgeEdge(['/articles', '/articles.html', '/data/articles.json', '/sitemap.xml']);
    await warmEdge('/data/articles.json', publicArticlesJson(next), 'application/json; charset=utf-8');
    return json({ ok: true, articles: next.map(publicArticle) });
  }

  if (body.action === 'bulk') {
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)) : [];
    if (!ids.length) return json({ ok: false, error: '没有选中文章' }, 400);
    if (ids.length > 200) return json({ ok: false, error: '一次最多批量处理 200 篇' }, 400);
    const set = new Set(ids);
    const op = body.op === 'category' ? 'category' : 'remove';
    const cat = typeof body.category === 'string' ? body.category.trim().slice(0, 24) : '';
    if (op === 'category' && !cat) return json({ ok: false, error: '改分类要填分类名' }, 400);
    let removed = 0;
    let changed = 0;
    const next = [];
    const siteForBulk = await readSite(env).then((x) => x.site).catch(() => null);
    for (const a of list) {
      if (a && set.has(String(a.id))) {
        if (op === 'remove') { removed += 1; continue; }
        a.category = cat;
        changed += 1;
        // 链接里的分类词跟着分类走：tech/3 → note/3（序号能留就留），旧地址记账后 301
        const ck = catKeyFrom(siteForBulk, cat);
        const segs = String(a.slug || '').split('/');
        const keepSeq = segs.length === 2 && /^\d+$/.test(segs[1]) ? segs[1] : String(nextSeqOf(list, ck));
        let want = ck + '/' + keepSeq;
        let bump = 2;
        while (list.concat(next).some((x) => x && x !== a && x.slug === want)) want = ck + '/' + keepSeq + '-' + bump++;
        if (a.slug && a.slug !== want) {
          a.prevSlugs = [a.slug].concat((Array.isArray(a.prevSlugs) ? a.prevSlugs : []).filter((x) => x && x !== a.slug && x !== want)).slice(0, 5);
          a.slug = want;
        }
      }
      next.push(a);
    }
    const msg = 'chore: 批量' + (op === 'remove' ? '删除 ' + removed + ' 篇' : '把 ' + changed + ' 篇改成分类「' + cat + '」');
    const w = await writeArticles(env, next, cur.sha, msg);
    if (!w.ok) return json({ ok: false, error: w.error }, 500);
    await purgeEdge(['/articles', '/articles.html', '/data/articles.json', '/sitemap.xml']);
    await warmEdge('/data/articles.json', publicArticlesJson(next), 'application/json; charset=utf-8');
    return json({ ok: true, removed: removed, changed: changed, articles: next.map(publicArticle) });
  }

  if (body.action === 'add') {
    const c = checkArticle(body.article);
    if (!c.ok) return json({ ok: false, error: c.error }, 400);
    const pwd = c.clean.password;
    delete c.clean.password;
    if (c.clean.locked) {
      if (!pwd) return json({ ok: false, error: '加密文章要设置访问密码' }, 400);
      if (pwd.length < 4) return json({ ok: false, error: '访问密码至少 4 位' }, 400);
      c.clean.lock = await encryptBody(c.clean.body || '', pwd);
      c.clean.body = '';
    }
    if (list.length >= ARTICLES_MAX) return json({ ok: false, error: '文章最多 ' + ARTICLES_MAX + ' 篇，请先删除旧文章' }, 400);
    let id = String(Date.now());
    while (list.some((a) => a && String(a.id) === id)) id = String(Number(id) + 1);
    var catKeyNew = catKeyFrom(await readSite(env).then((x) => x.site).catch(() => null), c.clean.category);
    var baseSlug = c.clean.slug || catKeyNew + '/' + nextSeqOf(list, catKeyNew);
    var finalSlug = baseSlug;
    var dup = 2;
    while (list.some(function (x) { return x && x.slug === finalSlug; })) finalSlug = baseSlug + '-' + dup++;
    c.clean.slug = finalSlug;
    list.push(Object.assign({ id: id }, c.clean));
  } else {
    const id = body.id == null ? '' : String(body.id);
    const idx = list.findIndex((a) => a && String(a.id) === id);
    if (idx < 0) return json({ ok: false, error: '没有找到这篇文章' }, 404);
    if (body.action === 'remove') {
      list.splice(idx, 1);
    } else {
      const c = checkArticle(body.article);
      if (!c.ok) return json({ ok: false, error: c.error }, 400);
      const pwd = c.clean.password;
      delete c.clean.password;
      const prev = list[idx] || {};
      if (c.clean.locked) {
        if (pwd) {
          if (pwd.length < 4) return json({ ok: false, error: '访问密码至少 4 位' }, 400);
          c.clean.lock = await encryptBody(c.clean.body || '', pwd);
          c.clean.body = '';
        } else if (prev.lock && prev.lock.ct) {
          c.clean.lock = prev.lock;
          c.clean.body = '';
        } else {
          return json({ ok: false, error: '加密文章要设置访问密码' }, 400);
        }
      }
      var catKeyUp = catKeyFrom(await readSite(env).then((x) => x.site).catch(() => null), c.clean.category || prev.category);
    var wantSlug = c.clean.slug || prev.slug || catKeyUp + '/' + nextSeqOf(list, catKeyUp);
      var finalSlug2 = wantSlug;
      var dup2 = 2;
      while (list.some(function (x) { return x && x.slug === finalSlug2 && String(x.id) !== String(id); })) finalSlug2 = wantSlug + '-' + dup2++;
      c.clean.slug = finalSlug2;
      // 链接变了就记下旧地址（最多 5 个），旧地址由 serveArticlePage 301 到新地址
      var carried = Array.isArray(prev.prevSlugs) ? prev.prevSlugs.slice(0, 5) : [];
      if (prev.slug && prev.slug !== finalSlug2) {
        carried = [prev.slug].concat(carried.filter(function (x) { return x && x !== prev.slug && x !== finalSlug2; })).slice(0, 5);
      }
      if (carried.length) c.clean.prevSlugs = carried;
      list[idx] = Object.assign({ id: id }, c.clean);
      // 改完立刻清掉旧/新两个文章页的成品缓存，别让访客看到 60 秒前的旧标题
      await purgeEdge([artPathOf(prev), artPathOf(list[idx])]);
    }
  }

  const w = await writeArticles(env, list, cur.sha, 'chore: update articles');
  if (!w.ok) return json({ ok: false, error: w.error }, 500);
  await purgeEdge(['/articles', '/articles.html', '/data/articles.json']);
  await warmEdge('/data/articles.json', publicArticlesJson(list), 'application/json; charset=utf-8');
  return json({ ok: true, articles: list.map(publicArticle) });
}

async function readCount(key) {
  try {
    const hit = await EDGE_CACHE.match(key);
    if (!hit) return 0;
    const j = await hit.json();
    return Number(j && j.n) || 0;
  } catch (e) {
    return 0;
  }
}

async function bumpCount(key, ttl) {
  try {
    const n = (await readCount(key)) + 1;
    await EDGE_CACHE.put(key, new Response(JSON.stringify({ n: n }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=' + (ttl || 86400) },
    }));
    return n;
  } catch (e) {
    return 0;
  }
}

// POST /api/article { id, password } → 返回正文（加密文章要密码）
async function handleArticleOpen(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ ok: false, error: '请求体必须是 JSON 对象' }, 400);
  const id = body.id == null ? '' : String(body.id);
  const password = body.password == null ? '' : String(body.password);
  const r = await readArticles(env);
  if (!r.ok) return json({ ok: false, error: r.error }, 502);
  const a = (r.articles || []).find((x) => x && String(x.id) === id);
  if (!a) return json({ ok: false, error: '没有找到这篇文章' }, 404);
  if (!a.locked) return json({ ok: true, body: a.body || '', locked: false });
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const key = EDGE_KEY_BASE + '/__unlock/' + ip + '/' + todayBJ();
  const used = await readCount(key);
  if (used >= 30) {
    return json({ ok: false, error: '今天试密码次数已达 30 次，明天再试' }, 429);
  }
  const text = await decryptBody(a.lock, password);
  if (text == null) {
    await bumpCount(key);
    return json({ ok: false, error: '密码不对' }, 401);
  }
  return json({ ok: true, body: text, locked: true });
}

const ADMIN_PAGE = `<!doctype html>
<html lang='zh-CN'>
<head>
<meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<meta name='robots' content='noindex'>
<title>网站管理后台</title>
<style>
*{box-sizing:border-box}
[hidden]{display:none!important}
:root{--bg:#f1f5f9;--card:#fff;--line:#e2e8f0;--text:#0f172a;--muted:#64748b;--brand:#2563eb;--side:#0f172a;--ok:#16a34a;--warn:#d97706;--bad:#dc2626}
html,body{margin:0;min-height:100%}
body{font:15px/1.6 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--text)}
#errBar{position:sticky;top:0;z-index:99;background:#fee2e2;color:#991b1b;border-bottom:1px solid #fca5a5;padding:10px 16px;font-size:13.5px;line-height:1.5}
#errBar b{font-weight:700}
#errBar code{background:#fff;border:1px solid #fecaca;border-radius:6px;padding:1px 6px;font-size:12px}
#gate{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:linear-gradient(135deg,#0f172a,#1e3a8a)}
.gbox{background:#fff;border-radius:18px;padding:32px;width:min(380px,100%);box-shadow:0 20px 60px rgba(0,0,0,.3)}
.gbox h1{margin:0 0 6px;font-size:22px}
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.side{background:var(--side);padding:24px 14px;position:sticky;top:0;height:100vh;height:100dvh;overflow-y:auto}
.brand{color:#fff;font-weight:700;font-size:17px;padding:0 10px 16px;border-bottom:1px solid #1e293b;margin-bottom:12px}
.brand small{display:block;color:#64748b;font-weight:400;font-size:12px}
.nav{display:block;width:100%;text-align:left;background:none;color:#cbd5e1;border:0;border-radius:10px;padding:10px 14px;font:inherit;font-size:15px;cursor:pointer;min-height:42px;margin-bottom:4px}
.nav:hover{background:#1e293b;color:#fff}
.nav[aria-current=true]{background:var(--brand);color:#fff}
.main{padding:28px 36px 60px;min-width:0}
.bar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.bar h1{margin:0;font-size:24px}
.bar .sub{color:var(--muted);font-size:14px}
.pane{max-width:1040px}
.intro{background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:12px;padding:12px 16px;font-size:14px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;margin-bottom:18px;box-shadow:0 1px 2px rgba(15,23,42,.04);min-width:0}
.card h2{margin:0 0 2px;font-size:17px}
.card .desc{color:var(--muted);font-size:13px;margin:0 0 8px}
label{display:block;font-size:13px;color:#334155;margin:14px 0 5px;font-weight:600}
.hint{color:var(--muted);font-size:12px;margin-top:4px;font-weight:400}
input[type=text],input[type=password],input[type=url],input[type=date],textarea{width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;font:inherit;font-size:14px;min-height:42px;background:#fff;color:var(--text)}
input:focus,textarea:focus{outline:2px solid #93c5fd;border-color:transparent}
textarea{min-height:110px;resize:vertical}
textarea.code{font-family:Consolas,monospace;font-size:13px;min-height:180px}
button{background:var(--brand);color:#fff;border:0;border-radius:10px;padding:9px 18px;font:inherit;font-size:14px;cursor:pointer;min-height:40px}
button:hover{filter:brightness(1.06)}
button.ghost{background:#fff;color:var(--text);border:1px solid #cbd5e1}
button.danger{background:var(--bad)}
button.small{padding:6px 12px;min-height:32px;font-size:13px}
button:disabled{opacity:.5;cursor:not-allowed}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;align-items:center}
.msg{color:var(--muted);font-size:14px}
.dirt{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:999px;background:#fef3c7;color:#92400e;font-size:11.5px;font-weight:600;vertical-align:3px}
.dirt[hidden]{display:none}
.draft-bar{flex:1 1 100%;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:2px 0 0;padding:9px 12px;border:1px solid #fde68a;border-radius:10px;background:#fffbeb;font-size:12.5px;color:#92400e;line-height:1.6}
.draft-bar[hidden]{display:none}
.draft-bar>span{flex:1 1 100%;min-width:0}
.save-msg{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;margin-left:10px;font-size:12.5px;line-height:1.7;color:var(--muted)}
.save-msg.ok{color:#15803d}
.save-msg.err{color:var(--bad)}
.save-msg .linkbtn{margin:0;padding:0 2px;min-height:0;border:0;background:none;color:inherit;font:inherit;font-weight:700;text-decoration:underline;text-underline-offset:2px;cursor:pointer;box-shadow:none}
.save-msg .linkbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.toggle{display:flex;align-items:center;gap:10px;margin:4px 0 2px;font-weight:600;color:var(--text)}
.toggle input{width:20px;height:20px;margin:0}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top;word-break:normal;overflow-wrap:anywhere}
th{white-space:nowrap}
tbody tr:nth-child(even){background:#fcfdff}
tbody tr:hover{background:#f6f9fc}
th{color:var(--muted);font-weight:600;font-size:13px}
.empty{color:var(--muted);padding:18px 0;text-align:center;font-size:14px}
.empty-card{padding:30px 20px;margin:6px 0;border:1px dashed var(--line);border-radius:14px;background:linear-gradient(180deg,#fcfdff,#f8fafc);text-align:center}
.empty-card b{display:block;font-size:15px;color:var(--ink);margin-bottom:6px}
.empty-card p{margin:0 0 14px;color:var(--muted);font-size:13px;line-height:1.7}
.empty-card .btn{display:inline-flex}
td>.empty-card{margin:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:14px}
.stat{background:#f8fafc;border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.stat b{display:block;font-size:12px;color:var(--muted);font-weight:500}
.stat span{font-size:15px;font-weight:600}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#94a3b8;margin-right:8px;vertical-align:middle}
.dot.ok{background:var(--ok)}
.dot.bad{background:#e11d48}
.dot.warn{background:var(--warn)}
.dot.bad{background:var(--bad)}
.faq-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) auto;gap:8px;align-items:start;margin-top:10px}
.faq-row textarea{min-height:70px}
.err{color:var(--bad);font-size:13px;min-height:18px;margin-top:8px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:calc(100% - 32px);padding:10px 18px;border-radius:10px;background:#1f2937;color:#fff;font-size:14px;display:none;z-index:50}
.toast.show{display:block}
.toast.ok{background:var(--ok)}
.toast.err{background:var(--bad)}
/* ---- 导航分组 / 徽标 ---- */
.navgroup{font-size:11px;letter-spacing:.08em;color:#94a3b8;margin:16px 0 6px;padding:0 14px}
.navgroup:first-of-type{margin-top:6px}
.nav-badge{display:inline-block;min-width:20px;margin-left:8px;padding:0 6px;border-radius:999px;background:rgba(255,255,255,.16);font-size:11px;line-height:18px;text-align:center;vertical-align:middle;font-weight:500}
.nav[aria-current=true] .nav-badge{background:rgba(255,255,255,.3)}
/* ---- 卡片头 / 工具条 ---- */
.card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.toolbar input[type=text]{max-width:320px}
.main a.ghost{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--text);text-decoration:none;font-size:12.5px;line-height:1;vertical-align:middle}
.main a.ghost:hover{border-color:#c7d2fe;color:var(--accent)}
.secret{display:flex;gap:8px;align-items:center}
.secret input{flex:1;min-width:0}
.secret .ghost{flex:none}
.row-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 4px}
    /* ---- 广告位 ---- */
    .ad-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;margin-bottom:14px}
    .ad-card{margin:0}
    .ad-card .hint{margin:2px 0 8px}
    .ad-code{min-height:96px;margin-top:6px}
    code.slot-id{font-size:11px;padding:2px 6px;border-radius:6px;background:#f1f5f9;color:#475569;font-weight:600}
    .ticker-card{margin-bottom:18px}
    .grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:10px 0}
    label.field{display:block;font-size:12.5px;color:var(--muted);font-weight:600}
    label.field input,label.field textarea{display:block;margin-top:6px;width:100%}
    .ad-sec{display:flex;align-items:baseline;gap:10px;margin:22px 0 10px}
    .vf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:10px}
    .ad-sec b{font-size:15px}
    .ad-sec span{font-size:12px;color:var(--muted)}
    .ad-card .ad-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .ad-click{display:block;margin-top:12px;padding-top:10px;border-top:1px dashed var(--line)}
    .ad-click-t{display:block;font-size:12px;color:var(--muted);font-weight:700;margin-bottom:6px}
    .ad-click input,.ad-click textarea{display:block;width:100%;font-size:13px;margin-bottom:6px}
    .every-input{width:66px;padding:4px 8px;margin:0 4px;font-weight:700;text-align:center}
    .ad-note{display:flex;gap:10px;align-items:flex-start;font-size:12.5px;color:var(--muted);margin-top:8px}
    .ad-note b{color:var(--text)}
    /* ---- 导航页后台 ---- */
    .nav-toolbar{display:flex;gap:12px;align-items:center;margin-bottom:14px;padding:12px 14px}
    .nav-toolbar input{flex:1 1 260px;max-width:420px}
    .nav-stat,.nav-cnt{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
    #navAdmin .card{margin-bottom:14px}
    #navAdmin .nav-g .card-head{margin-bottom:10px;align-items:flex-start}
    .nav-table td{padding:8px 8px;vertical-align:middle}
    .nav-table td.cell-name .nm{display:flex;align-items:center;gap:8px}
    .ic-prev{width:24px;height:24px;border-radius:6px;object-fit:contain;background:#f8fafc;border:1px solid var(--line);flex:none}
    .ic-none{display:inline-flex;align-items:center;justify-content:center;color:#cbd5e1;font-size:12px}
    .nav-table input{width:100%;font-size:12.5px;padding:6px 8px}
    .row-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    #navImpDlg{width:min(720px,calc(100% - 28px))}
    #navImpDlg textarea{min-height:220px;font-family:ui-monospace,Consolas,monospace}
    #navImpDlg .desc{color:var(--muted);font-size:13px;margin:6px 0 10px}
    .nav-g-head{display:flex;gap:8px;flex-wrap:wrap;flex:1;min-width:0}
    .nav-g-head input{max-width:260px}
    #navAdmin td input{font-size:13px;padding:7px 9px}
    #navAdmin table{margin-top:6px}
/* ---- 单选卡片（布局设置） ---- */
.choice-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(224px,1fr));gap:10px;margin:10px 0 4px}
.choice{display:flex;flex-wrap:wrap;align-items:center;gap:10px;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0;cursor:pointer;background:#fff;font-weight:600;color:var(--text)}
.choice:hover{border-color:#94a3b8}
.choice input{width:18px;height:18px;margin:0;flex:none}
.choice:has(input:checked){border-color:var(--brand);background:#eff6ff;box-shadow:0 0 0 1px var(--brand) inset}
.choice .sw{display:inline-flex;gap:4px;margin-right:10px;vertical-align:middle;flex:none}
.choice .sw i{width:15px;height:15px;border-radius:5px;display:block;border:1px solid rgba(0,0,0,.08)}
.choice-t{display:flex;flex-direction:column;font-size:14px;flex:1 1 100%;margin-top:2px}
.lp{display:flex;gap:3px;width:34px;height:20px;align-items:stretch;flex:none}
.lp i{flex:1;min-width:0;border-radius:2px;background:currentColor;opacity:.26}
.lp-hint i{border:1px dashed currentColor;background:transparent;opacity:.5}
.choice:has(input:checked) .lp i{opacity:.5}
.choice-t b{font-weight:400;font-size:12px;color:var(--muted);margin-top:2px}
/* ---- 状态清单 / 键值 ---- */
.status-list{display:grid;gap:8px;margin-top:8px}
.status-item{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px}
.status-item>b{flex:0 0 auto;white-space:nowrap}
.status-item>span:not(.dot){min-width:0;flex:1 1 auto}
.status-item .dot{margin:0}
.status-item small{color:var(--muted);margin-left:auto;font-size:12px;text-align:right}
.steps{margin:0;padding-left:20px;color:var(--muted);font-size:13px;line-height:1.9}
.steps code{font-size:12px}
.kv{display:grid;grid-template-columns:132px minmax(0,1fr);gap:10px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px}
.kv:last-child{border-bottom:0;padding-bottom:0}
.kv b{font-family:Consolas,ui-monospace,monospace;font-size:13px}
.kv span{color:#334155}
.raw{margin-top:8px}
    .raw summary{cursor:pointer;font-size:12px;color:#64748b}
    .raw pre{margin:6px 0 0;padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:11.5px;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}
    .toggle.inline{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#475569;white-space:nowrap}
    .serp{margin-top:6px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}
  .serp-t{font-size:17px;line-height:1.35;color:#1a0dab;font-weight:500;margin-bottom:2px}
  .serp-u{font-size:12.5px;color:#15803d;margin-bottom:4px;word-break:break-all}
  .serp-d{font-size:13px;line-height:1.6;color:#4b5563}
  .cnow{margin-top:4px;font-size:12px;color:#64748b}
  .cnow.cwarn{color:#b91c1c}
    .ad-acts{display:flex;align-items:center;gap:10px;margin-top:8px}
  .ad-acts-t{font-size:12px;color:var(--muted)}
  .ad-prev-wrap{padding:18px 22px 24px;overflow:auto}
  .ad-prev-wrap .card{margin:0}
    .qrprev{display:flex;gap:14px;align-items:center;margin:8px 0 12px}
  .qrprev img{width:108px;height:108px;object-fit:contain;border:1px solid var(--line);border-radius:10px;background:#fff;padding:6px}
  .tr-out{display:grid;gap:10px;margin-top:14px}
.tr-box{border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:14px;background:#f8fafc}
.tr-box h4{margin:0 0 6px;font-size:12px;color:var(--muted);font-weight:600}
.tr-box p{margin:0;color:var(--text);word-break:break-word;line-height:1.6}
.tr-bad{border-color:#fecaca;background:#fef2f2}
/* ---- 宽弹窗（写文章） ---- */
dialog.wide{width:min(1120px,calc(100% - 24px));max-height:calc(100dvh - 24px);padding:0;overflow:hidden}
dialog.wide[open]{display:grid;grid-template-rows:auto minmax(0,1fr)}
dialog.wide.full{width:calc(100% - 16px);max-height:calc(100dvh - 16px)}
.dlg-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px;padding:16px 22px;border-bottom:1px solid var(--line)}
.dlg-head h2,.dlg-head h3{margin:0 0 2px}
.dlg-head .msg{margin:0;font-size:13px}
.dlg-head-actions{display:flex;gap:8px;flex:none}
.art-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.92fr);min-height:0}
.art-grid.preview-off{grid-template-columns:minmax(0,1fr)}
.art-grid.preview-off .art-prev-col{display:none}
.art-col{padding:16px 22px 0;overflow:auto;max-height:none;display:flex;flex-direction:column}
.art-col>.actions{position:sticky;bottom:0;margin-top:auto;padding:12px 0 16px;background:#fff;border-top:1px solid var(--line);z-index:2}
.art-body{min-height:min(44vh,420px);font-family:Consolas,ui-monospace,monospace;font-size:13px;line-height:1.6}
.art-prev-col{border-left:1px solid var(--line);background:#f8fafc;display:flex;flex-direction:column;min-height:0}
.art-prev-head{padding:10px 16px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line);font-weight:600}
.art-prev{padding:16px 18px;overflow:auto;flex:1;min-height:0;font-size:14px;line-height:1.75}
.art-prev h1,.art-prev h2,.art-prev h3{margin:14px 0 8px;font-size:17px;line-height:1.35}
.art-prev p{margin:8px 0}
.art-prev pre{background:#0f172a;color:#e2e8f0;padding:10px 12px;border-radius:8px;overflow:auto;font-size:12px}
.art-prev code{font-family:Consolas,ui-monospace,monospace;font-size:.92em}
.art-prev img{max-width:100%;border-radius:8px}
.art-prev blockquote{margin:8px 0;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}
    .art-prev .md-table{overflow-x:auto;margin:10px 0;border-radius:8px}
    .art-prev table{border-collapse:collapse;width:100%;font-size:13px}
    .art-prev th,.art-prev td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
    .art-prev thead th{background:#f8fafc;font-weight:600;white-space:nowrap}
    .art-prev tbody tr:nth-child(even){background:rgba(15,23,42,.02)}
    .art-prev li.md-task{list-style:none;margin-left:-18px}
    .art-prev li.md-task input{margin-right:6px;vertical-align:-1px}
.field-row{display:grid;grid-template-columns:minmax(0,1fr) 190px;gap:12px;align-items:start}
@media (max-width:900px){
.art-grid{grid-template-columns:1fr}
.art-prev-col{border-left:0;border-top:1px solid var(--line)}
.art-col{max-height:none}
.art-prev{max-height:320px}
.field-row{grid-template-columns:1fr}
.kv{grid-template-columns:1fr}
.dlg-head{padding:14px 16px}
.art-col{padding:14px 16px 18px}
}

dialog{border:0;border-radius:16px;padding:24px;width:min(480px,calc(100% - 32px));color:var(--text);background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.25)}
dialog::backdrop{background:rgba(15,23,42,.5)}
dialog h2,dialog h3{margin:0 0 4px;font-size:18px}
@media (max-width:760px){
.app{grid-template-columns:1fr}
.side{position:sticky;top:0;height:auto;z-index:10;padding:0;display:flex;overflow-x:auto;background:var(--side);-webkit-overflow-scrolling:touch}
.brand{display:none}
.nav{width:auto;flex:none;border-radius:0;white-space:nowrap;padding:14px 16px;min-height:50px;margin:0}
.nav[aria-current=true]{background:var(--brand)}
.main{padding:18px 14px 48px}
.bar h1{font-size:20px}
.card{padding:16px}
.faq-row{grid-template-columns:1fr}
dialog{width:calc(100% - 24px)}
}


/* ===== 移动端（≤760px）密度收敛 ===== */
@media (max-width:760px){
  .grid2{grid-template-columns:1fr}
  .ad-grid{grid-template-columns:1fr}
  .art-grid{grid-template-columns:1fr}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pane{max-width:none}
  .card{padding:14px 14px 16px}
  th,td{padding:6px 8px;font-size:12.5px}
  .bar h1{font-size:19px}
  .bar .sub{font-size:12px}
  #navAdmin td input{font-size:12.5px;padding:6px 8px}
}
/* ===== UI v2：更干净的后台外观（后置覆盖，不动原有规则） ===== */
body{background:radial-gradient(900px 420px at 88% -8%,#e8effb 0%,#f5f7fb 55%,#f5f7fb 100%)}
.app{grid-template-columns:246px minmax(0,1fr)}
.side{background:linear-gradient(180deg,#0b1220 0%,#0d1a2f 100%);padding:22px 14px 28px;border-right:1px solid #16233a}
.brand{font-size:18px;letter-spacing:.2px;padding:2px 12px 16px;border-bottom:1px solid #1b2942;margin-bottom:14px;display:flex;flex-direction:column;gap:2px}
.brand small{font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:#5b7291}
.nav{border-radius:12px;padding:11px 14px;font-size:14.5px;color:#a9bad2;transition:background .15s,color .15s,transform .1s;display:flex;align-items:center;gap:8px;justify-content:flex-start}
.nav:hover{background:#16233a;color:#fff}
.nav[aria-current=true]{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;box-shadow:0 8px 18px rgba(37,99,235,.35)}
.navgroup{color:#5b7291;margin:18px 0 6px;padding:0 14px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase}
.main{padding:30px 40px 80px}
.bar{margin-bottom:22px;padding-bottom:16px;border-bottom:1px solid #e8edf6}
.bar h1{font-size:26px;letter-spacing:-.5px}
.bar .sub{font-size:13.5px;margin-top:2px}
.pane{max-width:1080px}
.intro{background:linear-gradient(180deg,#f2f7ff,#eef5ff);border:1px solid #dbe8fd;border-left:3px solid #2563eb;color:#1e3a8a;border-radius:14px;padding:13px 18px;font-size:13.5px;line-height:1.75;margin-bottom:20px}
.card{border-radius:18px;border:1px solid #e8edf6;box-shadow:0 2px 10px rgba(15,23,42,.045);padding:24px;margin-bottom:20px}
.card h2{font-size:17.5px;letter-spacing:-.2px}
.card .desc{font-size:12.5px;line-height:1.7}
label{font-size:12.5px;letter-spacing:.01em;color:#41546d;margin:16px 0 6px}
input[type=text],input[type=password],input[type=url],input[type=date],input[type=number],textarea,select{background:#f8fafc;border:1px solid #dde5f1;border-radius:12px;padding:11px 13px;font-size:14.5px;transition:border-color .15s,box-shadow .15s,background .15s}
input[type=text]:hover,textarea:hover,input[type=url]:hover,input[type=number]:hover{background:#fff;border-color:#c8d6ea}
input:focus,textarea:focus,select:focus{outline:0;background:#fff;border-color:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.14)}
textarea.code{border-radius:12px;background:#f8fafc;font-size:12.5px}
button{border-radius:12px;padding:10px 20px;min-height:42px;font-weight:600;letter-spacing:.01em;box-shadow:0 6px 14px rgba(37,99,235,.22);background:linear-gradient(135deg,#2563eb,#1d4ed8)}
button:hover{filter:brightness(1.05)}
button.ghost{background:#fff;color:#334155;border:1px solid #dbe3ef;box-shadow:none;font-weight:500}
button.ghost:hover{background:#f8fafc;border-color:#c2d3ea;color:#0f172a}
button.danger{background:linear-gradient(135deg,#ef4444,#dc2626);box-shadow:0 6px 14px rgba(220,38,38,.24)}
button.small{min-height:34px;padding:6px 14px;border-radius:10px}
.actions{margin-top:20px;padding-top:16px;border-top:1px dashed #e8edf6}
.card>.actions:first-child,.card .actions:first-child{padding-top:0;border-top:0}
.toggle{font-weight:600;font-size:14px}
.toggle input{accent-color:#2563eb;width:18px;height:18px}
table{border-radius:14px;overflow:hidden}
th{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:#7b8ba4;background:#f8fafc;border-bottom:1px solid #e8edf6;padding:11px 10px}
td{padding:11px 10px}
tr:hover td{background:#fafcff}
.stats{gap:14px}
.stat{background:linear-gradient(180deg,#fff,#f8fafc);border:1px solid #e8edf6;border-radius:14px;padding:14px 16px;box-shadow:0 1px 3px rgba(15,23,42,.04)}
.stat b{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:#7b8ba4}
.stat span{font-size:15.5px;font-weight:600}
.kv{border-bottom:1px dashed #eef2f9;padding:11px 0;font-size:13.5px}
.kv b{color:#334155}
.kv:last-child{border-bottom:0}
.raw pre{background:#f8fafc;border-radius:10px}
.tr-box{border-radius:12px;border:1px solid #e4eaf4;background:#f8fafc;padding:13px 16px;font-size:13.5px;line-height:1.7}
.tr-box.tr-bad{background:#fef2f2;border-color:#fecaca;color:#991b1b}
.status-list .status-item{border-radius:12px;padding:10px 14px;background:#f8fafc;border:1px solid #eef2f9}
.choice{border-radius:14px;padding:14px 16px;background:#f8fafc}
.choice:has(input:checked){background:#eff6ff;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
dialog{border-radius:20px;box-shadow:0 30px 80px rgba(2,6,23,.35)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#c9d6e8;border-radius:8px;border:2px solid transparent;background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}
#artTbody td:last-child{white-space:nowrap}
  /* 手机端：文章表格变卡片（摘要不再被挤成 44px 竖条） */
  @media (max-width:760px){
    #pane-articles table thead{display:none}
    #pane-articles .card:has(#artTbody){overflow-x:visible}
    #artTbody tr{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;padding:12px 13px;margin-bottom:10px;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.04)}
    #artTbody td{display:block;border:0;padding:0;min-width:0;white-space:normal}
    #artTbody td:nth-child(1){grid-column:1;grid-row:1;align-self:center}
    #artTbody td:nth-child(2){grid-column:2;grid-row:1;font-size:11.5px;color:var(--muted);letter-spacing:.02em}
    #artTbody td:nth-child(3){grid-column:1 / -1;grid-row:2;font-size:15px;font-weight:600;line-height:1.5}
    #artTbody td:nth-child(4){grid-column:1 / -1;grid-row:3;font-size:12.5px;color:var(--muted);line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    #pane-articles table{min-width:0;width:100%;table-layout:auto}
    #artTbody td:last-child{white-space:normal}
    #artTbody td:nth-child(5){grid-column:1 / -1;grid-row:4;display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;text-align:left}
    #artTbody td:nth-child(5) button{flex:1 1 0;min-height:40px;margin:0;padding:0 8px}
  }
.faq-row{grid-template-columns:minmax(0,1fr) minmax(0,1.7fr) 64px;align-items:start}
.faq-row textarea{min-height:96px;line-height:1.65}
.faq-row>button{align-self:center;min-height:36px;padding:6px 12px}
#faqList .faq-row+.faq-row{margin-top:12px;padding-top:12px;border-top:1px dashed #eef2f9}
#artTbody td:last-child button{display:inline-block;vertical-align:middle;margin:2px 4px 2px 0}
.artpager{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:10px}
.artpager .msg{color:#64748b;font-size:13px}
#artTbody td:last-child button:last-child{margin-right:0}
#artTbody td{vertical-align:middle}
#artTbody .art-title{font-weight:600}
#navAdmin td:last-child{white-space:nowrap}
@media (max-width:900px){.main{padding:20px 16px 56px}.app{grid-template-columns:1fr}}

/* ===== UI v3：后台换回前台同一套品牌色（暖米白 + 金），不再蓝白各一套 ===== */
body{background:radial-gradient(900px 420px at 88% -8%,#f3ecdc 0%,#faf7f0 55%,#faf7f0 100%);color:#1c2230}
.main{background:transparent}
.side{background:linear-gradient(180deg,#1b1712 0%,#241d14 100%);border-right:1px solid #332a1c}
.brand{color:#f7f2e6}
.brand small{color:#9c8a6a}
.nav{color:#c9bda6}
.nav:hover{background:#2b2418;color:#fff}
.nav[aria-current=true]{background:linear-gradient(135deg,#c9921a,#a1710a);color:#fff;box-shadow:0 8px 18px rgba(176,125,16,.35)}
.navgroup{color:#8d7a5a}
.bar{border-bottom:1px solid #e5e0d4}
.bar h1{color:#1c2230}
.bar .sub,.card .desc,.hint,.msg{color:#6b7280}
.pane{max-width:1080px}
.intro{background:linear-gradient(180deg,#fbf5e8,#f8f0df);border:1px solid #eadfc6;border-left:3px solid #b07d10;color:#6b4a06}
.card{border:1px solid #e5e0d4;background:#fff;box-shadow:0 1px 2px rgba(28,34,48,.05),0 10px 26px -20px rgba(28,34,48,.35)}
.card h2{color:#1c2230}
label{color:#4b5364}
input[type=text],input[type=password],input[type=url],input[type=date],input[type=number],textarea,select{background:#fdfbf6;border:1px solid #e5e0d4;color:#1c2230}
input[type=text]:hover,textarea:hover,input[type=url]:hover,input[type=number]:hover{background:#fff;border-color:#d8cfb9}
input:focus,textarea:focus,select:focus{border-color:#b07d10;box-shadow:0 0 0 4px rgba(176,125,16,.16)}
textarea.code{background:#fdfbf6}
button{background:linear-gradient(135deg,#c9921a,#a1710a);color:#fff;box-shadow:0 6px 14px rgba(176,125,16,.26)}
button.ghost{background:#fff;color:#4b5364;border:1px solid #e5e0d4;box-shadow:none}
button.ghost:hover{background:#fdf9f0;border-color:#d8cfb9;color:#1c2230}
button.danger{background:linear-gradient(135deg,#d4573f,#b93a22);box-shadow:0 6px 14px rgba(185,58,34,.24)}
table{border:1px solid #eee9dd}
th{background:#f8f4ea;color:#7c6f56;border-bottom:1px solid #e5e0d4}
td{border-bottom:1px solid #f1ece1}
tr:hover td{background:#fdfaf2}
.stat{background:linear-gradient(180deg,#fff,#fbf7ee);border:1px solid #e5e0d4}
.stat b{color:#8d7a5a}
.kv{border-bottom:1px dashed #eee9dd}
.kv b{color:#3f4757}
.tr-box{background:#fdfbf6;border:1px solid #eae4d6;color:#33404f}
.tr-box.tr-bad{background:#fdf1ee;border-color:#f3ccc2;color:#9c2f1c}
.status-list .status-item{background:#fdfbf6;border:1px solid #eee9dd}
.choice{background:#fdfbf6;border:1px solid #e5e0d4}
.choice:has(input:checked){background:#fbf4e3;border-color:#c9921a;box-shadow:0 0 0 3px rgba(176,125,16,.13)}
.toggle input{accent-color:#b07d10}
.raw pre{background:#fdfbf6;border:1px solid #eee9dd}
code.slot-id{background:#f6f1e4;color:#7a6a4c}
.dot.ok{background:#3f9d6b}
.nav-badge{background:#f0b429;color:#3a2a00}
::-webkit-scrollbar-thumb{background:#d8cfb9;border-radius:8px;border:2px solid transparent;background-clip:content-box}
#errBar{background:#fdecea;color:#a32a17;border-bottom:1px solid #f5c6bc}
.lockrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0 2px;padding:10px 12px;border:1px dashed var(--line);border-radius:12px;background:#fdfbf6}
.lockrow input[type="password"]{flex:1 1 240px;min-width:0}
.lockrow .toggle.inline{margin:0;white-space:nowrap}
.slugrow{display:flex;gap:6px;align-items:center;min-width:220px;flex:1}
.slugrow input{flex:1;min-width:0}
.slug-sep{color:#9a9285;font-family:ui-monospace,Menlo,Consolas,monospace}
.slugprev{margin-top:6px;font-size:12px;line-height:1.6;color:#6b7280;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
.slugprev.warn{color:#b4232b}
.slugline{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px;font-size:11.5px;color:#8a8172;margin-top:2px;font-family:ui-monospace,Menlo,Consolas,monospace}
.cthumb{display:inline-block;width:38px;height:21px;vertical-align:-4px;margin-right:7px;border-radius:4px;border:1px solid var(--line);background:var(--chip) center/cover no-repeat}
.pinchip{display:inline-block;padding:0 6px;margin-right:6px;border-radius:999px;font-size:11px;
  line-height:17px;color:#8a4b00;background:#fff1d6;border:1px solid #f0c887;font-weight:600}
.art-lock{display:inline-block;white-space:nowrap;font-size:11px;padding:1px 6px;border-radius:6px;background:#f6e7c8;color:#7a5a11;font-weight:600;margin-left:6px;vertical-align:middle}

/* UI v4 · 中性纸感：去掉渐变与光晕，只留细线、留白和一种强调色 */
:root{--brand:#b07d10;--ok:#1f7a4d;--warn:#a8661a;--bad:#a2341f}
body{background:#f6f5f2;background-image:none;color:#15171a;-webkit-font-smoothing:antialiased}
.app{grid-template-columns:236px minmax(0,1fr)}
.side{background:#141517;background-image:none;box-shadow:none;border-right:1px solid #0c0d0f}
.navgroup{margin:20px 0 6px;padding:0 12px;font-size:10.5px;letter-spacing:.16em;color:rgba(255,255,255,.34)}
.nav{background:transparent;background-image:none;border:0;border-radius:8px;box-shadow:none;color:rgba(255,255,255,.7);font-weight:500;padding:9px 12px}
.nav:hover{background:rgba(255,255,255,.07);color:#fff}
.nav[aria-current="true"]{background:rgba(255,255,255,.09);background-image:none;color:#fff;box-shadow:inset 2px 0 0 #b07d10}
.nav-badge{background:#b07d10;color:#151310;box-shadow:none}
.main{padding:32px 46px 76px}
.bar{border-bottom:1px solid #e3e1dc;padding-bottom:14px;margin-bottom:22px}
.bar h1{font-size:22px;font-weight:650;letter-spacing:-.4px}
.bar .sub{color:#7c7a75;font-size:13px}
.pane{max-width:1040px}
.intro{background:#fbfaf7;background-image:none;border:1px solid #e8e5df;border-left:3px solid #b07d10;border-radius:10px;box-shadow:none;color:#413f3a;font-size:13.5px;line-height:1.75}
.card{background:#fff;border:1px solid #e8e6e1;border-radius:12px;box-shadow:0 1px 2px rgba(20,21,23,.04);padding:18px 20px}
.card-head b{font-size:14.5px;letter-spacing:-.1px}
.card-head .slot-id,code.slot-id{background:#f4f2ed;color:#6b6862;border:1px solid #e8e5df}
label{font-size:12.5px;font-weight:600;color:#5c5a55}
input,textarea,select{background:#fff;background-image:none;border:1px solid #dcdad4;border-radius:8px;box-shadow:none;color:#15171a}
input:hover,textarea:hover,select:hover{border-color:#c9c6be}
input:focus,textarea:focus,select:focus{outline:0;border-color:#b07d10;box-shadow:0 0 0 3px rgba(176,125,16,.13)}
button{background:#1b1c1f;background-image:none;color:#fff;border:0;border-radius:8px;box-shadow:none;font-weight:600}
button:hover{background:#000}
button.ghost{background:#fff;background-image:none;color:#1b1c1f;border:1px solid #dcdad4;box-shadow:none}
button.ghost:hover{background:#f6f5f1;border-color:#c9c6be}
button.danger{background:#fff;background-image:none;color:#a2341f;border:1px solid #eecdc6}
button.danger:hover{background:#fdf3f1}
button.small{padding:6px 10px;font-size:12.5px;border-radius:7px}
button:disabled{opacity:.55}
th{background:#faf9f6;color:#6f6d67;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid #e8e6e1}
td{border-bottom:1px solid #f1efea}
tr:hover td{background:#fcfbf8}
.stats .stat,.stat{background:#fff;background-image:none;border:1px solid #e8e6e1;border-radius:12px;box-shadow:none}
.stat b{font-size:20px;letter-spacing:-.4px}
.kv{border-bottom:1px dashed #e8e6e1}
.choice{background:#fff;background-image:none;border:1px solid #e2dfd9;border-radius:10px;box-shadow:none}
.choice:has(input:checked){background:#fbf7ec;background-image:none;border-color:#c9a94e;box-shadow:0 0 0 3px rgba(176,125,16,.12)}
.status-item{background:#fff;background-image:none;border:1px solid #e8e6e1}
.lockrow{background:#fbfaf7;background-image:none;border:1px dashed #e0ddd6;border-radius:10px}
.toast{background:#1b1c1f;background-image:none;box-shadow:0 12px 32px rgba(0,0,0,.22)}
#errBar{background:#fdf2f0;background-image:none;color:#a2311f;border-bottom:1px solid #f3cfc8}
.raw pre{background:#fbfaf7;background-image:none;border:1px solid #ecebe5}
::-webkit-scrollbar-thumb{background:#d6d3cc;border:2px solid transparent;background-clip:content-box}
.segtabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 18px;border-bottom:1px solid var(--line);padding-bottom:10px}
.segtabs button{border:1px solid transparent;background:transparent;color:var(--muted);font-weight:600;font-size:13.5px;padding:7px 14px;border-radius:9px;cursor:pointer}
.segtabs button:hover{background:#f3f1ec;color:var(--fg)}
.segtabs button.is-on{background:#1b1c1f;color:#fff;border-color:#1b1c1f}
#pane-ad[data-sec="fixed"] .ad-sec[data-sec="inline"],#pane-ad[data-sec="fixed"] .ad-grid[data-sec="inline"],#pane-ad[data-sec="fixed"] .ticker-card{display:none}
#pane-ad[data-sec="inline"] .ad-sec[data-sec="fixed"],#pane-ad[data-sec="inline"] .ad-grid[data-sec="fixed"],#pane-ad[data-sec="inline"] .ticker-card{display:none}
#pane-ad[data-sec="ticker"] .ad-sec,#pane-ad[data-sec="ticker"] .ad-grid{display:none}
.geo-plat{width:100%;border-collapse:collapse;font-size:13px}
.geo-plat th,.geo-plat td{border:1px solid var(--line);padding:8px 10px;vertical-align:top;text-align:left}
.geo-plat th{background:#faf9f6;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.geo-plat td code{font-size:12px}
.geo-plat a{white-space:nowrap}
.copybox{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
.copybox input{flex:1 1 320px;min-width:0;font-size:12.5px;background:#fbfaf7}
.side-extra{margin-top:auto;padding:14px 12px 18px;border-top:1px solid rgba(255,255,255,.08)}
.side-extra a{display:block;color:#cfc9bd;font-size:13px;padding:8px 12px;border-radius:9px;text-decoration:none}
.side-extra a:hover{background:rgba(255,255,255,.08);color:#fff}
.side .brandlink{display:block;text-decoration:none;color:inherit}
#qaList .qa-row{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px;background:#fff}
#qaList .qa-top{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
#qaList .qa-q{flex:1 1 320px;min-width:0;font-weight:600}
#qaList .qa-tag{width:110px}
#qaList .qa-a{width:100%;min-height:96px;font-size:13.5px;line-height:1.7}

/* ===== 移动端（≤760px）：后置覆盖 UI v2 的两列布局 ===== */
@media (max-width:760px){
  /* 手机上字号小于 16px 时，iOS Safari 聚焦会自动放大页面；用 #app 提权，压过 .nav-table input 之类的局部规则 */
  #app input:not([type=checkbox]):not([type=radio]),#app select,#app textarea{font-size:16px;min-height:36px}
  #qaFilter,#navFilter,#geoSm,#geoLlms{font-size:16px;min-height:36px}
  #app .qa-q,#app .qa-tag,#app .nav-table input{font-size:16px;min-height:36px}
  /* #qaList .qa-a 的 (1,1,0) 比 #app textarea 高，要单独压 */
  #app #qaList .qa-a{font-size:16px;min-height:120px}
  .status-item{flex-wrap:wrap;row-gap:2px}
  .status-item>span:not(.dot){flex:1 1 100%;color:var(--muted);font-size:13px;padding-left:18px}
  .main .btn,.main button,.main a.btn,.ghost.small{min-height:38px;display:inline-flex;align-items:center;justify-content:center}
  .card .actions{position:sticky;bottom:0;z-index:2;display:flex;gap:8px;flex-wrap:wrap;padding:10px 0 12px 70px;margin-top:8px;background:var(--card);border-top:1px solid var(--line)}
  .card .actions>button,.card .actions>.btn{flex:1 1 100%;min-height:44px}
  .card .actions>.save-msg,.bar .save-msg{flex:1 1 100%;margin-left:0}
  #cmdk .ck-item{min-height:44px;padding:11px 12px;font-size:14px}
  #cmdk .ck-box{max-height:calc(100dvh - 32px)}
  .app{grid-template-columns:1fr}
  .side{position:sticky;top:0;height:auto;display:flex;overflow-x:auto;padding:0;border-right:0;border-bottom:1px solid #16233a;background:linear-gradient(180deg,#0b1220 0%,#0d1a2f 100%)}
  .side .brandlink{display:none}
  .side .navgroup{display:flex;align-items:center;gap:2px;padding:0 4px}
  .side .navgroup::before{display:none}
  .nav{width:auto;flex:none;border-radius:0;white-space:nowrap;padding:14px 14px;min-height:50px;margin:0}
  html,body{overflow-x:hidden;max-width:100%}
  .side{max-width:100vw}
  .side .navgroup{flex-wrap:nowrap}
  .main{padding:16px 12px 44px}
  .grid2,.ad-grid,.art-grid{grid-template-columns:1fr}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pane{max-width:none}
  .card{padding:14px}
  th,td{padding:6px 8px;font-size:12.5px}
  .bar h1{font-size:19px}
  #navAdmin td input{font-size:12.5px;padding:6px 8px}
  .faq-row{grid-template-columns:1fr}
}
  :focus-visible{outline:2px solid #2563eb;outline-offset:2px;border-radius:6px}
  .main table thead th{position:sticky;top:0;z-index:2;background:#f8fafc}
.card:has(>table){overflow-x:auto;box-shadow:inset -14px 0 12px -14px rgba(15,23,42,.28)}
  .cmdk{width:min(540px,calc(100% - 24px));padding:0;border:0;border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.22)}
  .cmdk .ck-box{padding:12px 12px 10px}
  .cmdk input{width:100%;padding:11px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px}
  .ck-list{max-height:330px;overflow:auto;margin-top:8px}
  .ck-item{display:flex;justify-content:space-between;gap:10px;padding:9px 10px;border-radius:9px;font-size:13.5px;cursor:pointer}
  .ck-item.on{background:#eff6ff;color:#1d4ed8}
  .ck-item small{color:#94a3b8}
  .ck-foot{padding:4px 4px 0;font-size:12px;color:#94a3b8}
@media (max-width:760px){#cmdk .ck-foot{font-size:12.5px;padding:8px 4px 0;text-align:center}}
.cmdk-fab{position:fixed;left:14px;bottom:16px;z-index:30;width:46px;height:46px;padding:0;border-radius:15px;font-size:17px;line-height:1;box-shadow:0 8px 20px rgba(15,23,42,.18)}
@media (min-width:761px){.cmdk-fab{display:none}}
  .side .nav:focus-visible{outline-offset:-2px;box-shadow:0 0 0 3px rgba(37,99,235,.25)}
  .navgroup:first-child .nav{margin-top:0}
  .skip-link{position:absolute;left:-9999px;top:8px;z-index:99;background:#fff;border:1px solid #2563eb;border-radius:8px;padding:8px 12px;font-size:13px}
  .skip-link:focus{left:12px}
/* 导航表格：固定列宽、单行省略、按钮显式 */
#navAdmin{overflow-x:auto;-webkit-overflow-scrolling:touch}
#navAdmin table{table-layout:fixed;width:100%}
#navAdmin td:nth-child(1){width:17%}
#navAdmin td:nth-child(2){width:27%}
#navAdmin td:nth-child(3){width:22%}
#navAdmin td:nth-child(4){width:22%}
#navAdmin td:nth-child(5){width:12%;white-space:nowrap}
#navAdmin td{padding:6px;vertical-align:middle}
#navAdmin td input{width:100%;min-width:0;text-overflow:ellipsis}
#navAdmin td input:focus{text-overflow:clip}
@media (max-width:760px){
  .card:has(>table){overflow-x:auto;-webkit-overflow-scrolling:touch}
  .card:has(>table) table{min-width:520px}
  /* 提交页的 4 列平台表：手机上改成堆叠卡片，用伪元素补列名 */
  .geo-plat{border-collapse:separate;border-spacing:0}
  .geo-plat thead{display:none}
  .geo-plat tbody,.geo-plat tr,.geo-plat td{display:block;width:auto}
  .geo-plat tr{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:0 0 10px;background:#fff}
  .geo-plat td{border:0;padding:3px 0;font-size:13.5px}
  .geo-plat td:first-child{font-size:14.5px;padding-bottom:6px}
  .geo-plat td:nth-child(2)::before{content:"要做什么 · ";color:var(--muted)}
  .geo-plat td:nth-child(3)::before{content:"要填的参数 · ";color:var(--muted)}
  .geo-plat td:nth-child(4)::before{content:"能一键吗 · ";color:var(--muted)}
  .geo-plat td:nth-child(4){font-weight:600}
  /* 复制框在窄屏上下排 */
  .copybox{flex-direction:column;align-items:stretch}
  .copybox input{width:100%}
  .copybox .ghost{width:100%;justify-content:center}
  /* 平台表已经堆叠成卡片，不再需要「右边还有内容」的内阴影 */
  .card:has(.geo-plat){box-shadow:none}
  /* 320 窄屏：工具栏换行、表格不再被 min-width 撑破、小字提到 12px、行内链接可点 */
  .nav-toolbar{flex-wrap:wrap;gap:10px}
  .nav-toolbar input{flex:1 1 100%;max-width:none}
  .nav-stat{flex:0 0 auto}
  .card:has(.geo-plat) table{min-width:0}
  .geo-plat a,.geo-plat code{white-space:normal;word-break:break-all}
  #pane-submit code,#pane-keys code,#pane-submit .kv a,#pane-keys .kv a,#pane-submit .kv code{white-space:normal;word-break:break-all;overflow-wrap:anywhere;min-width:0;max-width:100%}
  #pane-submit a[href],#pane-keys a[href]{display:inline-block;min-height:32px;line-height:1.9;padding:5px 0;word-break:break-all}
  #pane-submit a[href],#pane-keys a[href]{display:inline-block;min-height:32px;line-height:1.95;padding:5px 0;word-break:break-all}
  .slugline,.art-lock,#artTbody td{font-size:12px}
  #pane-articles #artTbody td{font-size:12.5px}
  #pane-articles #artTbody button{min-height:44px;min-width:40px}
  #pane-articles #artPager button,#pane-articles .pjump input{min-height:44px;min-width:44px}
  /* 侧栏分组名在横向条里别一个一个字竖排 */
  .side .navgroup{flex:0 0 auto;white-space:nowrap;font-size:10px;padding:0 8px;opacity:.75}
  /* 侧栏横向滚动：右缘渐隐提示还有更多，划到末尾自动收起 */
  .side{scroll-snap-type:x proximity;scroll-padding-left:6px;
    -webkit-mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 24px),transparent 100%);
    mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 24px),transparent 100%)}
  .side.x-start{
    -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 24px,#000 calc(100% - 24px),transparent 100%);
    mask-image:linear-gradient(90deg,transparent 0,#000 24px,#000 calc(100% - 24px),transparent 100%)}
  .side.x-end{-webkit-mask-image:none;mask-image:none}
  .side.x-start.x-end{-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 24px);mask-image:linear-gradient(90deg,transparent 0,#000 24px)}
  .side .nav{scroll-snap-align:start}
  .toolbar{gap:8px}
  .toolbar input[type=text],.toolbar input[type=search]{flex:1 1 100%;max-width:none}
  .toolbar select,.toolbar .btn,.toolbar button{flex:1 1 auto;max-width:none;min-width:0}
  .toolbar .note,.toolbar .msg{flex:1 1 100%;margin-left:0}
  /* 「已选 0 篇」这类提示为空时不要占掉一整行，否则窄屏工具栏会多出一行空带 */
  #artSelNote:empty{display:none}
  /* 文章面板：先筛后排，批量删除垫底，避免首屏正对着「删除选中」 */
  #pane-articles .toolbar>#artSort{order:1}
  #pane-articles .toolbar>#artCatFilter{order:2}
  #pane-articles .toolbar>#artAllMatch{order:3}
  #pane-articles .toolbar>#artBulkCat{order:4}
  #pane-articles .toolbar>#artBulkApply{order:5}
  #pane-articles .toolbar>#artBulkDel{order:6}
  #pane-articles .toolbar>#artUndo{order:7}
  #pane-articles .toolbar>#artSelNote{order:8;flex:1 1 100%}
  /* 分组小标题在横向胶囊条里没有意义，且会挤在两个 tab 中间让人误会 */
  .side .navgroup{display:none}
  .side .nav{margin:0 2px}
  /* 横向条只该占一行：原来是 227px 高，把首屏吃掉三分之一 */
  .side{max-height:58px;align-items:center;padding:6px 4px}
  .side .nav{align-self:center;height:auto;min-height:44px;padding:10px 12px}
  #navAdmin table{min-width:560px}
  .main{padding:16px 14px 44px}
}
#navAdmin button[data-ifetch]{white-space:nowrap;font-size:12px;padding:3px 9px;border:1px solid var(--line);background:#fff;color:#4f46e5;font-weight:600;border-radius:8px;cursor:pointer}
#navAdmin button[data-ifetch]:hover{border-color:#4f46e5;background:#eef2ff}
.toolbar #navFilter{flex:1 1 320px;min-width:0;max-width:none}
.toolbar .note{margin-left:auto}
#linkBody .muted-cell{color:#6b7280;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#linkBody td.row-actions{display:table-cell;white-space:nowrap;width:210px;text-align:right}
#linkBody .row-actions{white-space:nowrap}
#linkBody .row-actions .btn{margin-left:6px}
#linkBody{table-layout:fixed;width:100%}
#linkBody td:nth-child(1){width:18%}
#linkBody td:nth-child(2){width:36%}
#linkBody td:nth-child(3){width:24%}
#linkBody td:nth-child(4){width:22%;white-space:nowrap}

</style>
</head>
<body>
<a class="skip-link" href="#app">跳到内容</a>
<div id="gate">
  <form class="gbox" id="loginForm">
    <h1>网站管理后台</h1>
    <label for="pw">管理密码</label>
    <input type="password" id="pw" autocomplete="current-password">
    <div class="actions"><button type="submit" id="loginBtn" style="width:100%">进入后台</button></div>
    <div class="err" id="loginErr"></div>
  </form>
</div>

<div id="errBar" hidden></div>
<div class="app" id="app" hidden>
  <aside class="side">
    <a class="brandlink" href="/" target="_blank" rel="noopener"><div class="brand">网站管理后台<small>仅管理员可见</small></div></a>
    <div class="navgroup">常用</div>
    <button type="button" class="nav" data-tab="overview">概览</button>
    <button type="button" class="nav" data-tab="layout">榜单布局</button>
    <button type="button" class="nav" data-tab="articles">文章<span class="nav-badge" id="navArtCount" hidden>0</span></button>
    <button type="button" class="nav" data-tab="qa">问答</button>
    <div class="navgroup">内容</div>
    <button type="button" class="nav" data-tab="seo">SEO 与 GEO</button>
    <button type="button" class="nav" data-tab="links">友链</button>
    <button type="button" class="nav" data-tab="nav">导航页<span class="nav-badge" id="navItemCount" hidden>0</span></button>
    <button type="button" class="nav" data-tab="ad">广告</button>
    <div class="navgroup">站点信息</div>
    <button type="button" class="nav" data-tab="contact">联系方式</button>
    <button type="button" class="nav" data-tab="beian">备案信息</button>
    <div class="navgroup">外观与运维</div>
    <button type="button" class="nav" data-tab="theme">主题</button>
    <button type="button" class="nav" data-tab="submit">收录提交</button>
    <button type="button" class="nav" data-tab="keys">设置与密钥</button>
    <button type="button" class="nav" data-tab="translate">翻译</button>
    <div class="side-extra"><a href="/" target="_blank" rel="noopener">↗ 打开前台首页</a><a href="/faq" target="_blank" rel="noopener">↗ 问答页 /faq</a><a href="/llms.txt" target="_blank" rel="noopener">↗ llms.txt</a></div>
    </aside>

  <main class="main">

    <section class="pane" id="pane-overview">
      <div class="bar"><div><h1>概览</h1><div class="sub">保活状态与定时任务</div></div></div>
      <div class="intro">这里显示仓库的保活状态。GitHub 连续 60 天没有提交，定时任务就会被停用，所以系统每周自动写入一次时间戳。平时不需要操作；如果状态是「注意」或「有风险」，点下方按钮立即保活一次。</div>
      <div id="healthBar" class="err" hidden></div>
      <div class="card">
        <h2><span class="dot" id="stDot"></span><span id="stState">加载中…</span></h2>
        <p class="desc" id="stNote"></p>
        <div class="stats">
          <div class="stat"><b>上次保活</b><span id="stLast">—</span></div>
          <div class="stat"><b>距今</b><span id="stAge">—</span></div>
          <div class="stat"><b>下次定时</b><span id="stNext">—</span></div>
          <div class="stat"><b>最近一次数据更新</b><span id="stWf">—</span></div>
        </div>
        <div class="err" id="stErr"></div>
        <div class="actions">
          <button type="button" id="keepBtn">立即保活一次</button>
          <button type="button" class="ghost" id="refreshBtn">刷新状态</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><b>站点体检</b><span class="hint">绿色=正常，红色=需要处理</span></div>
        <div class="status-list" id="healthBox"><div class="empty">加载中…</div></div>
        <div class="row-actions">
          <button type="button" class="ghost" data-copy="https://github.661026.xyz/sitemap.xml">复制 sitemap.xml</button>
          <button type="button" class="ghost" data-copy="https://github.661026.xyz/llms.txt">复制 llms.txt</button>
          <button type="button" class="ghost" data-copy="https://github.661026.xyz/robots.txt">复制 robots.txt</button>
          <button type="button" class="ghost" id="healthReload">刷新体检</button>
        </div>
        <p class="hint">搜索引擎的「提交站点地图」框里，直接粘贴上面复制的地址即可。</p>
      </div>
      <div class="card">
        <div class="card-head"><b>还能补的设置</b><span class="hint">不影响访问，但补齐对收录和访客体验有用</span></div>
        <div class="status-list" id="todoBox"><div class="empty">加载中…</div></div>
        <div class="row-actions"><button type="button" class="ghost" id="todoReload">重新检查</button></div>
      </div>
    </section>

    <section class="pane" id="pane-links" hidden>
      <div class="bar">
        <div><h1>友链</h1><div class="sub">显示在排行榜页面上的友情链接</div></div>
        <button type="button" id="addLinkBtn">添加友链</button>
      </div>
      <div class="intro">友链会显示在排行榜页面的友情链接区域。名称建议 40 字以内，网址必须以 http:// 或 https:// 开头，最多 50 条。删除后刷新首页立刻生效（浏览器若还留着旧页面，Ctrl+F5 一次即可）。</div>
      <div class="card">
        <div class="msg">当前 <span id="linkCount">0</span> 条</div>
        <table>
          <thead><tr><th>名称</th><th>网址</th><th>描述</th><th style="width:130px">操作</th></tr></thead>
          <tbody id="linkBody"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
        </table>
      </div>
    </section>

    <section class="pane" id="pane-ad" data-sec="fixed" hidden>
      <div class="bar"><div><h1>广告</h1><div class="sub">${AD_SLOTS.length} 个位置 + 顶部滚动条：逐格开关、逐格代码、点开可以跳链接或弹窗</div></div></div>
      <div class="intro">勾上并保存就出现在那个位置，不勾就完全不渲染（不留白）。<b>固定位</b>是通栏，<b>信息流位</b>插在列表中间、间隔自己填（1–${AD_EVERY_MAX} 条之间的任意整数）。每格可以单独设「点击行为」：填弹窗内容 → 点击就地弹窗；只填链接 → 新窗口打开。位置示意图：<code>docs/shots/ad-slots.png</code>。</div>

        <div class="segtabs" data-group="ad"><button type="button" class="is-on" data-adsec="fixed">固定位 6</button><button type="button" data-adsec="inline">信息流位 3</button><button type="button" data-adsec="ticker">顶部滚动条</button></div>
      <div class="card ticker-card" data-sec="ticker">
        <div class="card-head"><div><h2>顶部滚动条</h2><p class="desc">页面最上面一条滚动文字，适合活动通知/一句话广告。访客点 × 可以关掉，本机会记住 7 天。</p></div>
          <label class="toggle"><input type="checkbox" id="ticker-enabled">开启</label></div>
        <div class="grid2">
          <label class="field">滚动文字（最多 200 字）<input type="text" id="ticker-text" maxlength="200" placeholder="例如：本站数据每 3 小时自动更新一次"></label>
          <label class="field">滚动速度（秒 / 圈，6–60，越小越快）<input type="number" id="ticker-speed" min="6" max="60" step="1" value="18"></label>
        </div>
        <div class="grid2">
          <label class="field">点击跳转链接（可选）<input type="url" id="ticker-link" placeholder="https://…"></label>
          <label class="field">点击弹窗内容（可选，HTML）<textarea class="code" id="ticker-modal" rows="2" maxlength="20000" placeholder="填了就点开弹窗，优先于链接"></textarea></label>
        </div>
        <div class="ad-note"><b>提示</b><span>不填文字也不填弹窗内容时不能开启；滚动条只在首页/导航页顶部出现，不影响文章页。</span></div>
      </div>

      <div class="ad-sec" data-sec="fixed"><b>固定位</b><span>通栏，跟着页面布局走</span></div>
      <div class="ad-grid" data-sec="fixed">${AD_SLOTS.filter((s) => s.kind === 'fixed').map(adCardHtml).join('')}</div>

      <div class="ad-sec" data-sec="inline"><b>信息流位</b><span>插在列表中间，间隔可调</span></div>
      <div class="ad-grid" data-sec="inline">${AD_SLOTS.filter((s) => s.kind === 'inline').map(adCardHtml).join('')}</div>

      <div class="card">
        <div class="actions"><button type="button" data-save="ad">保存全部广告设置</button></div>
        <div class="hint">保存后前台刷新立刻生效（Worker 会把新配置直接写回边缘缓存）。只粘贴来源可信的代码，带 <code>&lt;script&gt;</code> 也会执行。</div>
      </div>
    </section>

      <section class="pane" id="pane-keys" hidden>
      <div class="bar">
        <div><h1>设置与密钥</h1><p class="sub">要填的东西都在这：翻译额度、百度准入密钥、IndexNow Key</p></div>
        <div class="bar-actions"><button class="btn primary" type="button" data-save="runtime">保存设置</button></div>
      </div>
      <p class="intro">这些值存在 <code>data/site.json</code> 的 <code>runtime</code> 分组里，保存后<b>立刻生效</b>，不需要去 Cloudflare 改任何变量。留空的项会自动回落到环境变量或内置默认值。</p>
      <div class="card">
        <div class="card-head"><div><h2>服务状态</h2><p class="desc">只显示「有没有」，不会显示任何密钥内容。</p></div><button type="button" class="ghost small" id="trReload">刷新</button></div>
        <div class="status-list" id="trStatus"><p class="empty">读取中…</p></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>翻译额度</h2><p class="desc">MyMemory 按邮箱算额度，Workers AI 按次数封顶。</p></div></div>
        <label for="rtEmails">MyMemory 联系邮箱（多个用逗号分隔，最多 20 个）</label>
        <textarea id="rtEmails" rows="2" maxlength="1000" placeholder="you@gmail.com"></textarea>
        <div class="hint">MyMemory 的免费额度<b>按邮箱</b>算（不带邮箱约 5 千字符/天，带邮箱约 5 万字符/天），一个用尽自动换下一个。Gmail / Outlook 支持 <code>名字+1@gmail.com</code> 这种别名，都进同一个信箱，所以可以点下面的按钮批量加。</div>
        <div class="actions"><button type="button" class="ghost small" id="rtAlias">按 +别名 生成 5 个</button></div>
        <label for="rtAiCap">Workers AI 每天最多调用多少次</label>
        <input type="number" id="rtAiCap" min="0" max="100000" step="1" placeholder="留空 = 用环境变量 AI_DAILY_CAP，或默认 400">
        <div class="hint">填 <b>0</b> = 不限制（不建议）；可填 1–100000。Workers AI 每天有 10,000 Neurons 免费额度，m2m100 这种小模型一次消耗很小，400 次大约只用到几百 Neuron；到上限只会停掉这条兜底链路，不会扣钱。</div>
        <div class="status-list" id="rtUsage"><p class="empty">读取中…</p></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>收录密钥</h2><p class="desc">填了就会用；留空则跳过对应推送，不影响其它功能。</p></div></div>
        <label for="rtBaiduToken">百度准入密钥（BAIDU_TOKEN）</label>
        <div class="secret"><input type="password" id="rtBaiduToken" maxlength="200" placeholder="百度搜索资源平台 → 普通收录 → API 提交 → 准入密钥" autocomplete="off"><button type="button" class="ghost small" data-eye="rtBaiduToken">显示</button></div>
        <div class="hint">拿法见「收录提交」页的「百度准入密钥在哪拿」。填这里就不必再去 Cloudflare 配变量；两边都填时以这里为准。</div>
        <label for="rtIndexKey">IndexNow Key</label>
        <div class="secret"><input type="password" id="rtIndexKey" maxlength="100" placeholder="留空 = 按仓库信息自动生成一个" autocomplete="off"><button type="button" class="ghost small" data-eye="rtIndexKey">显示</button></div>
        <div class="vf-grid">
          <div><label for="vfBytedance">字节 / 豆包 验证码</label><input type="text" id="vfBytedance" data-vf="bytedance" maxlength="200" placeholder="字节搜索资源平台的 meta content" autocomplete="off"></div>
          <div><label for="vfSogou">搜狗 / 元宝 验证码</label><input type="text" id="vfSogou" data-vf="sogou" maxlength="200" placeholder="搜狗站长平台的 meta content" autocomplete="off"></div>
          <div><label for="vfShenma">神马 / 夸克 验证码</label><input type="text" id="vfShenma" data-vf="shenma" maxlength="200" placeholder="神马站长平台的 meta content" autocomplete="off"></div>
        </div>
        <div class="hint">填好保存后，前台首页的 <code>&lt;head&gt;</code> 会自动带上对应的 meta 验证标签，不用手动改 index.html。</div>
        <div class="hint">IndexNow 要求站点根目录有一个 <code>&lt;key&gt;.txt</code>，本站会自动提供（地址在「收录提交」页）。想用 Bing Webmaster 生成的那个，就填这里。</div>
        <div class="actions"><button type="button" data-save="runtime">保存设置</button><span class="msg" id="rtMsg"></span></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>还需要的两个环境变量</h2><p class="desc">这两个是密钥，只能放在 Cloudflare 里，后台不保存。</p></div></div>
        <div class="kv"><b>GITHUB_TOKEN</b><span>Variables and Secrets → 添加 Secret。权限给 Contents: Read and write、Actions: Read and write（保存、保活、看工作流状态都要用）。</span></div>
        <div class="kv"><b>Workers AI</b><span>这是绑定不是变量：Bindings → + Add → Workers AI，Variable name 必须填 <b>AI</b>，保存后 Deploy。绑定后 MyMemory 限流时自动兜底。</span></div>
        <div class="kv"><b>在哪儿改</b><span><a href="https://dash.cloudflare.com/?to=/:account/workers" target="_blank" rel="noopener">Cloudflare → Workers &amp; Pages</a> → 选中你的 Worker → <b>Settings</b> → <b>Variables and Secrets</b>。仓库 Secrets（自动部署用）在 <a href="https://github.com/xiaoh2018/github-rank/settings/secrets/actions" target="_blank" rel="noopener">GitHub 仓库 → Settings → Secrets and variables → Actions</a>。</span></div>
      </div>
    </section>

    <section class="pane" id="pane-translate" hidden>
      <div class="bar">
        <div><h1>翻译</h1><p class="sub">看链路状态、实测一次；邮箱和额度在「设置与密钥」里改</p></div>
        <div class="bar-actions"><a class="btn" href="#keys" data-goto="keys">去设置与密钥</a></div>
      </div>
      <p class="intro">翻译顺序：<b>先查译文缓存</b>（同一段英文只翻一次，不重复花额度）→ <b>MyMemory</b>（免费、不需要 Key）→ <b>Workers AI</b>（需要在 Cloudflare 绑定，变量名必须是 <b>AI</b>）。长文本按句子切块逐段翻，失败原因会分类显示（网络不通 / 额度用完 / 服务端报错 / 未绑定）。</p>
      <div class="card">
        <div class="card-head"><div><h2>实测一次</h2><p class="desc">拿一段英文同时打两条链路，看谁给出结果、各花多少毫秒。</p></div></div>
        <label for="trText">英文原文</label>
        <textarea id="trText" maxlength="400" spellcheck="false">A fast, static GitHub trending board built on Cloudflare Workers.</textarea>
        <div class="hint">400 字以内；留空会用默认示例句。</div>
        <div class="actions"><button type="button" id="trRun">开始实测</button><span class="msg" id="trNote"></span></div>
        <div id="trOut"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>为什么有时候还是英文</h2></div></div>
        <div class="kv"><b>额度用完</b><span>MyMemory 按邮箱计额，一个邮箱用尽会换下一个；全用完且没绑 Workers AI 时，会先显示英文，等第二天恢复。</span></div>
        <div class="kv"><b>刚到的新仓库</b><span>仓库简介第一次被抓到时没有译文，自动翻译要一两秒，后台开「翻译 → 实测一次」能立刻看到哪条链路可用。</span></div>
        <div class="kv"><b>译文缓存</b><span>同一段英文只翻一次，命中缓存时不会产生任何调用，所以第二次几乎立刻变中文。</span></div>
      </div>
    </section>


    <section class="pane" id="pane-layout" hidden>
        <div class="bar"><div><h1>榜单布局</h1><div class="sub">榜单几列、侧栏放哪、开发者 / 组织榜怎么排、文章页要不要侧栏</div></div></div>
        <div class="intro">这四项都只影响排版，不影响数据。保存后刷新首页 / 文章页立刻生效；移动端一律单列，避免挤成一条。</div>
        <div class="card">
          <div class="card-head"><div><h2>榜单列数</h2><p class="desc">项目榜、开发者榜、组织榜都用这一档。</p></div></div>
          <div class="choice-grid">
            <label class="choice"><input type="radio" name="layout-mode" value="auto"><span class="lp lp-hint"><i></i><i></i></span><span class="choice-t">自动<b>随屏幕宽度</b></span></label>
            <label class="choice"><input type="radio" name="layout-mode" value="single"><span class="lp lp1"><i></i></span><span class="choice-t">单列<b>一行一个</b></span></label>
            <label class="choice"><input type="radio" name="layout-mode" value="double"><span class="lp lp2"><i></i><i></i></span><span class="choice-t">双列<b>900px 以上两栏</b></span></label>
            <label class="choice"><input type="radio" name="layout-mode" value="triple"><span class="lp lp3"><i></i><i></i><i></i></span><span class="choice-t">三列<b>1280px 以上三栏</b></span></label>
          </div>
          <h2 style="margin-top:26px">侧栏位置</h2>
          <p class="desc">语言分布、项目最多的作者 / 组织、榜单变化这三块放哪。</p>
          <div class="choice-grid">
            <label class="choice"><input type="radio" name="layout-side" value="right"><span class="choice-t">右侧<b>桌面常见</b></span></label>
            <label class="choice"><input type="radio" name="layout-side" value="below"><span class="choice-t">榜单下方<b>整行铺开、可并排</b></span></label>
          </div>
          <h2 style="margin-top:26px">开发者 / 组织榜列数</h2>
          <p class="desc">只影响「开发者榜」「组织榜」两个视图；侧栏放下方时差别最明显。</p>
          <div class="choice-grid">
            <label class="choice"><input type="radio" name="layout-users" value="auto"><span class="choice-t">跟榜单一致<b>默认</b></span></label>
            <label class="choice"><input type="radio" name="layout-users" value="single"><span class="lp lp1"><i></i></span><span class="choice-t">单列</span></label>
            <label class="choice"><input type="radio" name="layout-users" value="double"><span class="lp lp2"><i></i><i></i></span><span class="choice-t">双列</span></label>
            <label class="choice"><input type="radio" name="layout-users" value="triple"><span class="lp lp3"><i></i><i></i><i></i></span><span class="choice-t">三列<b>1280px 以上三栏</b></span></label>
          </div>
          <h2 style="margin-top:26px">文章页侧栏</h2>
          <p class="desc">文章页（/articles）是博客式排版：默认左侧文章列表、右侧关于站点与分类。这里决定侧栏放哪。</p>
          <div class="choice-grid">
            <label class="choice"><input type="radio" name="layout-articleSide" value="right"><span class="choice-t">右侧<b>默认</b></span></label>
            <label class="choice"><input type="radio" name="layout-articleSide" value="left"><span class="choice-t">左侧</span></label>
            <label class="choice"><input type="radio" name="layout-articleSide" value="none"><span class="choice-t">不要侧栏<b>整行通栏</b></span></label>
          </div>
          <div class="actions"><button type="button" data-save="layout">保存榜单布局</button></div>
        </div>
      </section>

  <section class="pane" id="pane-contact" hidden>
      <div class="bar"><div><h1>联系方式</h1><div class="sub">让访客找到你</div></div></div>
      <div class="intro">用来展示微信、邮箱或二维码，方便访客联系你。全部留空或关闭开关时不显示。「悬浮按钮」不单独设置：它跟随本页的「显示联系方式」开关，打开后站点上会出现悬浮的联系入口（需站点页面支持）。</div>
      <div class="card">
        <label class="toggle"><input type="checkbox" id="contact-enabled">显示联系方式（同时控制悬浮按钮）</label>
        <label for="contact-title">标题</label>
        <input type="text" id="contact-title" maxlength="20" placeholder="联系我">
        <div class="hint">弹窗或卡片顶部显示的文字，20 字以内。</div>
        <label for="contact-wechat">微信号</label>
        <input type="text" id="contact-wechat" maxlength="60" placeholder="例如 your_wechat">
        <div class="hint">直接填写微信号；不想公开就留空，改用二维码或邮箱。</div>
        <label for="contact-qrUrl">二维码图片地址</label>
        <input type="url" id="contact-qrUrl" maxlength="300" placeholder="https://…">
        <div class="hint">把二维码图片上传到图床后粘贴图片的 https 网址。没有就留空。</div>
        <div class="qrprev" id="contactQrPrev" hidden>
          <img id="contactQrImg" alt="二维码预览">
          <div><b>访客看到的就是这张</b><div class="hint" style="margin:2px 0 0">建议正方形、≥300×300；白底更清楚。</div></div>
        </div>
        <label for="contact-email">邮箱</label>
        <input type="text" id="contact-email" maxlength="120" placeholder="you@example.com">
        <div class="hint">用于接收合作或反馈，可留空。</div>
        <label for="contact-note">说明</label>
        <input type="text" id="contact-note" maxlength="200" placeholder="例如：合作请备注来意">
        <div class="hint">显示在联系方式下方的一句话，200 字以内。</div>
        <div class="actions"><button type="button" data-save="contact">保存联系方式</button></div>
      </div>
    </section>

    <section class="pane" id="pane-beian" hidden>
      <div class="bar"><div><h1>备案信息</h1><div class="sub">网站底部的备案号</div></div></div>
      <div class="intro">国内服务器的网站需要备案号，并在页脚展示。没有备案号就关闭开关，页脚不会显示备案信息；打开开关但字段为空，页脚会只显示底部文字。</div>
      <div class="card">
        <label class="toggle"><input type="checkbox" id="beian-enabled">在页脚显示备案信息</label>
        <label for="beian-icp">ICP 备案号</label>
        <input type="text" id="beian-icp" maxlength="60" placeholder="京ICP备12345678号">
        <div class="hint">形如 京ICP备12345678号，没有就留空并关闭开关。</div>
        <label for="beian-icpUrl">ICP 备案链接</label>
        <input type="url" id="beian-icpUrl" maxlength="300" placeholder="https://beian.miit.gov.cn/">
        <div class="hint">点击备案号跳转的网址，默认是工信部查询页，一般不用改。</div>
        <label for="beian-police">公安备案号</label>
        <input type="text" id="beian-police" maxlength="60" placeholder="京公网安备 11010202000000号">
        <div class="hint">公安备案号，没有就留空。</div>
        <label for="beian-policeUrl">公安备案链接</label>
        <input type="url" id="beian-policeUrl" maxlength="300" placeholder="https://www.beian.gov.cn/">
        <div class="hint">点击公安备案号跳转的网址，可留空。</div>
        <label for="beian-text">底部文字</label>
        <input type="text" id="beian-text" maxlength="200" placeholder="© 2026 你的网站名">
        <div class="hint">版权或其他说明，200 字以内，可留空。</div>
        <div class="actions"><button type="button" data-save="beian">保存备案信息</button></div>
      </div>
    </section>

    <section class="pane" id="pane-nav" hidden>
      <div class="bar"><div><h1>导航页</h1><div class="sub">前台顶部「导航」标签里的分类与站点卡片</div></div>
        <div class="row-actions"><button type="button" class="ghost" id="navImport">批量导入</button><button type="button" id="navAddGroup">＋ 分类</button></div></div>
      <div class="intro">分类 + 站点，前台按卡片排（每个分类一块）。填了网址可以点「自动获取」把标题、描述、图标抓回来；抓不到就手填。最多 20 个分类、400 个站点，保存后前台立刻生效。</div>
      <div class="card nav-toolbar">
        <input type="search" id="navFilter" placeholder="筛选站点：名称 / 网址 / 描述">
        <span class="nav-stat" id="navStat">—</span>
      </div>
      <div id="navAdmin"><p class="empty">读取中…</p></div>
      <div class="card">
        <div class="actions"><button type="button" data-save="nav">保存导航页</button></div>
        <div class="hint" id="navMsg">写回 data/nav.json；保存后前台刷新即生效（Worker 会刷边缘缓存）。</div>
      </div>
    </section>

    <dialog id="navImpDlg">
      <h2>批量导入站点</h2>
      <p class="desc">每行一个，格式：<code>名称 | 网址 | 描述 | 图标(可空)</code>，也支持 Tab 分隔。会导入到<b>第一个分类</b>，导入完记得点保存。</p>
      <textarea class="code" id="navImpText" rows="10" placeholder="GitHub | https://github.com | 全球最大代码托管平台&#10;MDN | https://developer.mozilla.org | Web 开发文档"></textarea>
      <div class="row" style="margin-top:8px;align-items:center">
        <input type="file" id="navImpFile" accept=".txt,.csv,text/plain,text/csv" aria-label="选择要导入的 txt 或 csv 文件" style="max-width:330px">
        <span class="hint" style="margin:0">或者选一个 .txt / .csv 文件（每行一个站点，列用 | 或 Tab 分隔）</span>
      </div>
      <div class="actions"><button type="button" class="ghost" id="navImpCancel">取消</button><button type="button" id="navImpGo">导入</button></div>
    </dialog>

        <dialog id="adPrevDlg" class="wide">
      <div class="dlg-head"><b>广告预览</b><div class="dlg-head-actions"><button type="button" class="ghost small" id="adPrevX">关闭</button></div></div>
      <div class="art-col"><div class="ad-prev-wrap" id="adPrevBody"></div></div>
    </dialog>
    <section class="pane" id="pane-submit" hidden>
      <div class="bar">
        <div><h1>收录与平台</h1><p class="sub">把新榜单和文章主动告诉搜索引擎与大模型</p></div>
        <div class="bar-actions"><label class="toggle inline"><input type="checkbox" id="subForce"> 强制再推一次</label><button class="btn ghost" type="button" id="subTest">试推 1 条</button><button class="btn ghost" type="button" id="subRunIN">只推 IndexNow</button><button class="btn ghost" type="button" id="subRunBD">只推百度</button><button class="btn primary" type="button" id="subRun">全部提交</button></div>
      </div>
              <div class="segtabs" data-group="seogeo"><button type="button" class="is-on" data-go="seo">SEO 基础</button><button type="button" data-go="qa">问答（GEO）</button><button type="button" data-go="submit">收录与平台</button></div>
      <p class="intro">提交走 IndexNow（Bing、Yandex、Seznam 共用）和百度主动推送；豆包、通义千问、ChatGPT 这些没有公开的收录接口，靠 robots.txt 放行 + llms.txt + 站点地图被爬到。<b>建议每天点一次，或者交给 Actions 定时。</b></p>
      <div class="card">
        <div class="card-head"><div><h2>GEO 平台清单：每个平台怎么弄</h2><p class="desc">国内 AI 搜索没有「提交就被引用」的直通车——它们各自接的是某家搜索索引。下面是逐个平台的入口、要填的参数、能不能一键。</p></div></div>
        <table class="geo-plat">
          <thead><tr><th>平台 / 索引</th><th>要做什么</th><th>要填的参数</th><th>能一键吗</th></tr></thead>
          <tbody>
            <tr><td><b>Bing / IndexNow</b><br><span class="desc">DeepSeek、Kimi、秘塔的联网搜索多半吃必应索引</span></td><td>后台「立即提交」已经调 IndexNow 推送；再到 Bing Webmaster Tools 加站点、提交 sitemap</td><td>IndexNow Key（自动生成，见上方状态）<br>站点：<code>https://github.661026.xyz</code></td><td>推送可一键；Bing 后台加站点需登录一次</td></tr>
            <tr><td><b>百度 / 文心</b></td><td>在「设置与密钥」填准入密钥 → 后台「立即提交」自动推普通收录（每日配额）</td><td>准入密钥（ziyuan.baidu.com → 普通收录 → API 提交）</td><td>可一键</td></tr>
            <tr><td><b>字节 / 豆包</b><br><span class="desc">吃 <code>Bytespider</code> 爬虫 + 头条生态</span></td><td>① robots 已放行 Bytespider ② 到字节搜索资源平台加站点、提交 sitemap ③ 发头条号文章并回链</td><td>验证码（HTML 标签形式，填到下面「平台验证码」卡里，我这页会注入 head）</td><td>验证码注入可一键；平台加站点需登录一次</td></tr>
            <tr><td><b>搜狗 / 腾讯元宝</b></td><td>搜狗站长平台加站点 + 提交 sitemap；元宝还会吃公众号内容 → 发公众号文章带回链</td><td>搜狗验证码（同上，可自动注入）</td><td>验证码注入可一键</td></tr>
            <tr><td><b>夸克 / 通义千问</b></td><td>神马搜索站长平台（zhanzhang.sm.cn）加站点 + sitemap 提交</td><td>神马验证码（可自动注入）</td><td>验证码注入可一键</td></tr>
            <tr><td><b>Google</b></td><td>Search Console 加资源、提交 sitemap</td><td>无需本站参数</td><td>手动（需登录）</td></tr>
          </tbody>
        </table>
        <div class="copybox"><input id="geoSm" value="https://github.661026.xyz/sitemap.xml" aria-label="站点地图地址" readonly><button type="button" class="ghost" data-copy="geoSm">复制 sitemap 地址</button></div>
        <div class="copybox"><input id="geoLlms" value="https://github.661026.xyz/llms.txt" aria-label="llms.txt 地址" readonly><button type="button" class="ghost" data-copy="geoLlms">复制 llms.txt</button></div>
        <div class="hint">把这两个地址贴到各平台的「sitemap 提交」框里即可；验证码填到下面「平台验证码」卡，保存后前台 head 会自动带上对应的 meta 标签。</div>
      </div>
      <div class="card">
        <div class="card-head"><b>当前状态</b><button class="btn sm" type="button" id="subReload">刷新</button></div>
        <div id="subStatus"><p class="empty">读取中…</p></div>
      </div>
      <div class="card">
        <div class="card-head"><b>提交结果</b></div>
        <div id="subOut"><p class="empty">还没有在本次会话里提交过。上次结果会显示在「当前状态」里；点右上角「全部提交」可立即推一次。</p></div>
      </div>
      <div class="card">
        <div class="card-head"><b>IndexNow 一直失败？照这三步查</b></div>
        <ol class="steps">
          <li>先看上面「IndexNow key」那行的 <b>key 文件</b>能不能直接在浏览器打开。能打开应该只显示一串字符；打不开（404）说明 Worker 还是旧版 —— 这个路由是新加的，部署一次就好了。</li>
          <li>能打开但提交仍失败：多半是 <b>域名对不上</b>。IndexNow 要求提交的 host 与 keyLocation 同域，请把「SEO 与 GEO → 站点地址」写成真实访问域名 <code>https://github.661026.xyz</code>，不要用 workers.dev 备用域名。</li>
          <li>手工入口：<a href="https://www.bing.com/webmasters/indexnow" target="_blank" rel="noopener">Bing Webmaster → IndexNow</a>（Bing / Yandex / Seznam / Naver 共用），规范见 <a href="https://www.indexnow.org/documentation" target="_blank" rel="noopener">indexnow.org</a>；本质就是把 URL 列表 POST 到 <code>https://api.indexnow.org/indexnow</code>，本站的「立即提交」替你做这一步。</li>
        </ol>
      </div>
      <div class="card">
        <div class="card-head"><b>百度准入密钥在哪拿</b></div>
        <ol class="steps">
          <li>打开 <a href="https://ziyuan.baidu.com/site/index" target="_blank" rel="noopener">百度搜索资源平台 → 站点管理</a>，确认 <code>github.661026.xyz</code> 已验证（HTML 验证的 meta 本站已内置）。</li>
          <li>左侧 <a href="https://ziyuan.baidu.com/dailysubmit/index" target="_blank" rel="noopener">普通收录 → API 提交</a>，页面上「准入密钥」那一串就是 <code>BAIDU_TOKEN</code>。</li>
          <li>粘到 <a href="#translate" data-goto="translate">翻译与密钥 → 运行设置 → 百度准入密钥</a>，保存后回本页点「立即提交」，结果里会显示百度返回的 <code>success</code> 与 <code>remain</code>。</li>
        </ol>
      </div>
      <div class="card">
        <div class="card-head"><b>配好之后放在哪（Cloudflare 变量）</b></div>
        <ol class="steps">
          <li>打开 <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">dash.cloudflare.com</a> → 左侧 <b>Workers &amp; Pages</b> → 点站点用的那个 Worker。</li>
          <li>上方 <b>Settings</b> → <b>Variables and Secrets</b> → <b>+ Add</b>。</li>
          <li>Type 选 <b>Secret</b>，Name 填 <code>BAIDU_TOKEN</code>，Value 粘贴百度「准入密钥」→ <b>Deploy</b>。</li>
          <li>同样位置可加 <code>AI_DAILY_CAP</code>（默认 400）、<code>TRANSLATE_EMAILS</code>（多个邮箱逗号分隔）。</li>
          <li><code>CLOUDFLARE_API_TOKEN</code> / <code>CLOUDFLARE_ACCOUNT_ID</code> 不在这里，它们属于仓库 Secrets（给 GitHub Actions 自动部署用）。</li>
          <li>改完刷新本页，「百度推送」那一行会从「没配」变成「已配置」。</li>
        </ol>
      </div>
      <div class="card">
        <div class="card-head"><b>这些 Token 在哪拿</b></div>
        <div class="kv"><span class="kv-k">百度推送</span><span class="kv-v"><a href="https://ziyuan.baidu.com/dailysubmit/index" target="_blank" rel="noopener">百度搜索资源平台 → 数据引入 → 普通收录 → API 提交</a>，准入密钥就是 <code>BAIDU_TOKEN</code></span></div>
        <div class="kv"><span class="kv-k">IndexNow</span><span class="kv-v"><a href="https://www.bing.com/webmasters/indexnow" target="_blank" rel="noopener">Bing Webmaster → IndexNow</a>，key 由本站自动生成，不用申请</span></div>
        <div class="kv"><span class="kv-k">Google</span><span class="kv-v"><a href="https://search.google.com/search-console" target="_blank" rel="noopener">Search Console</a> → 站点地图 → 提交 sitemap.xml</span></div>
        <div class="kv"><span class="kv-k">Cloudflare Token</span><span class="kv-v"><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">API Tokens</a> → 模板「编辑 Cloudflare Workers」→ 权限 Account·Workers Scripts·Edit + Zone·Workers Routes·Edit</span></div>
        <div class="kv"><span class="kv-k">Account ID</span><span class="kv-v"><a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">Cloudflare 首页</a>右侧栏「账户 ID」</span></div>
        <div class="kv"><span class="kv-k">存在哪</span><span class="kv-v"><a href="https://github.com/xiaoh2018/github-rank/settings/secrets/actions" target="_blank" rel="noopener">仓库 Settings → Secrets → Actions</a> 加 <code>CLOUDFLARE_API_TOKEN</code>、<code>CLOUDFLARE_ACCOUNT_ID</code>、<code>BAIDU_TOKEN</code></span></div>
      </div>
    </section>
<section class="pane" id="pane-seo" hidden>
      <div class="bar"><div><h1>SEO 与 GEO</h1><div class="sub">搜索结果、分享卡片，以及给 AI 搜索看的摘要与问答</div></div></div>
        <div class="segtabs" data-group="seogeo"><button type="button" class="is-on" data-go="seo">SEO 基础</button><button type="button" data-go="qa">问答（GEO）</button><button type="button" data-go="submit">收录与平台</button></div>
      <div class="intro">上半部分写进标题和 meta 标签，决定搜索结果与微信、微博分享卡片的样子；下半部分是给 AI 搜索（ChatGPT、Perplexity 等）看的摘要和问答。两块都在同一个标签里，保存后刷新首页立刻生效（浏览器若还留着旧页面，Ctrl+F5 一次即可）。</div>
      <div class="card">
        <label for="seo-siteName">站点名称</label>
        <input type="text" id="seo-siteName" maxlength="60" placeholder="GitHub 项目排行榜">
        <div class="hint">网站的名字，会出现在分享卡片和浏览器标签上，60 字以内。</div>
        <label for="seo-title">页面标题</label>
        <input type="text" id="seo-title" maxlength="100" placeholder="GitHub 热门项目排行榜">
        <div class="hint">建议 30 字以内，把最核心的关键词放在前面。</div>
        <label for="seo-description">页面描述</label>
        <textarea id="seo-description" maxlength="300" placeholder="每周自动更新 GitHub 热门开源项目的 Star 数、增长和分类……"></textarea>
        <div class="hint">建议 80–120 字，说清楚网站是什么、有什么价值，搜索结果里会显示这段话。</div>
        <label for="seo-keywords">关键词</label>
        <input type="text" id="seo-keywords" maxlength="300" placeholder="GitHub, 开源项目, 排行榜">
        <div class="hint">3–8 个词，用英文逗号分隔。现在对搜索排名影响较小，可以留空。</div>
        <label for="seo-ogImage">分享图地址</label>
        <input type="url" id="seo-ogImage" maxlength="300" placeholder="https://…/cover.png">
        <div class="hint">建议 1200×630 的图片网址，以 https 开头。留空则分享时不带图片。</div>
        <label for="seo-siteUrl">站点网址</label>
        <input type="url" id="seo-siteUrl" maxlength="300" placeholder="https://example.com">
        <div class="hint">填完整的 https 网址，末尾不带斜杠。用于规范链接（canonical）和站点地图，填错会影响收录。</div>
        <div class="actions"><button type="button" data-save="seo">保存 SEO 设置</button></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>搜索结果长这样</h2><p class="desc">左边填的东西会决定这段预览。蓝色是标题（60 字内不截断），绿色是网址，灰色是描述（160 字内不截断）。</p></div></div>
        <div class="serp">
          <div class="serp-t" id="serpTitle">GitHub 热门项目排行榜</div>
          <div class="serp-u" id="serpUrl">github.661026.xyz</div>
          <div class="serp-d" id="serpDesc">（这里会显示页面描述，建议 80–120 字）</div>
        </div>
        <div class="cnow" id="serpTitleCnt">—</div>
        <div class="cnow" id="serpDescCnt">—</div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>GEO 摘要</h2><p class="desc">2–3 句话说清网站是什么、收录了什么、多久更新一次，AI 搜索更容易引用。</p></div></div>
        <textarea id="geo-summary" maxlength="500" placeholder="本站每 3 小时自动抓取 GitHub 热门开源项目，按星标数、今日增量、语言分类整理成排行榜……"></textarea>
        <div class="hint">500 字以内。</div>
        <h2 style="margin-top:22px">常见问答</h2>
        <p class="desc">写访客最常问的问题和简短回答，最多 20 条。</p>
        <div id="faqList"></div>
        <div class="actions">
          <button type="button" class="ghost" id="faqAdd">新增一条</button>
          <button type="button" data-save="geo">保存 GEO 设置</button>
        </div>
      </div>
    </section>

      <section class="pane" id="pane-qa" hidden>
        <div class="bar"><div><h1>问答（GEO）</h1><p class="sub">访客最常问的问题与答案。前台在 <code>/faq</code> 展示，并把 FAQPage 结构化数据写进页面 head，搜索引擎和 AI 检索器读源码就能拿到。</p></div><div class="actions"><button type="button" class="ghost" id="qaNew">＋ 新问题</button></div></div>
        <div class="segtabs" data-group="seogeo"><button type="button" class="is-on" data-go="seo">SEO 基础</button><button type="button" data-go="qa">问答（GEO）</button><button type="button" data-go="submit">收录与平台</button></div>
        <div class="intro">答案支持 Markdown（标题、列表、表格、代码块）。写法建议：第一句先给结论，再补细节和数字——AI 搜索最容易抽取这种结构。最多 200 条。</div>
        <div class="card">
          <label for="qa-intro">页面导语</label>
          <textarea id="qa-intro" maxlength="600" placeholder="这里整理了关于本站的高频问题：数据从哪来、多久更新、怎么收录、密码怎么拿……"></textarea>
          <div class="hint">600 字以内，显示在问答页顶部。</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>问答列表</h2><p class="desc">问题 ≤200 字、答案 ≤4000 字；标签用来分类（如「数据」「使用」「收录」）。用 ↑↓ 调顺序，前台和 llms.txt 都按这个顺序。</p></div></div>
          <div class="toolbar" style="margin:0 0 10px"><input type="search" id="qaFilter" placeholder="筛问题 / 标签 / 答案里的关键词" autocomplete="off"><select id="qaTagFilter" aria-label="按标签筛问题" style="max-width:150px"><option value="">全部标签</option></select><span class="note" id="qaMsg"></span></div>
          <div id="qaList"></div>
          <div class="actions"><button type="button" data-save="qa">保存问答</button><span class="hint" id="qaSaveMsg"></span></div>
        </div>
      </section>
    <section class="pane" id="pane-theme" hidden>
      <div class="bar">
        <div><h1>主题</h1><div class="sub">给整站换一套配色：默认暖纸白，也可切冷色深色或更亮的白</div></div>
        <button type="button" data-save="theme">保存主题</button>
      </div>
      <div class="intro">四种主题都内置在页面里，切换只改 CSS 变量，不重新加载、不影响数据。关掉「允许访客自己切换」后，前台只按这里选的显示。</div>
      <div class="card">
        <div class="card-head"><b>配色</b><span class="msg">点一下选中，再点右上「保存主题」</span></div>
        <div class="choice-grid">
          <label class="choice"><input type="radio" name="theme-name" value="paper" checked><span class="sw"><i style="background:#fffbf3"></i><i style="background:#e6dcc4"></i><i style="background:#b8860b"></i></span><span class="choice-t">暖纸白<em>当前默认：米白底 + 金棕强调，最像纸质笔记</em></span></label>
          <label class="choice"><input type="radio" name="theme-name" value="ink"><span class="sw"><i style="background:#0b0d11"></i><i style="background:#1b1f27"></i><i style="background:#6366f1"></i></span><span class="choice-t">Linear 冷暗<em>近黑底 + 靛蓝强调，信息密度高、偏工程师审美</em></span></label>
          <label class="choice"><input type="radio" name="theme-name" value="stripe"><span class="sw"><i style="background:#ffffff"></i><i style="background:#f1f2f6"></i><i style="background:#635bff"></i></span><span class="choice-t">Stripe 亮白<em>纯白底 + 靛紫强调，最干净，适合白天看</em></span></label>
          <label class="choice"><input type="radio" name="theme-name" value="notion"><span class="sw"><i style="background:#f7f6f3"></i><i style="background:#e8e6e1"></i><i style="background:#37352f"></i></span><span class="choice-t">Notion 柔灰<em>浅灰底 + 深墨字，长文阅读最舒服</em></span></label>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><b>访客</b></div>
        <label class="toggle"><input type="checkbox" id="theme-allow"> 允许访客在「设置」里自己选主题（关掉就只用上面的）</label>
      </div>
    </section>
    <section class="pane" id="pane-articles" hidden>
      <div class="bar">
        <div><h1>文章</h1><div class="sub">共 <span id="artCount">0</span> 篇，标题、摘要、正文会显示在站点的文章页</div></div>
        <div class="toolbar">
          <button type="button" class="ghost" id="artBulkDel" disabled>删除选中</button>
          <select id="artBulkCat" aria-label="批量改成哪个分类" style="max-width:170px"><option value="">改成分类…</option></select>
          <button type="button" class="ghost" id="artBulkApply" disabled>应用分类</button>
          <button type="button" class="ghost" id="artAllMatch">全选所有匹配</button>
          <select id="artSort" aria-label="文章排序方式" style="max-width:150px">
            <option value="date-desc">日期（新→旧）</option>
            <option value="date-asc">日期（旧→新）</option>
            <option value="title-asc">标题 A→Z</option>
            <option value="title-desc">标题 Z→A</option>
            <option value="category-asc">按分类</option>
          </select>
          <select id="artCatFilter" aria-label="按分类筛选文章" style="max-width:150px"><option value="">全部分类</option></select>
          <button type="button" class="ghost" id="artUndo" disabled>撤销上一步</button>
          <span class="msg" id="artSelNote" hidden></span>
        </div>
        <button type="button" id="artNew">写新文章</button>
      </div>
      <div class="intro">文章用来沉淀长内容：会被搜索引擎收录，也会被 AI 搜索引用。正文支持 Markdown（标题、列表、代码块、链接、图片），写作时右侧实时预览。保存即发布，刷新文章页即可看到。</div>
      <div class="card">
        <div class="card-head"><b>文章卡片列数</b><span class="msg">首页「最新文章」和文章页都按这个列数</span></div>
        <div class="hint">手机上一律单列，不受这里影响；选「自动」时按屏幕宽度铺满。</div>
        <div class="choice-grid">
          <label class="choice"><input type="radio" name="article-cols" value="auto"><span class="choice-t">自动<b>随屏幕宽度</b></span></label>
          <label class="choice"><input type="radio" name="article-cols" value="single"><span class="choice-t">单列<b>一行一篇</b></span></label>
          <label class="choice"><input type="radio" name="article-cols" value="double"><span class="choice-t">双列<b>桌面推荐</b></span></label>
          <label class="choice"><input type="radio" name="article-cols" value="triple"><span class="choice-t">三列<b>1280px 以上三栏</b></span></label>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><b>分类管理</b><span class="msg">英文词进网址，显示名给访客看</span></div>
        <div class="hint">网址永远是 <code>/articles/&lt;英文词&gt;/&lt;序号&gt;.html</code>（如 <code>/articles/tech/3.html</code>）。中文分类名只用来展示，不进链接。</div>
        <table class="cat-table">
          <thead><tr><th style="width:170px">英文词（进链接）</th><th style="width:190px">显示名</th><th>说明</th><th style="width:64px">操作</th></tr></thead>
          <tbody id="catTbody"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
        </table>
        <div class="toolbar"><button type="button" class="ghost" id="catAdd">＋ 新增分类</button><span class="msg">最多 30 个；改英文词会让老链接失效，慎改</span></div>
        <label class="toggle"><input type="checkbox" id="artCatEn"> 前台把分类显示成英文（关掉则显示显示名）</label>
      </div>
      <div class="card">
        <div class="card-head"><b>加密文章提示语</b><span class="msg">读者点开加密文章时看到的一句说明</span></div>
        <textarea id="artUnlockHint" maxlength="300" placeholder="例如：本文是内部笔记，密码在群里发；需要全文请在页面底部联系我。"></textarea>
        <div class="hint">留空则使用默认文案「这篇文章需要密码才能阅读…」。单篇文章也可以在写作弹窗里单独填，优先用单篇的。</div>
      </div>
      <div class="actions">
        <button type="button" data-save="article">保存文章设置</button>
        <span class="hint" id="artSaveMsg">改了分类或提示语记得点这里保存</span>
      </div>
      <div class="card">
        <div class="toolbar">
          <input type="text" id="artSearch" placeholder="搜索标题、摘要或正文…">
          <span class="msg" id="artSearchNote"></span>
        </div>
        <table>
          <thead><tr><th style="width:30px"><input type="checkbox" id="artAll" title="全选"></th><th style="width:96px">日期</th><th>标题</th><th>摘要</th><th style="width:170px">操作</th></tr></thead>
          <tbody id="artTbody"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody>
        </table>
        <div class="artpager" id="artPager" hidden></div>
      </div>
    </section>

  </main>
</div>
<button type="button" class="btn ghost cmdk-fab" id="cmdkFab" aria-label="快速跳转（Ctrl+K）" aria-keyshortcuts="Control+K" title="快速跳转（Ctrl+K）">⌘</button>
<dialog id="cmdk" class="cmdk" aria-label="快速跳转">
  <div class="ck-box">
    <input id="ckInput" type="search" placeholder="跳到面板…（↑↓ 选择，Enter 打开，Esc 关闭）" autocomplete="off">
    <div class="ck-list" id="ckList"></div>
    <div class="ck-foot" id="ckFoot">Ctrl/⌘ + K 或 / 随时打开</div>
  </div>
</dialog>
<dialog id="addDlg">
  <h2 id="addTitle">添加友链</h3>
  <p class="msg">名称和网址都会显示在排行榜页面上。</p>
  <label for="addName">名称</label>
  <input type="text" id="addName" maxlength="40" placeholder="例如：某某博客">
  <div class="hint">40 字以内。</div>
  <label for="addUrl">网址</label>
  <input type="url" id="addUrl" maxlength="300" placeholder="https://example.com">
  <div class="hint">必须以 http:// 或 https:// 开头。</div>
  <label for="addDesc">描述</label>
  <input type="text" id="addDesc" maxlength="80" placeholder="一句话介绍（可选）">
  <div class="hint">80 字以内，会显示在友链名称下面。</div>
  <div class="err" id="addErr"></div>
  <div class="actions"><button type="button" class="ghost" data-close="addDlg">取消</button><button type="button" id="addSubmit">添加</button></div>
</dialog>
<dialog id="delDlg">
  <h2 id="delTitle">确认删除</h2>
  <p class="msg" id="delNote"></p>
  <div class="err" id="delErr"></div>
  <div class="actions"><button type="button" class="ghost" data-close="delDlg">取消</button><button type="button" class="danger" id="delSubmit">确定删除</button></div>
</dialog>
<dialog id="artDlg" class="wide">
  <div class="dlg-head">
    <div><h2 id="artTitle">写新文章</h2><span class="dirt" id="artDirtyBadge" hidden>未保存</span><p class="msg">标题必填；日期留空默认今天；正文支持 Markdown，段落之间空一行。</p></div>
    <div class="dlg-head-actions">
      <button type="button" class="ghost small" id="artFullBtn" title="铺满窗口">⤢ 放大</button>
      <button type="button" class="ghost small" data-close="artDlg">关闭</button>
    </div>
    <div class="draft-bar" id="draftBar" hidden>
      <span id="draftText"></span>
      <button type="button" class="ghost small" id="draftRestore">恢复草稿</button>
      <button type="button" class="ghost small" id="draftDrop">丢弃</button>
    </div>
  </div>
  <div class="art-grid">
    <div class="art-col">
      <div class="field-row">
        <div><label for="artTitleIn">标题</label><input type="text" id="artTitleIn" maxlength="100" placeholder="例如：2026 年 11 月值得关注的 10 个项目"></div>
        <div><label for="artDate">日期</label><input type="date" id="artDate"></div>
      </div>
      <div class="field-row">
        <div><label for="artCategory">分类</label><input type="text" id="artCategory" maxlength="24" list="artCatList" placeholder="选已有分类，或直接写新的"><datalist id="artCatList"></datalist></div>
        <div><label for="artCat">链接（分类词/序号）</label>
          <span class="slugrow">
            <input id="artCat" maxlength="24" placeholder="分类词，如 tech">
            <span class="slug-sep">/</span>
            <input id="artSeq" maxlength="20" placeholder="序号，如 3（留空自动）">
            <button type="button" class="ghost small" id="artSlugGen">自动</button>
          </span>
        </div>
      </div>
      <div class="slugprev" id="artSlugPrev" aria-live="polite" style="margin:-2px 0 10px"></div>
      <label for="artCover">封面图</label>
      <input type="url" id="artCover" maxlength="300" placeholder="https://…（可选，16:9 横图最好，留空就不显示封面）">
      <div class="hint">建议 1200×675；放图床或仓库 raw 链接都行。</div>
      <label class="toggle inline"><input type="checkbox" id="artPinned"> 置顶这篇（排在列表最前面）</label>
      <label for="artSummary">摘要</label>
      <textarea id="artSummary" maxlength="300" style="min-height:74px" placeholder="一两句话说清这篇讲什么，会显示在列表里，也会被 AI 搜索引用。"></textarea>
      <div class="lockrow">
        <label class="toggle inline"><input type="checkbox" id="artLock"> 加密这篇（读者要输密码才能看）</label>
        <input type="password" id="artPw" maxlength="60" autocomplete="new-password" placeholder="访问密码，至少 4 位；编辑时留空 = 沿用原密码">

        <textarea id="artHint" maxlength="300" rows="2" placeholder="怎么拿到密码？例如：加微信 flyfish2026 回复「密码」；留空用站点默认提示"></textarea>
      </div>
      <div class="row-actions">
        <button type="button" class="ghost small" id="artImport">导入 .md</button>
        <button type="button" class="ghost small" id="artPreviewBtn">隐藏预览</button>
        <span class="msg" id="artLen"></span>
        <input type="file" id="artFile" aria-label="选择 Markdown 文件导入正文" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden>
      </div>
      <label for="artBody">正文（Markdown）</label>
      <textarea id="artBody" maxlength="20000" class="art-body" spellcheck="false"></textarea>
      <div class="hint">20000 字以内。支持标题、列表、表格、代码块、任务清单、删除线；图片写成 ![说明](图片网址)。直接粘 HTML 也可以，保存时会自动转成 Markdown。</div>
      <div class="err" id="artErr"></div>
      <div class="actions"><button type="button" class="ghost" data-close="artDlg">取消</button><button type="button" id="artSubmit">保存文章</button></div>
    </div>
    <div class="art-prev-col">
      <div class="art-prev-head">实时预览</div>
      <div id="artPrev" class="art-prev"><p class="empty">左边写正文，这里实时显示渲染效果</p></div>
    </div>
  </div>
</dialog>
<div class="toast" id="toast" role="status"></div>
<script src="/js/md.js?v=9"></script>

<script>
(function () {
  'use strict';
  var PW_KEY = 'adminPw';
  var TABS = ['overview', 'layout', 'theme', 'articles', 'qa', 'nav', 'seo', 'links', 'ad', 'contact', 'beian', 'submit', 'keys', 'translate'];
  var FIELDS = {
    ad: ['html'],
    article: ['unlockHint', 'catEn'],
    theme: ['name', 'allowUser'],
    layout: ['mode', 'side', 'users', 'articleSide'],
    contact: ['title', 'wechat', 'qrUrl', 'email', 'note'],
    beian: ['icp', 'icpUrl', 'police', 'policeUrl', 'text'],
    seo: ['siteName', 'title', 'description', 'keywords', 'ogImage', 'siteUrl'],
    geo: ['summary']
  };
  var pw = '';
  var state = { links: [], articles: [], faq: [], artPage: 1, artSel: new Set(), artFiltered: [], artSort: 'date-desc', artCat: '', artUndo: null };
  var editingId = null;
  var editingLocked = false;
  var confirmFn = null;

  function $(id) { return document.getElementById(id); }
  // 中文输入法：拼音未上屏时不要触发过滤
  function imeBind(el, fn) {
    if (!el) return;
    var composing = false;
    el.addEventListener('compositionstart', function () { composing = true; });
    el.addEventListener('compositionend', function () { composing = false; fn(); });
    el.addEventListener('input', function (ev) {
      if (composing || el.isComposing || (ev && ev.isComposing)) return;
      fn();
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg, ok) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (ok ? 'ok' : 'err');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }
  function api(path, opt) {
    opt = opt || {};
    var init = { method: opt.method || 'GET', headers: {}, cache: 'no-store' };
    if (opt.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opt.body);
    }
    return fetch(path, init)
      .then(function (r) {
        return r.json().catch(function () {
          return { ok: false, error: '服务器返回了非 JSON 内容（' + r.status + '）' };
        });
      })
      .catch(function () { return { ok: false, error: '网络错误，请稍后重试' }; });
  }
  function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }

  // ---- 登录 ----
  function enter() {
    $('gate').hidden = true;
    $('app').hidden = false;
    go(location.hash.slice(1));
    loadStatus();
    loadHealth();
    loadTodo();
    loadLinks();
    loadSite();
    loadArticles();
    loadNavAdmin();
    loadQa();
    loadSubmit();
    loadTranslate();
    }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('pw').value;
    if (!v) { $('loginErr').textContent = '请输入密码'; return; }
    $('loginBtn').disabled = true;
    api('/api/admin/check', { method: 'POST', body: { password: v } }).then(function (r) {
      $('loginBtn').disabled = false;
      if (r.ok) {
        pw = v;
        sessionStorage.setItem(PW_KEY, v);
        $('loginErr').textContent = '';
        enter();
      } else {
        $('loginErr').textContent = r.error || '密码不对';
      }
    });
  });

  // ---- 标签页 ----
  function showErr(msg) {
    var bar = document.getElementById('errBar');
    if (!bar) return;
    bar.hidden = false;
    bar.innerHTML = '<b>后台脚本出错了：</b><code>' + navEsc(msg) + '</code>　（把这条发给我，或刷新再试）';
  }
  window.addEventListener('error', function (e) {
    showErr((e && e.message ? e.message : '未知错误') + (e && e.lineno ? ' @行' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    showErr(r && r.message ? r.message : String(r || 'Promise 未处理的错误'));
  });

  function go(tab) {
    if (tab === 'keepalive') tab = 'overview';
    if (TABS.indexOf(tab) < 0) tab = 'overview';
    var missing = [];
    TABS.forEach(function (t) {
      var p = $('pane-' + t);
      if (!p) { missing.push(t); return; }
      p.hidden = t !== tab;
    });
    if (missing.length) showErr('这些面板在页面里找不到：' + missing.join('、') + '（后台版本和脚本不匹配，重新部署 worker.js 就好）');
    document.querySelectorAll('.nav').forEach(function (b) {
      b.setAttribute('aria-current', b.getAttribute('data-tab') === tab ? 'true' : 'false');
    });
    var curNav = document.querySelector('.nav[data-tab="' + tab + '"]');
    if (curNav && curNav.scrollIntoView) curNav.scrollIntoView({ block: 'nearest', inline: 'center' });
    history.replaceState(null, '', '#' + tab);
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.nav').forEach(function (b) {
    b.addEventListener('click', function () { go(b.getAttribute('data-tab')); });
  });

  // ---- 弹窗 ----
  var CK_NAMES = {
    overview: '概览', layout: '榜单布局', articles: '文章', nav: '导航页',
    seo: 'SEO 与 GEO', links: '友链', ad: '广告', contact: '联系方式',
    beian: '备案信息', submit: '收录提交', keys: '设置与密钥', translate: '翻译',
    qa: '问答', theme: '主题',
  };
  var ckItems = [], ckIndex = 0, ckOpen = false;

  function paintCmdk(q) {
    var box = $('ckList');
    if (!box) return;
    var list = TABS.filter(function (t) {
      var name = CK_NAMES[t] || t;
      var hit = !q || name.indexOf(q) >= 0 || t.indexOf(q.toLowerCase()) >= 0;
      return hit;
    });
    ckItems = list;
    if (ckIndex >= list.length) ckIndex = 0;
    box.innerHTML = list.map(function (t, i) {
      return '<div class="ck-item' + (i === ckIndex ? ' on' : '') + '" data-ck="' + t + '"><span>' + (CK_NAMES[t] || t) + '</span><small>' + t + '</small></div>';
    }).join('') || '<div class="ck-foot">没有匹配的面板</div>';
  }

  function closeCmdk() {
    var d = $('cmdk');
    if (!d) return;
    ckOpen = false;
    if (d.open) d.close();
  }

  function openCmdk() {
    var d = $('cmdk');
    if (!d) return;
    ckOpen = true;
    ckIndex = 0;
    if (!d.open) d.showModal();
    var inp = $('ckInput');
    var narrow = window.matchMedia('(max-width:760px)').matches;
    if (inp) {
      inp.value = '';
      inp.placeholder = narrow ? '搜面板名…' : '跳到面板…（↑↓ 选择，Enter 打开，Esc 关闭）';
      inp.focus();
    }
    var foot = $('ckFoot');
    if (foot) foot.textContent = narrow ? '点一下面板名就跳过去' : 'Ctrl/⌘ + K 或 / 随时打开';
    paintCmdk('');
  }

  function askConfirm(title, note, fn, okText) {
    $('delTitle').textContent = title;
    $('delNote').textContent = note;
    $('delErr').textContent = '';
    var okBtn = $('delSubmit');
    if (okBtn) {
      okBtn.textContent = okText || '确定删除';
      okBtn.className = (okText && okText !== '确定删除') ? 'primary' : 'danger';
    }
    confirmFn = fn;
    $('delDlg').showModal();
  }
  $('delSubmit').addEventListener('click', function () {
    if (!confirmFn) return;
    var btn = this;
    btn.disabled = true;
    confirmFn().then(function (r) {
      btn.disabled = false;
      if (r && r.ok) {
        $('delDlg').close();
      } else {
        $('delErr').textContent = (r && r.error) || '操作失败';
      }
    });
  });
  document.addEventListener('click', function (e) {
    var c = e.target.getAttribute && e.target.getAttribute('data-close');
    if (!c) return;
    if (c === 'artDlg' && artDirty) { artAskDiscard(); return; }
    $(c).close();
  });

  // ---- 概览：保活状态 ----
  function healthRow(label, ok, text) {
    return '<div class="status-item"><span class="dot' + (ok ? ' ok' : ' bad') + '"></span><b>' + label + '</b><span>' + navEsc(text || '') + '</span></div>';
  }
  function loadHealth() {
    var box = $('healthBox');
    if (!box) return;
    box.innerHTML = '<div class="empty">加载中…</div>';
    api('/api/health').catch(function () { return null; }).then(function (h) {
      h = h || null;
      // 体检只发一个请求：/api/health 现在带 submit 与状态细节
      var sub = h && h.submit ? {
        keyFileOk: h.submit.keyFileOk,
        keyFileMatch: h.submit.keyFileMatch,
        keyFileNote: h.submit.keyFileNote,
        indexNowKey: h.submit.indexNowKey,
        indexKeySource: h.submit.indexKeySource,
        baiduToken: h.submit.baiduToken,
        baiduTokenSource: h.submit.baiduTokenSource,
        lastRun: h.submit.lastRun,
        cooldown: h.submit.cooldown,
        counts: h.counts,
        sitemap: location.origin + '/sitemap.xml'
      } : null;
      var ai = (h && h.ai) || null;
      var rows = [];
      var sm = (sub && sub.sitemap) || 'https://github.661026.xyz/sitemap.xml';
            var base = sm.indexOf('/sitemap.xml') > 0 ? sm.slice(0, sm.indexOf('/sitemap.xml')) : sm;
      rows.push(healthRow('站点地址', true, base));
      if (h) {
        rows.push(healthRow('Worker 版本', !!h.version, (h.version || '未知') + ' · 文章 ' + ((h.counts && h.counts.articles) || 0) + ' 篇 · key 文件 ' + (h.keyFileOk ? '可读' : '读不到')));
      }
      if (h && h.dataAge && typeof h.dataAge.minutes === 'number') {
        var minsAgo = h.dataAge.minutes;
        rows.push(healthRow('数据新鲜度', minsAgo <= 360, minsAgo < 60 ? (minsAgo + ' 分钟前抓取') : (Math.round(minsAgo / 60) + ' 小时前抓取 · 每 3 小时自动一次')));
      }
      rows.push(healthRow('key 文件', !!(sub && sub.keyFileOk), (sub && sub.keyFileOk) ? '能打开，内容' + (sub.keyFileMatch ? '与后台一致' : '与后台不一致（会被 422 拒绝）') : ((sub && sub.keyFileNote) || '打不开')));
      rows.push(healthRow('百度密钥', !!(sub && sub.baiduToken), sub && sub.baiduToken ? '已配置（来源 ' + (sub.baiduTokenSource || 'env') + '）' : '没配，百度推送会跳过'));
      rows.push(healthRow('IndexNow Key', !!(sub && sub.indexNowKey), (sub && sub.indexNowKey) ? '已生成，来源 ' + (sub.indexKeySource || 'derived') : '没生成'));
      var cnt = sub && sub.counts;
      if (cnt) {
        rows.push(healthRow('内容量', true, '文章 ' + (cnt.articles || 0) + ' 篇（分类 ' + (cnt.categories || 0) + ' 个）· 导航 ' + (cnt.navGroups || 0) + ' 组 / ' + (cnt.navSites || 0) + ' 站 · 问答 ' + (cnt.qa || 0) + ' 条 · 友链 ' + (cnt.links || 0) + ' 条'));
      }
      if (ai && typeof ai.used === 'number') {
        var lim = ai.unlimited ? '不限' : String(ai.cap);
        rows.push(healthRow('Workers AI 今日', ai.unlimited || ai.used < ai.cap, '已用 ' + ai.used + ' / ' + lim + (ai.unlimited ? '' : '（还剩 ' + ai.remaining + '）')));
      }
      rows.push(healthRow('上次提交', true, (sub && sub.lastRun && sub.lastRun.at) ? new Date(sub.lastRun.at).toLocaleString() : '还没提交过'));
      rows.push(healthRow('冷却', !(sub && sub.cooldown && sub.cooldown.seconds > 0), (sub && sub.cooldown && sub.cooldown.seconds > 0) ? '还要等 ' + sub.cooldown.seconds + ' 秒' : '可以提交'));
      if (h && h.workflow && h.workflow.conclusion) {
        rows.push(healthRow('数据抓取', h.workflow.conclusion === 'success', (h.workflow.conclusion === 'success' ? '上次成功' : '上次失败') + (h.workflow.time ? ' · ' + h.workflow.time : '')));
      }
      var bad = [];
      if (sub && sub.keyFileOk === false) bad.push('key 文件打不开（' + String((sub && sub.keyFileNote) || '').slice(0, 60) + '）');
      if (sub && sub.keyFileOk && sub.keyFileMatch === false) bad.push('key 文件内容与后台不一致，IndexNow 会被 422 拒绝');
      if (sub && !sub.baiduToken) bad.push('没配百度准入密钥，百度推送会被跳过');
      if (h && h.workflow && h.workflow.conclusion && h.workflow.conclusion !== 'success') bad.push('最近一次数据抓取失败（' + h.workflow.time + '），去 Actions 看日志');
      if (ai && !ai.unlimited && typeof ai.used === 'number' && ai.used >= ai.cap) bad.push('Workers AI 今日额度已用完，翻译会退回 MyMemory');
      var bar = $('healthBar');
      if (bar) {
        if (bad.length) { bar.hidden = false; bar.textContent = '体检有 ' + bad.length + ' 项要处理：' + bad.join('；'); }
        else { bar.hidden = true; bar.textContent = ''; }
      }
      box.innerHTML = rows.join('');
    }).catch(function () {
      box.innerHTML = '<div class="empty">体检数据没取到，点「刷新体检」再试。</div>';
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b) return;
    var url = b.getAttribute('data-copy');
    var done = function () { toast('已复制 ' + url); };
    var fail = function () { toast('复制失败，请手动选中：' + url); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(fail);
    else fail();
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('#healthReload')) loadHealth();
    if (e.target.closest('#todoReload')) loadTodo();
  });

  function loadStatus() {
    $('stState').textContent = '读取中…';
    api('/api/status').then(function (s) {
      if (!s.configured) {
        $('stDot').className = 'dot bad';
        $('stState').textContent = '未配置';
        $('stNote').textContent = s.error || '';
        return;
      }
      $('stDot').className = 'dot ' + (s.level || '');
      $('stState').textContent = s.stateText || '';
      $('stNote').textContent = (s.stateNote || '') + (s.workflowError ? '（' + s.workflowError + '）' : '');
      $('stLast').textContent = s.lastKeepalive || '—';
      $('stAge').textContent = s.age == null ? '—' : s.age + ' 天前';
      $('stNext').textContent = s.next || '—';
      $('stWf').textContent = s.workflow ? s.workflow.time + ' · ' + (s.workflow.conclusion || s.workflow.status) : '—';
      $('stErr').textContent = '';
    });
  }
  $('refreshBtn').addEventListener('click', loadStatus);
  $('keepBtn').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = '保活中…';
    api('/api/run', { method: 'POST', body: { password: pw } }).then(function (r) {
      btn.disabled = false;
      btn.textContent = '立即保活一次';
      if (r.ok) {
        toast('保活成功，已写入 ' + r.time, true);
        loadStatus();
      } else {
        $('stErr').textContent = r.error || '保活失败';
        toast(r.error || '保活失败', false);
      }
    });
  });

  // ---- 友链 ----
  function renderLinks() {
    $('linkCount').textContent = state.links.length;
    var b = $('linkBody');
    if (!state.links.length) {
      b.innerHTML = '<tr><td colspan="4"><div class="empty-card" role="status"><b>还没有友链</b><p>友链会显示在首页底部，建议 4–12 个、每个带一句描述。</p><button type="button" class="btn" data-empty-act="link-add">添加友链</button></div></td></tr>';
      return;
    }
    b.innerHTML = state.links.map(function (l, i) {
      return '<tr><td>' + esc(l.name) + '</td>' +
        '<td><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.url) + '</a></td>' +
        '<td class="muted-cell">' + esc(l.desc || '—') + '</td>' +
        '<td class="row-actions"><button type="button" class="ghost small" data-up="' + i + '" title="上移"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="ghost small" data-down="' + i + '" title="下移"' + (i === state.links.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="ghost small" data-edit="' + i + '">编辑</button>' +
        '<button type="button" class="danger small" data-del="' + i + '">删除</button></td></tr>';
    }).join('');
  }
  function loadLinks() {
    api('/api/links').then(function (r) {
      if (!r.ok) {
        $('linkBody').innerHTML = '<tr><td colspan="3" class="empty">' + esc(r.error) + '</td></tr>';
        return;
      }
      state.links = r.links || [];
      renderLinks();
    });
  }
  var linkEdit = -1;
  function openLinkDlg(i) {
    linkEdit = typeof i === 'number' ? i : -1;
    var cur = linkEdit >= 0 && state.links[linkEdit] ? state.links[linkEdit] : { name: '', url: '', desc: '' };
    $('addName').value = cur.name || '';
    $('addUrl').value = cur.url || '';
    if ($('addDesc')) $('addDesc').value = cur.desc || '';
    $('addErr').textContent = '';
    if ($('addTitle')) $('addTitle').textContent = linkEdit >= 0 ? '编辑友链' : '添加友链';
    if ($('addSubmit')) $('addSubmit').textContent = linkEdit >= 0 ? '保存' : '添加';
    $('addDlg').showModal();
  }
  $('addLinkBtn').addEventListener('click', function () { openLinkDlg(-1); });
  $('addSubmit').addEventListener('click', function () {
    var name = $('addName').value.trim();
    var url = $('addUrl').value.trim();
    if (!name) { $('addErr').textContent = '请填写名称'; return; }
    if (!/^https?:\\/\\//i.test(url)) { $('addErr').textContent = '网址必须以 http:// 或 https:// 开头'; return; }
    var btn = this;
    var payload = { password: pw, name: name, url: url, desc: $('addDesc') ? $('addDesc').value.trim() : '' };
    if (linkEdit >= 0) { payload.action = 'update'; payload.index = linkEdit; }
    else { payload.action = 'add'; }
    btn.disabled = true;
    api('/api/links', { method: 'POST', body: payload }).then(function (r) {
      btn.disabled = false;
      if (r.ok) {
        state.links = r.links;
        renderLinks();
        $('addDlg').close();
        toast(linkEdit >= 0 ? '已保存修改' : '已添加友链', true);
      } else {
        $('addErr').textContent = r.error || '保存失败';
      }
    });
  });
  $('linkBody').addEventListener('click', function (e) {
    var up = e.target.getAttribute && e.target.getAttribute('data-up');
    var down = e.target.getAttribute && e.target.getAttribute('data-down');
    if (up != null || down != null) {
      var from = Number(up != null ? up : down);
      var to = up != null ? from - 1 : from + 1;
      if (to < 0 || to >= state.links.length) return;
      api('/api/links', { method: 'POST', body: { password: pw, action: 'move', from: from, to: to } }).then(function (r) {
        if (r.ok) { state.links = r.links; renderLinks(); }
        else { toast(r.error || '移动失败'); }
      });
      return;
    }
    var ed = e.target.getAttribute && e.target.getAttribute('data-edit');
    if (ed != null) { openLinkDlg(Number(ed)); return; }
    var d = e.target.getAttribute && e.target.getAttribute('data-del');
    if (d == null) return;
    var i = Number(d);
    var name = state.links[i] ? state.links[i].name : '';
    askConfirm('删除友链', '会从首页友链里去掉「' + name + '」。删除不可撤销（要恢复就重新添加一次），保存即生效、刷新首页就能看到。', function () {
      return api('/api/links', { method: 'POST', body: { password: pw, action: 'remove', index: i } }).then(function (r) {
        if (r.ok) {
          state.links = r.links;
          renderLinks();
          paintDelMsg('#pane-links .bar', '已删除「' + name + '」· 已生效', false);
        }
        return r;
      });
    });
  });

  // ---- 站点配置：广告 / 联系方式 / 备案 / SEO / GEO ----
  function fillSite(s) {
    var a = s.ad || {}, c = s.contact || {}, b = s.beian || {}, o = s.seo || {}, g = s.geo || {};
    // 广告：每个槽位各自回填（开关 / 代码 / 间隔 / 跳转 / 弹窗）
    var adSlots = (a && a.slots && typeof a.slots === 'object') ? a.slots : null;
    Array.prototype.forEach.call(document.querySelectorAll('[data-ad-slot]'), function (el) {
      var id = el.getAttribute('data-ad-slot');
      var field = el.getAttribute('data-ad-field');
      var v = (adSlots && adSlots[id]) || null;
      if (!v && !adSlots && id === 'home-top') v = { enabled: a.enabled === true, html: a.html || '' };
      if (!v) v = {};
      if (field === 'enabled') el.checked = v.enabled === true;
      else if (field === 'every') el.value = v.every || el.getAttribute('value') || 1;
      else if (field === 'link') el.value = typeof v.link === 'string' ? v.link : '';
      else if (field === 'modal') el.value = typeof v.modal === 'string' ? v.modal : '';
      else el.value = typeof v.html === 'string' ? v.html : '';
    });
    var tk = a.ticker || {};
    $('ticker-enabled').checked = tk.enabled === true;
    $('ticker-text').value = typeof tk.text === 'string' ? tk.text : '';
    $('ticker-speed').value = tk.speed || 18;
    $('ticker-link').value = typeof tk.link === 'string' ? tk.link : '';
    $('ticker-modal').value = typeof tk.modal === 'string' ? tk.modal : '';
    var rt = s.runtime || {};
    if ($('rtEmails')) $('rtEmails').value = typeof rt.emails === 'string' ? rt.emails : '';
    if ($('rtAiCap')) $('rtAiCap').value = (typeof rt.aiCap === 'number' ? rt.aiCap : '');
    if ($('rtBaiduToken')) $('rtBaiduToken').value = typeof rt.baiduToken === 'string' ? rt.baiduToken : '';
    if ($('rtIndexKey')) $('rtIndexKey').value = typeof rt.indexNowKey === 'string' ? rt.indexNowKey : '';
    var vf = rt.verify || {};
    ['bytedance', 'sogou', 'shenma'].forEach(function (k) {
      var el = document.querySelector('[data-vf="' + k + '"]');
      if (el) el.value = vf[k] || '';
    });
      var tn = (s && s.theme && s.theme.name) || 'paper';
      var radios = document.querySelectorAll('input[name="theme-name"]');
      for (var ri = 0; ri < radios.length; ri++) radios[ri].checked = radios[ri].value === tn;
      if ($('theme-allow')) $('theme-allow').checked = !(s && s.theme && s.theme.allowUser === false);
      if ($('artCatEn')) $('artCatEn').checked = !!(s && s.article && s.article.catEn);
    var acolsNow = (s && s.article && s.article.cols) || 'double';
    var acR = document.querySelectorAll('input[name="article-cols"]');
    for (var aci = 0; aci < acR.length; aci++) acR[aci].checked = acR[aci].value === acolsNow;
      renderCats((s && s.article && s.article.categories) || []);
      if ($('artUnlockHint')) $('artUnlockHint').value = (s && s.article && s.article.unlockHint) || '';
    $('beian-enabled').checked = !!b.enabled;
    var src = { contact: c, beian: b, seo: o, geo: g };
    Object.keys(src).forEach(function (sec) {
      FIELDS[sec].forEach(function (k) {
        var el = $(sec + '-' + k);
        if (el) el.value = src[sec][k] || '';
      });
    });
    var lay = s.layout || {};
    var picked = { 'layout-mode': lay.mode || 'auto', 'layout-side': lay.side || 'right', 'layout-users': lay.users || 'auto', 'layout-articleSide': lay.articleSide || 'right' };
    Object.keys(picked).forEach(function (name) {
      document.querySelectorAll('input[name="' + name + '"]').forEach(function (r) { r.checked = r.value === picked[name]; });
    });
    state.faq = Array.isArray(g.faq) ? g.faq.slice() : [];
    renderFaq();
  }
  var catState = [];
  function catRow(c, i) {
    return '<tr data-ci="' + i + '">' +
      '<td><input type="text" data-cf="key" maxlength="24" value="' + navEsc(c.key || '') + '" placeholder="tech"></td>' +
      '<td><input type="text" data-cf="name" maxlength="24" value="' + navEsc(c.name || '') + '" placeholder="技术"></td>' +
      '<td><input type="text" data-cf="desc" maxlength="80" value="' + navEsc(c.desc || '') + '" placeholder="这一类放什么（可留空）"></td>' +
      '<td><button type="button" class="ghost small" data-cdel="' + i + '">删</button></td>' +
      '</tr>';
  }
  function renderCats(list) {
    catState = (Array.isArray(list) ? list : []).map(function (c) {
      return { key: String(c.key || ''), name: String(c.name || ''), desc: String(c.desc || '') };
    });
    var tb = $('catTbody');
    if (tb) {
      tb.innerHTML = catState.length
        ? catState.map(catRow).join('')
        : '<tr><td colspan="4"><div class="empty-card" role="status"><b>还没有分类</b><p>分类的英文词会进文章链接，例如 tech → /articles/tech/1.html。</p><button type="button" class="btn" data-empty-act="cat-add">新增分类</button></div></td></tr>';
    }
    var dl = $('artCatList');
    if (dl) {
      dl.innerHTML = catState.map(function (c) {
        return '<option value="' + navEsc(c.name) + '">' + navEsc(c.key) + '</option>';
      }).join('');
    }
    var bs = $('artBulkCat');
    if (bs) {
      var keep = bs.value;
      bs.innerHTML = '<option value="">改成分类…</option>' + catState.map(function (c) {
        var v = navEsc(c.name || c.key);
        return '<option value="' + v + '">' + v + '</option>';
      }).join('');
      bs.value = keep;
    }
  }
  function readCats() {
    var tb = $('catTbody');
    if (!tb) return catState;
    var out = [];
    Array.prototype.forEach.call(tb.querySelectorAll('tr[data-ci]'), function (tr) {
      var get = function (f) {
        var el = tr.querySelector('[data-cf="' + f + '"]');
        return el ? el.value.trim() : '';
      };
      var key = get('key');
      var name = get('name');
      if (!key && !name) return;
      out.push({ key: key, name: name || key, desc: get('desc') });
    });
    return out;
  }
  (function bindCats() {
    var add = $('catAdd');
    if (add) {
      add.addEventListener('click', function () {
        if (catState.length >= 30) { toast('分类最多 30 个', false); return; }
        catState = readCats();
        catState.push({ key: '', name: '', desc: '' });
        renderCats(catState);
      });
    }
    var tb = $('catTbody');
    if (tb) {
      tb.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-cdel]') : null;
        if (!btn) return;
        catState = readCats();
        catState.splice(Number(btn.getAttribute('data-cdel')), 1);
        renderCats(catState);
      });
    }
  })();

  function paintQr() {
    var box = $('contactQrPrev'), img = $('contactQrImg'), input = $('contact-qrUrl');
    if (!box || !img || !input) return;
    var v = String(input.value || '').trim();
    if (v.indexOf('http://') === 0 || v.indexOf('https://') === 0) {
      img.src = v;
      box.hidden = false;
    } else {
      img.removeAttribute('src');
      box.hidden = true;
    }
  }
  (function () {
    var input = $('contact-qrUrl');
    if (input) input.addEventListener('input', paintQr);
  })();
  function paintSerp() {
    var tEl = $('seo-title'), dEl = $('seo-description'), uEl = $('seo-siteUrl'), nEl = $('seo-siteName');
    if (!tEl || !dEl) return;
    function esc(x) {
      return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    var title = (tEl.value || (nEl && nEl.value) || 'GitHub 热门项目排行榜').trim();
    var desc = (dEl.value || '').trim();
    var url = ((uEl && uEl.value) || location.origin || '').trim();
    while (url.slice(-1) === '/') url = url.slice(0, -1);
    var shown = url.indexOf('https://') === 0 ? url.slice(8) : url.indexOf('http://') === 0 ? url.slice(7) : url;
    var tBox = $('serpTitle'), uBox = $('serpUrl'), dBox = $('serpDesc');
    if (tBox) tBox.textContent = title.length > 60 ? title.slice(0, 60) + '…' : title;
    if (uBox) uBox.textContent = shown || 'github.661026.xyz';
    if (dBox) dBox.textContent = desc ? (desc.length > 160 ? desc.slice(0, 160) + '…' : desc) : '（这里会显示页面描述，建议 80–120 字）';
    var tc = $('serpTitleCnt'), dc = $('serpDescCnt');
    if (tc) {
      tc.textContent = '标题 ' + title.length + ' 字 · ' + (title.length > 60 ? '超过 60 字会被截断' : title.length > 30 ? '略长，建议 30 字内' : '长度合适');
      tc.className = 'cnow' + (title.length > 60 ? ' cwarn' : '');
    }
    if (dc) {
      dc.textContent = '描述 ' + desc.length + ' 字 · ' + (desc.length > 160 ? '超过 160 字会被截断' : desc.length === 0 ? '还没填' : desc.length < 60 ? '偏短，建议 80–120 字' : '长度合适');
      dc.className = 'cnow' + (desc.length > 160 ? ' cwarn' : '');
    }
  }
  ['seo-title', 'seo-description', 'seo-siteUrl', 'seo-siteName'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('input', paintSerp);
  });
  function loadSite() {
    api('/api/site').then(function (r) {
      if (!r.ok) { toast(r.error || '读取站点配置失败', false); return; }
      fillSite(r.site);
      paintSerp();
      paintQr();
    });
  }
  function collect(sec) {
    if (sec === 'nav') return navState || { groups: [] };
    if (sec === 'qa') return readQaForm();
    if (sec === 'theme') {
      var pickedTheme = 'paper';
      var trs = document.querySelectorAll('input[name="theme-name"]');
      for (var ti = 0; ti < trs.length; ti++) if (trs[ti].checked) pickedTheme = trs[ti].value;
      return { name: pickedTheme, allowUser: $('theme-allow') ? $('theme-allow').checked : true };
    }
    if (sec === 'article') {
      var acr = document.querySelectorAll('input[name="article-cols"]');
      var acols = 'double';
      for (var ai = 0; ai < acr.length; ai++) if (acr[ai].checked) acols = acr[ai].value;
      return {
        unlockHint: ($('artUnlockHint') && $('artUnlockHint').value) || '',
        catEn: $('artCatEn') ? $('artCatEn').checked : false,
        cols: acols,
        categories: readCats(),
      };
    }
    if (sec === 'runtime') {
      var rawCap = $('rtAiCap').value;
      return {
        emails: $('rtEmails').value || '',
        aiCap: rawCap === '' ? null : Number(rawCap),
        baiduToken: $('rtBaiduToken') ? $('rtBaiduToken').value || '' : '',
        indexNowKey: $('rtIndexKey') ? $('rtIndexKey').value || '' : '',
        verify: {
          bytedance: ($('[data-vf="bytedance"]') || {}).value || '',
          sogou: ($('[data-vf="sogou"]') || {}).value || '',
          shenma: ($('[data-vf="shenma"]') || {}).value || '',
        },
      };
    }
    if (sec === 'ad') {
      // 每个广告位：开关 / 代码 / 间隔 / 跳转 / 弹窗
      var slots = {};
      Array.prototype.forEach.call(document.querySelectorAll('[data-ad-slot]'), function (el) {
        var id = el.getAttribute('data-ad-slot');
        var field = el.getAttribute('data-ad-field');
        if (!slots[id]) slots[id] = { enabled: false, html: '', every: 0, link: '', modal: '' };
        if (field === 'enabled') slots[id].enabled = el.checked === true;
        else if (field === 'every') slots[id].every = parseInt(el.value, 10) || 0;
        else if (field === 'link') slots[id].link = el.value || '';
        else if (field === 'modal') slots[id].modal = el.value || '';
        else slots[id].html = el.value || '';
      });
      return {
        slots: slots,
        ticker: {
          enabled: $('ticker-enabled').checked === true,
          text: $('ticker-text').value || '',
          speed: parseInt($('ticker-speed').value, 10) || 18,
          link: $('ticker-link').value || '',
          modal: $('ticker-modal').value || '',
        },
      };
    }
    if (sec === 'layout') {
      var pick = function (name, dflt) {
        var r = document.querySelector('input[name="' + name + '"]:checked');
        return r ? r.value : dflt;
      };
      return { mode: pick('layout-mode', 'auto'), side: pick('layout-side', 'right'), users: pick('layout-users', 'auto'), articleSide: pick('layout-articleSide', 'right') };
    }
    var v = {};
    var enBox = $(sec + '-enabled');
    if (sec !== 'seo' && sec !== 'geo') v.enabled = enBox ? !!enBox.checked : false;
    FIELDS[sec].forEach(function (k) { v[k] = $(sec + '-' + k).value; });
    if (sec === 'geo') v.faq = readFaq();
    return v;
  }
  function saveMsgFor(btn) {
    var el = btn.getAttribute('data-save') === 'qa' ? $('qaSaveMsg') : null;
    if (!el) {
      el = btn.parentNode.querySelector('.save-msg');
      if (!el) {
        el = document.createElement('span');
        el.className = 'save-msg';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        btn.parentNode.appendChild(el);
      }
    }
    return el;
  }
  function delMsgBox(target) {
    if (!target) return null;
    if (target.getAttribute && target.getAttribute('data-save')) return saveMsgFor(target);
    var box = target.querySelector('.save-msg');
    if (box) return box;
    box = document.createElement('span');
    box.className = 'save-msg';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    target.appendChild(box);
    return box;
  }
  function paintDelMsg(target, text, withUndo) {
    var box = delMsgBox(typeof target === 'string' ? document.querySelector(target) : target);
    if (!box) return;
    box.className = 'save-msg ok';
    box.textContent = text;
    if (withUndo) {
      var u = document.createElement('button');
      u.type = 'button';
      u.className = 'linkbtn';
      u.textContent = '撤销';
      u.addEventListener('click', function () {
        var b = $('artUndo');
        if (b) b.click();
      });
      box.appendChild(document.createTextNode(' '));
      box.appendChild(u);
    }
  }
  function delAnchor(sel) { return document.querySelector(sel); }
  function saveLabel(btn, text) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = text || btn.dataset.label;
  }
  function saveReason(r) {
    var e = String((r && r.error) || '');
    if (/网络错误|Failed to fetch|连不上|请求失败/.test(e)) return '网络断了或服务器连不上，检查网络后再试';
    if (/密码/.test(e)) return e + '（刷新页面重新登录）';
    if (/非 JSON|50[0-9]/.test(e)) return '服务器那边出错了（' + e + '），过一会儿再试';
    return e || '未知原因';
  }
  function saveRun(btn, task) {
    var msg = saveMsgFor(btn);
    btn.disabled = true;
    saveLabel(btn, '保存中…');
    msg.className = 'save-msg';
    msg.textContent = '正在保存…';
    Promise.resolve().then(task).then(function (r) {
      btn.disabled = false;
      saveLabel(btn);
      if (r && r.ok) {
        msg.className = 'save-msg ok';
        msg.textContent = '已保存 · ' + new Date().toLocaleTimeString();
        return;
      }
      msg.className = 'save-msg err';
      msg.textContent = '保存失败：' + saveReason(r) + ' ';
      var again = document.createElement('button');
      again.type = 'button';
      again.className = 'linkbtn';
      again.textContent = '重试';
      again.addEventListener('click', function () { btn.click(); });
      msg.appendChild(again);
    });
  }
  document.querySelectorAll('[data-save]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sec = btn.getAttribute('data-save');
      if (sec === 'qa') {
        saveRun(btn, function () {
          return api('/api/qa', { method: 'POST', body: { password: pw, qa: readQaForm() } }).then(function (r) {
            if (r.ok && r.qa) {
              qaState = { intro: r.qa.intro, items: r.qa.items };
              if ($('qa-intro')) $('qa-intro').value = qaState.intro;
              renderQa();
            }
            return r;
          });
        });
        return;
      }
      if (sec === 'nav') {
        saveRun(btn, function () {
          return api('/api/nav', { method: 'POST', body: { password: pw, nav: collect('nav') } }).then(function (r) {
            if (r.ok && r.nav) { navState = r.nav; renderNavAdmin(); }
            return r;
          });
        });
        return;
      }
      saveRun(btn, function () {
        return api('/api/site', { method: 'POST', body: { password: pw, section: sec, value: collect(sec) } });
      });
    });
  });

  // GEO 问答
  function syncFaq() {
    state.faq = [].map.call(document.querySelectorAll('#faqList .faq-row'), function (row) {
      return { q: row.querySelector('.fq').value, a: row.querySelector('.fa').value };
    });
  }
  function readFaq() {
    syncFaq();
    return state.faq.filter(function (f) { return f.q.trim() || f.a.trim(); });
  }
  function renderFaq() {
    var h = state.faq.map(function (f, i) {
      return '<div class="faq-row"><div><label>问题</label><input type="text" class="fq" aria-label="问题" maxlength="100" value="' + esc(f.q) +
        '"></div><div><label>回答</label><textarea class="fa" aria-label="回答" maxlength="500">' + esc(f.a) +
        '</textarea></div><div><button type="button" class="ghost small" data-faqdel="' + i + '">删除</button></div></div>';
    }).join('');
    $('faqList').innerHTML = h || '<div class="empty-card" role="status"><b>还没有问答</b><p>问答会同时出现在 /faq 页和 llms.txt，用来回答「数据哪来的」这类问题。</p><button type="button" class="btn" data-empty-act="qa-add">新增一条</button></div>';
  }
  $('faqAdd').addEventListener('click', function () {
    syncFaq();
    if (state.faq.length >= 20) { toast('问答最多 20 条', false); return; }
    state.faq.push({ q: '', a: '' });
    renderFaq();
  });
  $('faqList').addEventListener('click', function (e) {
    var d = e.target.getAttribute && e.target.getAttribute('data-faqdel');
    if (d == null) return;
    syncFaq();
    state.faq.splice(Number(d), 1);
    renderFaq();
  });

  // ---- 文章 ----
  function fillCatFilter(all) {
    var sel = $('artCatFilter');
    if (!sel) return;
    var names = {};
    (catState || []).forEach(function (c) { if (c && c.name) names[c.name] = 1; });
    (all || []).forEach(function (a) { if (a && a.category) names[a.category] = 1; });
    var names2 = Object.keys(names).sort();
    var want = ['|'].concat(names2).join('|');
    var has = ['|'].concat(Array.prototype.map.call(sel.options, function (o) { return o.value; }).filter(function (v) { return v !== ''; })).join('|');
    if (has !== want) {
      sel.innerHTML = '<option value="">全部分类</option>' + names2.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
    }
    sel.value = state.artCat || '';
  }
  // 空态卡里的按钮统一走委托，映射到已有的工具栏按钮
  var EMPTY_ACT = { 'art-new': 'artNew', 'link-add': 'addLinkBtn', 'cat-add': 'catAdd', 'qa-add': 'faqAdd', 'nav-cat-add': 'navAddGroup' };
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-empty-act]') : null;
    if (!b) return;
    var act = b.getAttribute('data-empty-act');
    if (act === 'artreset') {
      if ($('artSearch')) $('artSearch').value = '';
      if ($('artCatFilter')) $('artCatFilter').value = '';
      state.artCat = '';
      state.artPage = 1;
      renderArticles();
      if ($('artSearch')) $('artSearch').focus();
      return;
    }
    var id = EMPTY_ACT[act];
    if (id && $(id)) $(id).click();
  });

  function renderArticles() {
    var box = $('artSearch');
    var q = (box && box.value || '').trim().toLowerCase();
    var sort = state.artSort || 'date-desc';
    var all = state.articles.slice().sort(function (a, b) {
      var d = 0;
      if (sort === 'title-asc') d = String(a.title).localeCompare(String(b.title));
      else if (sort === 'title-desc') d = String(b.title).localeCompare(String(a.title));
      else if (sort === 'category-asc') d = String(a.category || '~').localeCompare(String(b.category || '~')) || String(b.date).localeCompare(String(a.date));
      else if (sort === 'date-asc') d = String(a.date).localeCompare(String(b.date));
      else d = String(b.date).localeCompare(String(a.date));
      return d;
    });
    $('artCount').textContent = all.length;
    var badge = $('navArtCount');
    if (badge) { badge.textContent = all.length; badge.hidden = !all.length; }
    var list = q ? all.filter(function (a) {
      return (String(a.title) + ' ' + String(a.summary) + ' ' + String(a.body)).toLowerCase().indexOf(q) >= 0;
    }) : all;
    var cat = state.artCat || '';
    if (cat) list = list.filter(function (a) { return String(a.category || '') === cat; });
    fillCatFilter(all);
    if ($('artSearchNote')) {
      var parts = [];
      if (q) parts.push('关键词「' + String(box && box.value || '').trim() + '」');
      if (cat) parts.push('分类「' + cat + '」');
      $('artSearchNote').textContent = parts.length ? (parts.join(' ') + '：' + list.length + ' / ' + all.length + ' 篇') : '';
    }
    var per = 20;
    var pages = Math.max(1, Math.ceil(list.length / per));
    var page = Math.min(Math.max(1, state.artPage || 1), pages);
    state.artPage = page;
    var pageList = list.slice((page - 1) * per, page * per);
    state.artFiltered = list.map(function (a) { return String(a.id); });
    if (!all.length) {
      $('artTbody').innerHTML = '<tr><td colspan="5"><div class="empty-card" role="status"><b>还没有文章</b><p>写第一篇之后，前台 /articles 会按分类列出来，同时进站点地图和 llms.txt。</p><button type="button" class="btn" data-empty-act="art-new">写新文章</button></div></td></tr>';
      if ($('artPager')) $('artPager').hidden = true;
      return;
    }
    if (!list.length) {
      $('artTbody').innerHTML = '<tr><td colspan="5"><div class="empty-card" role="status"><b>没有匹配的文章</b><p>换个关键词，或清掉分类筛选看全部。</p><button type="button" class="btn ghost" data-empty-act="artreset">清空搜索与筛选</button></div></td></tr>';
      if ($('artPager')) $('artPager').hidden = true;
      return;
    }
    $('artTbody').innerHTML = pageList.map(function (a) {
      return '<tr><td><input type="checkbox" aria-label="选中这篇文章" data-artpick="' + esc(a.id) + '"' + (state.artSel.has(String(a.id)) ? ' checked' : '') + '></td><td>' + esc(a.date) + '</td><td>' + (a.cover ? '<span class="cthumb" style="background-image:url(' + "'" + esc(a.cover).replace(/["'()<> ]/g, '') + "'" + ')"></span>' : '') + '<b>' + esc(a.title) + '</b>' +
        (a.locked ? '<span class="art-lock">加密</span>' : '') +
        (a.category ? ' <span class="slot-id">' + esc(a.category) + '</span>' : '') +
        '<div class="slugline">/articles/' + esc(a.slug || a.id) + '.html' + (a.category ? ' · ' + esc(a.category) : ' · 未分类') + (a.prevCount ? ' · 旧地址 ' + a.prevCount + ' 个（已 301）' : '') + '</div>' +
        '</td><td>' + esc(a.summary) +
        '</td><td><button type="button" class="ghost small" data-artedit="' + esc(a.id) + '">编辑</button> ' +
        '<button type="button" class="ghost small" data-artview="' + esc(a.id) + '">预览</button> ' +
        '<a class="ghost small" href="/articles/' + esc(a.slug || a.id) + '.html" target="_blank" rel="noopener">打开</a> ' +
        '<button type="button" class="danger small" data-artdel="' + esc(a.id) + '">删除</button></td></tr>';
    }).join('');
    if ($('artAll')) $('artAll').checked = false;
    artSyncBulk();
    renderArtPager(pages, list.length);
  }
  function loadArticles() {
    api('/api/articles').then(function (r) {
      if (!r.ok) {
        $('artTbody').innerHTML = '<tr><td colspan="5" class="empty">' + esc(r.error) + '</td></tr>';
        return;
      }
      state.articles = r.articles || [];
      renderArticles();
    });
  }
  function openArt(a) {
    editingId = a ? a.id : null;
    editingLocked = !!(a && a.locked && a.hasLock !== false);
    $('artTitle').textContent = a ? '编辑文章' : '写新文章';
    $('artTitleIn').value = a ? a.title : '';
    $('artDate').value = a ? a.date : today();
    $('artSummary').value = a ? a.summary : '';
    if ($('artCover')) $('artCover').value = a && a.cover ? a.cover : '';
    if ($('artPinned')) $('artPinned').checked = !!(a && a.pinned);
    $('artBody').value = a ? a.body : '';
    $('artLock').checked = !!(a && a.locked);
    $('artPw').value = '';
    var slugParts = String((a && a.slug) || '').split('/');
      $('artCategory').value = (a && a.category) || '';
      $('artCat').value = slugParts.length === 2 ? slugParts[0] : '';
      $('artSeq').value = slugParts.length === 2 ? slugParts[1] : '';
    $('artHint').value = (a && a.unlockHint) || '';
    slugPreview();
    $('artErr').textContent = '';
    paintPreview();
    $('artDlg').showModal();
    artDirty = false;
    artPaintDirty();
    if (a) { var dbar = $('draftBar'); if (dbar) dbar.hidden = true; }
    else artOfferDraft();
  }
  var ART_DRAFT = 'ghrank-art-draft';
  var artDirty = false;
  var artDraftTimer = null;
  function artFormState() {
    return {
      title: $('artTitleIn').value, date: $('artDate').value, summary: $('artSummary').value,
      cover: $('artCover') ? $('artCover').value : '', body: $('artBody').value,
      category: $('artCategory').value, cat: $('artCat').value, seq: $('artSeq').value,
      hint: $('artHint').value, locked: $('artLock').checked,
      pinned: $('artPinned') ? $('artPinned').checked : false
    };
  }
  function artPaintDirty() {
    var b = $('artDirtyBadge');
    if (b) b.hidden = !artDirty;
  }
  function artSaveDraft() {
    if (!artDirty) return;
    try {
      var d = artFormState();
      d.at = Date.now();
      localStorage.setItem(ART_DRAFT, JSON.stringify(d));
    } catch (e) {}
  }
  function artReadDraft() {
    try {
      var d = JSON.parse(localStorage.getItem(ART_DRAFT) || 'null');
      if (d && Date.now() - (d.at || 0) < 7 * 864e5 && (d.title || d.body)) return d;
    } catch (e) {}
    return null;
  }
  function artClearDraft() {
    clearTimeout(artDraftTimer);
    try { localStorage.removeItem(ART_DRAFT); } catch (e) {}
    var bar = $('draftBar');
    if (bar) bar.hidden = true;
  }
  function artFill(s) {
    $('artTitleIn').value = s.title || '';
    $('artDate').value = s.date || today();
    $('artSummary').value = s.summary || '';
    if ($('artCover')) $('artCover').value = s.cover || '';
    $('artBody').value = s.body || '';
    $('artCategory').value = s.category || '';
    $('artCat').value = s.cat || '';
    $('artSeq').value = s.seq || '';
    $('artHint').value = s.hint || '';
    $('artLock').checked = !!s.locked;
    if ($('artPinned')) $('artPinned').checked = !!s.pinned;
    if ($('artPw')) $('artPw').value = '';
    slugPreview();
    paintPreview();
  }
  function artOfferDraft() {
    var bar = $('draftBar');
    if (!bar) return;
    var d = artReadDraft();
    if (!d) { bar.hidden = true; return; }
    var w = new Date(d.at);
    var hh = ('0' + w.getHours()).slice(-2) + ':' + ('0' + w.getMinutes()).slice(-2);
    $('draftText').textContent = '上次没保存的草稿（' + (w.getMonth() + 1) + '/' + w.getDate() + ' ' + hh + '）：' + (d.title || '（无标题）');
    bar.hidden = false;
  }
  function artMarkDirty() {
    artDirty = true;
    artPaintDirty();
    clearTimeout(artDraftTimer);
    artDraftTimer = setTimeout(artSaveDraft, 700);
  }
  function artAskDiscard() {
    askConfirm('这篇还没保存', '标题或正文改了还没保存，关掉就没了（草稿留在本机，下次进来自动提示恢复）。', function () {
      $('artDlg').close();
      artDirty = false;
      artPaintDirty();
      return Promise.resolve({ ok: true });
    }, '放弃改动');
  }
  $('artNew').addEventListener('click', function () { openArt(null); });
  document.addEventListener('keydown', function (e) {
    var d = $('artDlg');
    if (e.key !== 'Escape' || !d || !d.open) return;
    var del = $('delDlg');
    if (del && del.open) return;
    e.preventDefault();
    e.stopPropagation();
    if (artDirty) artAskDiscard(); else d.close();
  }, true);
  $('artDlg').addEventListener('cancel', function () {
    var d = $('artDlg');
    if (artDirty && d && d.open) { artAskDiscard(); }
  });
  $('artDlg').addEventListener('input', artMarkDirty);
  $('artDlg').addEventListener('change', artMarkDirty);
  if ($('draftRestore')) $('draftRestore').addEventListener('click', function () {
    var d = artReadDraft();
    if (d) { artFill(d); artMarkDirty(); toast('草稿已恢复，记得保存', true); }
    $('draftBar').hidden = true;
  });
  if ($('draftDrop')) $('draftDrop').addEventListener('click', function () {
    artClearDraft();
    toast('草稿已丢弃', true);
  });
  window.addEventListener('beforeunload', function (e) {
    var d = $('artDlg');
    if (artDirty && d && d.open) { e.preventDefault(); e.returnValue = ''; return ''; }
  });
  $('artSubmit').addEventListener('click', function () {
    var article = {
      title: $('artTitleIn').value,
      date: $('artDate').value || today(),
      summary: $('artSummary').value,
      cover: $('artCover') ? $('artCover').value.trim() : '',
      pinned: $('artPinned') ? $('artPinned').checked : false,
      body: $('artBody').value
    };
    var lockOn = $('artLock').checked;
    var lockPw = $('artPw').value || '';
    var artCat = ($('artCat').value || '').trim().toLowerCase();
      var artSeq = ($('artSeq').value || '').trim().toLowerCase();
      var artSlug = artCat ? (artCat + '/' + (artSeq || '')) : '';
    var artHint = ($('artHint').value || '').trim();
    article.category = ($('artCategory').value || '').trim();
      article.slug = artSlug.split('/').filter(Boolean).join('/');
    article.unlockHint = artHint;
    article.locked = lockOn;
    if (lockOn) {
      if (lockPw && lockPw.length < 4) { $('artErr').textContent = '访问密码至少 4 位'; return; }
      if (lockPw) article.password = lockPw;
      else if (!editingId) { $('artErr').textContent = '勾了加密就要填一个访问密码（至少 4 位）'; return; }
      else if (!editingLocked) { $('artErr').textContent = '这篇原来没加密，勾加密后要填密码'; return; }
    } else if (editingLocked) {
      if (!confirm('取消加密会把正文以明文存进仓库，确定吗？')) return;
    }
    if (!article.title.trim()) { $('artErr').textContent = '请填写标题'; return; }
    var body = { password: pw, article: article };
    if (editingId) { body.action = 'update'; body.id = editingId; }
    else body.action = 'add';
    var btn = this;
    btn.disabled = true;
    api('/api/articles', { method: 'POST', body: body }).then(function (r) {
      btn.disabled = false;
      if (r.ok) {
        state.articles = r.articles;
        renderArticles();
        artClearDraft();
        artDirty = false;
        artPaintDirty();
        $('artDlg').close();
        toast('文章已保存', true);
      } else {
        $('artErr').textContent = r.error || '保存失败';
      }
    });
  });
  $('artImport').addEventListener('click', function () { $('artFile').click(); });
    $('artFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (!f) return;
      if (f.size > 300000) { $('artErr').textContent = 'MD 文件不能超过 300KB'; return; }
      var rd = new FileReader();
      rd.onload = function () {
        var p = KeeMd.parse(rd.result, f.name);
        $('artTitleIn').value = p.title;
        if (p.date) $('artDate').value = p.date;
        $('artSummary').value = p.summary;
        $('artBody').value = p.body;
        $('artErr').textContent = '';
        toast('已导入，请检查后保存', true);
        paintPreview();
      };
      rd.readAsText(f, 'utf-8');
    });
    function paintPreview() {
      var body = $('artBody').value;
      if ($('artLen')) $('artLen').textContent = body.length ? body.length + ' / 20000 字' : '';
      if (!window.KeeMd || typeof window.KeeMd.render !== 'function') {
        $('artPrev').innerHTML = '<p class="empty">渲染器没加载出来（md.js 被缓存了旧的），按 Ctrl+F5 强制刷新一下本页</p>';
        return;
      }
      $('artPrev').innerHTML = body.trim() ? KeeMd.render(body) : '<p class="empty">左边写正文，这里实时显示渲染效果</p>';
    }
    $('artBody').addEventListener('input', paintPreview);
    $('artPreviewBtn').addEventListener('click', function () {
      var grid = document.querySelector('#artDlg .art-grid');
      grid.classList.toggle('preview-off');
      this.textContent = grid.classList.contains('preview-off') ? '显示预览' : '隐藏预览';
    });
    function slugPreview() {
      var box = $('artSlugPrev');
      if (!box) return;
      var cat = ($('artCat').value || '').trim().toLowerCase();
      if (!cat) {
        var cname = ($('artCategory').value || '').trim().toLowerCase();
        cat = cname.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (!cat && cname) cat = 'cat';
      }
      if (!cat) {
        box.className = 'slugprev';
        box.textContent = '链接：选好分类后自动生成（英文分类词直接用，中文分类会落成 cat）';
        return;
      }
      var seqIn = ($('artSeq').value || '').trim().toLowerCase();
      var seq = seqIn;
      var list = state.articles || [];
      var auto = false;
      if (!seq) {
        var max = 0;
        list.forEach(function (x) {
          if (!x || x.id === editingId) return;
          var parts = String(x.slug || '').split('/');
          if (parts.length !== 2 || parts[0] !== cat) return;
          var num = parseInt(parts[1], 10);
          if (!isNaN(num) && num > max) max = num;
        });
        seq = String(max + 1);
        auto = true;
      }
      var slug = cat + '/' + seq;
      var href = '/articles/' + slug + '.html';
      var clash = null;
      list.forEach(function (x) {
        if (x && x.id !== editingId && String(x.slug || '') === slug) clash = x;
      });
      if (clash) {
        box.className = 'slugprev warn';
        box.textContent = '保存后地址：' + href + ' —— 这个地址已被《' + String(clash.title || '') + '》占用，保存时会自动变成 ' + slug + '-2';
      } else {
        box.className = 'slugprev';
        box.textContent = '保存后地址：' + href + (auto ? '（序号留空，自动取这个分类的下一个）' : '');
      }
    }

    ['artCat', 'artSeq', 'artCategory'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('input', slugPreview);
    });

    $('artSlugGen').addEventListener('click', function () {
      var cat = ($('artCat').value || '').trim().toLowerCase() ||
        (($('artCategory').value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) ||
        'cat';
      $('artCat').value = cat;
      $('artSeq').value = '';
      toast('链接：/articles/' + cat + '/<自动序号>.html（想固定就自己填序号）');
      slugPreview();
    });
    $('artFullBtn').addEventListener('click', function () {
      var dlg = $('artDlg');
      dlg.classList.toggle('full');
      this.textContent = dlg.classList.contains('full') ? '⤡ 还原' : '⤢ 放大';
    });
    if ($('artSearch')) imeBind($('artSearch'), function () { state.artPage = 1; renderArticles(); });
    $('artTbody').addEventListener('click', function (e) {
    var t = e.target;
    var ed = t.getAttribute && t.getAttribute('data-artedit');
    var dl = t.getAttribute && t.getAttribute('data-artdel');
    var vw = t.getAttribute && t.getAttribute('data-artview');
    if (ed != null) {
      var a = state.articles.filter(function (x) { return String(x.id) === ed; })[0];
      if (a) openArt(a);
    } else if (vw != null) {
      var av = state.articles.filter(function (x) { return String(x.id) === vw; })[0];
      if (av) { openArt(av); var grid = document.querySelector('#artDlg .art-grid'); if (grid.classList.contains('preview-off')) grid.classList.remove('preview-off'); }
    } else if (dl != null) {
      var art = state.articles.filter(function (x) { return String(x.id) === dl; })[0];
      var artTitle = art ? art.title : '';
      askConfirm('删除文章', '会删掉《' + artTitle + '》和它的正文，删完可以点「撤销」恢复（只保留最近一次）。', function () {
        var snap = state.articles.slice();
        return api('/api/articles', { method: 'POST', body: { password: pw, action: 'remove', id: dl } }).then(function (r) {
          if (r.ok) {
            state.articles = r.articles;
            artUndoSet(snap);
            renderArticles();
            paintDelMsg('#pane-articles [data-save="article"]', '已删除《' + artTitle + '》· 可撤销', true);
          }
          return r;
        });
      });
    }
  });

    function renderArtPager(pages, total) {
      var box = $('artPager');
      if (!box) return;
      if (pages <= 1) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      box.innerHTML = '<button type="button" class="ghost small" data-artpage="prev"' + (state.artPage <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<span class="msg">第 ' + state.artPage + ' / ' + pages + ' 页 · 共 ' + total + ' 篇</span>' +
        '<button type="button" class="ghost small" data-artpage="next"' + (state.artPage >= pages ? ' disabled' : '') + '>下一页</button>';
    }
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-artpage]');
      if (!b) return;
      var dir = b.getAttribute('data-artpage');
      state.artPage = Math.max(1, (state.artPage || 1) + (dir === 'next' ? 1 : -1));
      renderArticles();
    });

    // ---- 文章批量操作 ----
    function artPicked() {
      return Array.from(state.artSel || []);
    }
    function artSelNote() {
      var n = artPicked().length;
      var note = $('artSelNote');
      if (note) {
        note.textContent = n ? '已选 ' + n + ' 篇（可跨页）' : '';
        // 空提示不要占行：:empty 对「空文本节点」不生效，直接切 hidden
        note.hidden = !n;
      }
      var all = $('artAllMatch');
      if (all) all.disabled = !(state.artFiltered || []).length;
    }
    function artSyncBulk() {
      var n = artPicked().length;
      var d = $('artBulkDel');
      var a = $('artBulkApply');
      if (d) { d.disabled = !n; d.textContent = n ? '删除选中（' + n + '）' : '删除选中'; }
      if (a) a.disabled = !n;
      artSelNote();
    }
    if ($('artAll')) {
      $('artAll').addEventListener('change', function () {
        var on = this.checked;
        Array.prototype.forEach.call(document.querySelectorAll('[data-artpick]'), function (x) {
          var id = String(x.getAttribute('data-artpick'));
          if (on) state.artSel.add(id); else state.artSel.delete(id);
          x.checked = on;
        });
        artSyncBulk();
      });
    }
    document.addEventListener('change', function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-artpick') != null) {
        var id = String(e.target.getAttribute('data-artpick'));
        if (e.target.checked) state.artSel.add(id); else state.artSel.delete(id);
        artSyncBulk();
      }
    });
    if ($('artSort')) {
      var savedSort = '';
      try { savedSort = localStorage.getItem('ghrank-art-sort') || ''; } catch (e) {}
      if (savedSort) { state.artSort = savedSort; $('artSort').value = savedSort; }
      $('artCatFilter').addEventListener('change', function () {
        state.artCat = this.value;
        state.artPage = 1;
        renderArticles();
      });
      $('artSort').addEventListener('change', function () {
        state.artSort = this.value;
        try { localStorage.setItem('ghrank-art-sort', this.value); } catch (e) {}
        state.artPage = 1;
        renderArticles();
      });
    }
    function artUndoSet(prev) {
      state.artUndo = { articles: prev, at: Date.now() };
      var b = $('artUndo');
      if (b) b.disabled = false;
    }
    if ($('artUndo')) {
      $('artUndo').addEventListener('click', function () {
        var u = state.artUndo;
        if (!u) { toast('没有可撤销的操作', true); return; }
        api('/api/articles', { method: 'POST', body: { password: pw, action: 'replace', articles: u.articles } }).then(function (r) {
          if (r.ok) { state.articles = r.articles; state.artUndo = null; $('artUndo').disabled = true; renderArticles(); toast('已撤销', true); }
        });
      });
    }
    if ($('artAllMatch')) {
      $('artAllMatch').addEventListener('click', function () {
        (state.artFiltered || []).forEach(function (id) { state.artSel.add(id); });
        renderArticles();
      });
    }
    if ($('artBulkDel')) {
      $('artBulkDel').addEventListener('click', function () {
        var ids = artPicked();
        if (!ids.length) { toast('先勾选文章', true); return; }
        var prevSnapshot = state.articles.slice();
        askConfirm('批量删除', '会删掉选中的 ' + ids.length + ' 篇，删完可以点「撤销」恢复（只保留最近一次）。', function () {
          return api('/api/articles', { method: 'POST', body: { password: pw, action: 'bulk', op: 'remove', ids: ids } }).then(function (r) {
            if (r.ok) { state.articles = r.articles; state.artSel.clear(); artUndoSet(prevSnapshot); renderArticles(); paintDelMsg('#pane-articles [data-save="article"]', '已删除 ' + r.removed + ' 篇 · 可撤销', true); }
            return r;
          });
        });
      });
    }
    if ($('artBulkApply')) {
      $('artBulkApply').addEventListener('click', function () {
        var ids = artPicked();
        var box = $('artBulkCat');
        var cat = (box && box.value || '').trim();
        if (!ids.length) { toast('先勾选文章', true); return; }
        if (!cat) { toast('先填分类名', true); return; }
        var prevSnapshot = state.articles.slice();
        // 批量改分类会同时改 slug（分类词/序号），会动到已发布的文章地址，所以先确认一次
        var catList = (typeof readCats === 'function') ? readCats() : [];
        var catHit = null;
        for (var ci = 0; ci < catList.length; ci++) { if (catList[ci].key === cat || catList[ci].name === cat) { catHit = catList[ci]; break; } }
        var catKeyText = (catHit && catHit.key) ? catHit.key : cat;
        askConfirm('批量改分类', '把选中的 ' + ids.length + ' 篇改成分类「' + cat + '」？改完这些文章的链接会变成 /articles/' + catKeyText + '/序号.html（旧地址会 301 到新地址）。', function () {
          return api('/api/articles', { method: 'POST', body: { password: pw, action: 'bulk', op: 'category', category: cat, ids: ids } }).then(function (r) {
            if (r.ok) { state.articles = r.articles; state.artSel.clear(); artUndoSet(prevSnapshot); renderArticles(); toast('已把 ' + r.changed + ' 篇改成「' + cat + '」（可撤销）', true); }
            return r;
          });
        }, '确定修改');
      });
    }

    // ---- 翻译与密钥：只显示状态；实测会真的打两条翻译链路 ----
    function trErr(s) {
      var raw = String(s == null ? '' : s);
      var m = raw.match(/^([a-z-]+):\\s*([\\s\\S]*)$/);
      if (!m) return raw;
      var label = {
        network: '网络不通',
        quota: '额度用完',
        http: 'HTTP 错误',
        status: '服务端报错',
        parse: '返回格式异常',
        'not-bound': '未绑定',
        run: '模型调用失败',
        empty: '空结果',
        unknown: '未知原因'
      }[m[1]] || m[1];
      return label + '：' + m[2];
    }
    function paintTranslate(st) {
      st = st || {};
      var rows = [
        ['GitHub Token', !!st.githubToken, st.githubToken ? '已配置，前台「立即刷新」与保活可用' : '未配置：前台刷新和保活会失败'],
        ['Workers AI', !!st.ai, st.ai ? '已绑定，MyMemory 限流时自动兜底' : '未绑定：只有 MyMemory 一条链路'],
        ['MyMemory', true, st.contactEmail ? '可用（已填 ' + (st.emails || 1) + ' 个联系邮箱，额度按邮箱累加）' : '可用（免 Key；在上面填邮箱可提额）'],
        ['AI 日上限', true, (typeof st.aiCap === 'number' && st.aiCap === 0) ? '不限制（后台设置）' : (String(st.aiCap || 400) + ' 次/天' + (st.aiCapSource === 'admin' ? '（后台设置）' : '（默认或环境变量）'))]
      ];
      $('trStatus').innerHTML = rows.map(function (r) {
        return '<div class="status-item"><span class="dot ' + (r[1] ? 'ok' : 'warn') + '"></span><b>' + esc(r[0]) +
          '</b><small>' + esc(r[2]) + '</small></div>';
      }).join('');
    }
    if ($('rtAlias')) {
      $('rtAlias').addEventListener('click', function () {
        var box = $('rtEmails');
        var list = String(box.value || '').split(/[,\s]+/).filter(Boolean);
        var base = list[0] || '';
        if (!base || base.indexOf('@') < 0) { toast('先填一个真实邮箱，例如 you@gmail.com'); return; }
        var at = base.indexOf('@');
        var user = base.slice(0, at).split('+')[0];
        var domain = base.slice(at + 1);
        var out = list.slice();
        for (var i = 1; i <= 5; i++) {
          var cand = user + '+' + i + '@' + domain;
          if (out.indexOf(cand) < 0) out.push(cand);
        }
        box.value = out.join(',');
        toast('已加 5 个别名，Gmail / Outlook 都进同一个信箱');
      });
    }
    function loadTranslate() {
      api('/api/translate').then(function (r) {
        if (!r.ok) { $('trStatus').innerHTML = '<p class="empty">' + esc(r.error || '读取失败') + '</p>'; return; }
        paintTranslate(r.status);
      });
      api('/api/ai-usage').then(function (r) {
        var box = $('rtUsage');
        if (!box) return;
        if (!r.ok || !r.usage) { box.innerHTML = '<p class="empty">用量读取失败</p>'; return; }
        var u = r.usage;
        var capText = u.unlimited ? '不限制' : (u.cap + ' 次');
        var left = u.unlimited ? '—' : (u.remaining + ' 次');
        box.innerHTML =
          '<div class="status-item"><span class="dot ' + (u.bound ? 'ok' : 'warn') + '"></span><b>Workers AI</b><small>' +
          (u.bound ? '已绑定' : '未绑定（变量名必须是 AI）') + ' · 今天已用 <b>' + u.used + '</b> / ' + esc(capText) +
          ' · 还剩 <b>' + esc(left) + '</b>' + (u.capSource === 'admin' ? '（上限来自后台）' : '') + '</small></div>' +
          '<div class="status-item"><span class="dot ok"></span><b>免费额度参考</b><small>每天 10,000 Neurons 免费；m2m100 一次只消耗几十 neuron，400 次大约几百，远没到线。填 0 = 不限制。</small></div>';
      });
    }
    $('trReload').addEventListener('click', loadTranslate);
    $('trRun').addEventListener('click', function () {
      var btn = this, note = $('trNote'), out = $('trOut');
      btn.disabled = true; note.textContent = '请求中…'; out.innerHTML = '';
      api('/api/translate', { method: 'POST', body: { password: pw, text: $('trText').value } }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          note.textContent = '';
          out.innerHTML = '<div class="tr-box tr-bad">' + esc(r.error || '实测失败') + '</div>';
          return;
        }
        var eff = { myMemory: 'MyMemory', ai: 'Workers AI', cache: '命中译文缓存（没有产生调用）', none: '两条都没通' }[r.effective] || r.effective;
        note.textContent = '实际生效：' + eff;
        function box(name, o) {
          if (!o) return '';
          var tag = o.ok ? (o.fromCache ? '成功（缓存）' : '成功') : '失败';
          return '<div class="tr-box' + (o.ok ? '' : ' tr-bad') + '"><h4>' + esc(name) + ' · ' + tag +
            ' · ' + esc(String(o.ms)) + ' ms</h4><p>' + esc(o.ok ? o.text : trErr(o.error)) + '</p></div>';
        }
        out.innerHTML = box('MyMemory', r.myMemory) + box('Workers AI', r.ai);
        paintTranslate(r.status);
      });
    });

  // ---- 导航页（分类 + 站点） ----
  var navState = { groups: [] };
  function navEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function navBadge() {
    var n = 0;
    (navState.groups || []).forEach(function (g) { n += (g.items || []).length; });
    var b = $('navItemCount');
    if (b) { b.textContent = String(n); b.hidden = n === 0; }
  }
  function navFilterText() {
    var el = $('navFilter');
    return el ? String(el.value || '').trim().toLowerCase() : '';
  }
  function navStats() {
    var gs = (navState && navState.groups) || [];
    var n = 0;
    gs.forEach(function (g) { n += (g.items || []).length; });
    var el = $('navStat');
    if (el) el.textContent = gs.length + ' 个分类 · ' + n + ' 个站点';
  }
  function navRowHtml(gi, ii, it) {
    var icon = (it && it.icon) ? navEsc(it.icon) : '';
    var prev = icon
      ? '<img class="ic-prev" src="' + icon + '" alt="" onerror="this.remove()">'
      : '<span class="ic-prev ic-none">—</span>';
    return '<tr data-g="' + gi + '" data-i="' + ii + '">' +
      '<td class="cell-name"><div class="nm">' + prev +
      '<input type="text" data-f="name" value="' + navEsc(it.name || '') + '" placeholder="名称"></div></td>' +
      '<td><input type="url" data-f="url" value="' + navEsc(it.url || '') + '" placeholder="https://…"></td>' +
      '<td><input type="text" data-f="desc" value="' + navEsc(it.desc || '') + '" placeholder="一句话描述"></td>' +
      '<td><input type="url" data-f="icon" value="' + icon + '" placeholder="图标 URL（可不填）"></td>' +
      '<td class="cell-act"><div class="row-actions">' +
      '<button type="button" class="ghost small" data-sup="1" title="上移"' + (ii === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button type="button" class="ghost small" data-sdn="1" title="下移"' + (ii === (((navState.groups[gi] || {}).items || []).length - 1) ? ' disabled' : '') + '>↓</button>' +
      '<button type="button" class="ghost small" data-ifetch="1">自动获取</button>' +
      '<button type="button" class="ghost small danger" data-idel="1">删除</button></div></td>' +
      '</tr>';
  }
  function renderNavAdmin() {
    var box = $('navAdmin');
    if (!box) return;
    navBadge();
    navStats();
    var gs = (navState && navState.groups) || [];
    var q = navFilterText();
    if (!gs.length) {
      box.innerHTML = '<div class="empty-card" role="status"><b>还没有分类</b><p>导航页的分类就是前台的标签，例如「开发工具」「设计」；建好分类再往里加站点。</p><button type="button" class="btn" data-empty-act="nav-cat-add">＋ 分类</button></div>';
      return;
    }
    var anyHit = !q || gs.some(function (g) {
      return (g.items || []).some(function (it) {
        return (String(it.name || '') + ' ' + String(it.url || '') + ' ' + String(it.desc || '')).toLowerCase().indexOf(q) >= 0;
      });
    });
    if (!anyHit) {
      var allN = gs.reduce(function (n, g) { return n + (g.items || []).length; }, 0);
      box.innerHTML = '<div class="empty-card" role="status"><b>没有匹配的站点</b><p>换个关键词试试，或清空筛选看全部 ' + allN + ' 个站点。</p><button type="button" class="btn ghost" data-navfreset="1">清空筛选</button></div>';
      return;
    }
    box.innerHTML = gs.map(function (g, gi) {
      var items = g.items || [];
      var shown = q ? items.filter(function (it) {
        return (String(it.name || '') + ' ' + String(it.url || '') + ' ' + String(it.desc || '')).toLowerCase().indexOf(q) >= 0;
      }) : items;
      var idx = q ? shown.map(function (it) { return items.indexOf(it); }) : shown.map(function (x, k) { return k; });
      var rows = shown.map(function (it, k) { return navRowHtml(gi, idx[k], it); }).join('');
      return '<div class="card nav-g">' +
        '<div class="card-head"><div class="nav-g-head">' +
        '<input type="text" data-gf="name" data-g="' + gi + '" value="' + navEsc(g.name || '') + '" placeholder="分类名">' +
        '<input type="text" data-gf="desc" data-g="' + gi + '" value="' + navEsc(g.desc || '') + '" placeholder="分类说明（可空）">' +
        '</div><div class="row-actions"><span class="nav-cnt">' + items.length + ' 个</span>' +
        '<button type="button" class="ghost small" data-gup="' + gi + '" title="分类上移"' + (gi === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="ghost small" data-gdn="' + gi + '" title="分类下移"' + (gi === gs.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="ghost small" data-gadd="' + gi + '">＋ 站点</button>' +
        '<button type="button" class="ghost small danger" data-gdel="' + gi + '">删分类</button></div></div>' +
        (shown.length
          ? '<table class="nav-table"><thead><tr><th style="width:215px">名称</th><th style="width:255px">网址</th><th>描述</th><th style="width:200px">图标</th><th style="width:212px">操作</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : (q
            ? '<div class="empty-card" role="status"><b>这个分类里没有匹配的站点</b><p>换个关键词，或清空筛选看这个分类的全部 ' + items.length + ' 个站点。</p><button type="button" class="btn ghost" data-navfreset="1">清空筛选</button></div>'
            : '<div class="empty-card" role="status"><b>这个分类还没有站点</b><p>加站点时填「名称 | 网址 | 描述 | 图标」，图标可留空，前台会自动取站名首字母。</p><button type="button" class="btn" data-gadd="' + gi + '">＋ 站点</button></div>')) +
        '</div>';
    }).join('');
  }
  function navImportText(raw) {
    var CR = String.fromCharCode(13), LF = String.fromCharCode(10);
    var lines = String(raw || '').replace(new RegExp(CR, 'g'), '').split(LF);
    if (!(navState.groups || []).length) {
      navState.groups = [{ id: 'imported', name: '导入', desc: '', items: [] }];
    }
    var g = navState.groups[0];
    g.items = g.items || [];
    var added = 0;
    lines.forEach(function (line) {
      var t = line.trim();
      if (!t || t.charAt(0) === '#') return;
      var parts = t.split(/\\s*\\|\\s*|\\t+/);
      var url = (parts[1] || '').trim();
      if (!/^https?:\\/\\//i.test(url)) return;
      var host = url.replace(/^https?:\\/\\//i, '').split('/')[0];
      g.items.push({ name: (parts[0] || '').trim() || host, url: url, desc: (parts[2] || '').trim(), icon: (parts[3] || '').trim() });
      added++;
    });
    renderNavAdmin();
    toast(added ? '已导入 ' + added + ' 个站点到「' + g.name + '」，记得点保存' : '没识别到可导入的行（第二列要是 http(s) 网址）', added > 0);
  }
  imeBind($('navFilter'), renderNavAdmin);
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-navfreset]') : null;
    if (!b) return;
    if ($('navFilter')) { $('navFilter').value = ''; $('navFilter').focus(); }
    renderNavAdmin();
  });
  $('navImport').addEventListener('click', function () {
    var dlg = $('navImpDlg');
    $('navImpText').value = '';
    if ($('navImpFile')) {
      $('navImpFile').value = '';
      $('navImpFile').addEventListener('change', function () {
        var f = this.files && this.files[0];
        if (!f) return;
        f.text().then(function (txt) {
          var n = txt.split(String.fromCharCode(10)).filter(function (x) { return x.trim(); }).length;
          $('navImpText').value = txt;
          toast('已读取 ' + n + ' 行，确认后点导入');
        }).catch(function () { toast('这个文件读不出来', true); });
      });
    }
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  });
  $('navImpCancel').addEventListener('click', function () { $('navImpDlg').close(); });
  $('navImpGo').addEventListener('click', function () {
    navImportText($('navImpText').value);
    $('navImpDlg').close();
  });
  function loadNavAdmin() {
    api('/api/nav').then(function (r) {
      if (!r.ok) {
        $('navAdmin').innerHTML = '<p class="empty">' + navEsc(r.error || '读取失败') + '</p>';
        return;
      }
      navState = r.nav || { groups: [] };
      renderNavAdmin();
    });
  }
  $('navAddGroup').addEventListener('click', function () {
    navState.groups = navState.groups || [];
    if (navState.groups.length >= 20) { toast('最多 20 个分类', false); return; }
    navState.groups.push({ id: 'g' + (navState.groups.length + 1), name: '新分类', desc: '', items: [] });
    renderNavAdmin();
  });
  $('navAdmin').addEventListener('input', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var gf = el.getAttribute('data-gf');
    if (gf) {
      var gi = parseInt(el.getAttribute('data-g'), 10);
      if (navState.groups[gi]) navState.groups[gi][gf] = el.value;
      return;
    }
    var f = el.getAttribute('data-f');
    if (!f) return;
    var tr = el.closest ? el.closest('tr') : null;
    if (!tr) return;
    var g = parseInt(tr.getAttribute('data-g'), 10);
    var i = parseInt(tr.getAttribute('data-i'), 10);
    if (navState.groups[g] && navState.groups[g].items[i]) navState.groups[g].items[i][f] = el.value;
  });
  $('navAdmin').addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!el) return;
    var gadd = el.getAttribute('data-gadd');
    if (gadd != null) {
      var gi = parseInt(gadd, 10);
      if (!navState.groups[gi]) return;
      navState.groups[gi].items = navState.groups[gi].items || [];
      if (navState.groups[gi].items.length >= 60) { toast('一个分类最多 60 个站点', false); return; }
      navState.groups[gi].items.push({ name: '', url: '', desc: '', icon: '' });
      renderNavAdmin();
      return;
    }
    var gdel = el.getAttribute('data-gdel');
    if (gdel != null) {
      var di = parseInt(gdel, 10);
      var nm = navState.groups[di] ? navState.groups[di].name : '';
      askConfirm('删除分类「' + nm + '」？', '这个分类和它下面的站点会一起删掉，点「保存导航页」后才真正生效。', function () {
        navState.groups.splice(di, 1);
        renderNavAdmin();
        return Promise.resolve({ ok: true });
      });
      return;
    }
    var gup = el.getAttribute('data-gup');
    var gdn = el.getAttribute('data-gdn');
    if (gup != null || gdn != null) {
      var gfrom = parseInt(gup != null ? gup : gdn, 10);
      var gto = gup != null ? gfrom - 1 : gfrom + 1;
      if (gto >= 0 && gto < (navState.groups || []).length) {
        var gswap = navState.groups[gfrom];
        navState.groups[gfrom] = navState.groups[gto];
        navState.groups[gto] = gswap;
        renderNavAdmin();
      }
      return;
    }
    var tr = el.closest ? el.closest('tr') : null;
    if (!tr) return;
    var g = parseInt(tr.getAttribute('data-g'), 10);
    var i = parseInt(tr.getAttribute('data-i'), 10);
    if (!navState.groups[g] || !navState.groups[g].items[i]) return;
    if (el.hasAttribute('data-sup') || el.hasAttribute('data-sdn')) {
      var arr = navState.groups[g].items;
      var sto = el.hasAttribute('data-sup') ? i - 1 : i + 1;
      if (sto >= 0 && sto < arr.length) {
        var swap = arr[i];
        arr[i] = arr[sto];
        arr[sto] = swap;
        renderNavAdmin();
      }
      return;
    }
    if (el.hasAttribute('data-idel')) {
      navState.groups[g].items.splice(i, 1);
      renderNavAdmin();
      return;
    }
    if (el.hasAttribute('data-ifetch')) {
      var item = navState.groups[g].items[i];
      var u = String(item.url || '').trim();
      if (!u) { toast('先填网址再抓取', false); return; }
      el.disabled = true;
      el.textContent = '抓取中…';
      api('/api/fetch-meta?url=' + encodeURIComponent(u)).then(function (r) {
        el.disabled = false;
        el.textContent = '自动获取';
        if (!r.ok || !r.meta) { toast(r.error || '抓取失败，手动填吧', false); return; }
        if (!String(item.name || '').trim()) item.name = r.meta.name || '';
        item.desc = r.meta.desc || item.desc || '';
        item.icon = r.meta.icon || item.icon || '';
        renderNavAdmin();
        toast('已抓取：' + (r.meta.name || 'ok'), true);
      });
    }
  });

  // ---- 收录提交 ----
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-eye]') : null;
    if (!btn) return;
    var inp = document.getElementById(btn.getAttribute('data-eye'));
    if (!inp) return;
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.textContent = show ? '隐藏' : '显示';
  });

  function todoRow(ok, text, tab, tabText) {
    var el = document.createElement('div');
    el.className = 'status-item';
    var dot = document.createElement('span');
    dot.className = 'dot' + (ok ? '' : ' bad');
    var b = document.createElement('b');
    b.textContent = text;
    el.appendChild(dot);
    el.appendChild(b);
    var a = document.createElement('span');
    a.className = 'muted';
    a.textContent = ok ? '已设置' : '还没设置';
    el.appendChild(a);
    if (!ok && tab) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost mini';
      btn.textContent = '去' + (tabText || '设置');
      btn.addEventListener('click', function () { go(tab); });
      el.appendChild(btn);
    }
    return el;
  }

  async function loadTodo() {
    var box = $('todoBox');
    if (!box) return;
    var out = [];
    try {
      var s = await api('/api/site');
      var site = (s && s.site) || {};
      var seo = site.seo || {};
      var ad = site.ad || {};
      var slots = ad.slots || {};
      var anyAd = false;
      Object.keys(slots).forEach(function (k) { if (slots[k] && slots[k].enabled) anyAd = true; });
      if (ad.ticker && ad.ticker.enabled) anyAd = true;
      out.push(todoRow(!!(seo.title && String(seo.title).length >= 6), 'SEO 标题', 'seo', '设置'));
      out.push(todoRow(!!(seo.description && String(seo.description).length >= 30), 'SEO 描述', 'seo', '设置'));
      out.push(todoRow(!!seo.ogImage, '分享图（微信/Twitter 卡片）', 'seo', '设置'));
      out.push(todoRow(anyAd, '广告位至少开一个', 'ad', '广告'));
    } catch (e) {}
    var todoCounts = null;
    try {
      var hh = await api('/api/health');
      var hs = (hh && hh.submit) || {};
      todoCounts = (hh && hh.counts) || null;
      out.push(todoRow(!!hs.keyFileOk, 'IndexNow key 文件可访问', 'submit', '提交'));
      out.push(todoRow(!!hs.baiduToken, '百度推送 Token', 'keys', '密钥'));
    } catch (e) {}
    out.push(todoRow(!!(todoCounts && todoCounts.navGroups >= 3), '导航页至少 3 个分组', 'nav', '导航'));
    out.push(todoRow(!!(todoCounts && todoCounts.qa >= 3), '问答至少 3 条', 'qa', '问答'));
    out.push(todoRow(!!(todoCounts && todoCounts.links >= 1), '友链至少 1 条', 'links', '友链'));
    box.innerHTML = '';
    out.forEach(function (row) { box.appendChild(row); });
  }

  function subLine(label, value, ok) {
    return '<div class="status-item"><b>' + label + '</b><span' +
      (ok === false ? ' class="tr-bad"' : '') + '>' + value + '</span></div>';
  }
  function subBox(name, o) {
    if (!o) return '';
    var head = '<b>' + name + '</b> · ' + (o.ok ? '成功' : '失败') + (o.status ? '（HTTP ' + o.status + '）' : '') + (typeof o.ms === 'number' ? ' · ' + o.ms + 'ms' : '');
    var raw = o.raw ? '<details class="raw"><summary>看原始返回</summary><pre>' + navEsc(o.raw) + '</pre></details>' : '';
    var urls = '';
    if (o.urlList && o.urlList.length) {
      urls = '<details class="raw"><summary>这次推了 ' + o.urlList.length + ' 条地址' + (o.urlListNote ? '（' + navEsc(o.urlListNote) + '）' : '') + '</summary><pre>' + o.urlList.map(function (u) { return navEsc(u); }).join(String.fromCharCode(10)) + '</pre></details>';
    }
    return '<div class="tr-box' + (o.ok ? '' : ' tr-bad') + '">' + head + '<br>' + navEsc(o.note || '') + urls + raw + '</div>';
  }
  function loadSubmit() {
    var box = $('subStatus');
    if (!box) return;
    if (subTimer) { clearInterval(subTimer); subTimer = null; }
    api('/api/submit').then(function (r) {
      if (!r.ok || !r.status) {
        box.innerHTML = '<p class="empty">' + navEsc(trErr(r.error || '读取失败')) + '</p>';
        return;
      }
      var s = r.status;
      var last = s.lastRun;
      box.innerHTML =
        subLine('IndexNow key', '<code>' + navEsc(s.indexNowKey) + '</code>　key 文件：<code>' + navEsc(s.keyFile) + '</code>', true) +
        subLine('站点地图', '<a href="' + navEsc(s.sitemap) + '" target="_blank" rel="noopener">' + navEsc(s.sitemap) + '</a>', true) +
        subLine('大模型说明', '<a href="' + navEsc(s.llms) + '" target="_blank" rel="noopener">' + navEsc(s.llms) + '</a>（llms.txt，抓到就是最新榜单）', true) +
        subLine('key 文件自检', s.keyFileOk ? '能访问　' + navEsc(s.keyFileNote || '') : '打不开：' + navEsc(s.keyFileNote || '未知原因') + '（多半是 Worker 未部署到最新版）', !!s.keyFileOk) +
        subLine('key 文件内容', s.keyFileMatch ? '与后台填的 key 一致（IndexNow 会来读这个文件校验）' : '和后台填的 key 不一致，Bing 会拒（422）', !!s.keyFileMatch) +
        subLine('百度推送', s.baiduToken ? '已配置准入密钥（来源：' + navEsc(s.baiduTokenSource || 'env') + '），可以主动推' : '没填准入密钥，点提交时会跳过百度', !!s.baiduToken) +
        subLine('Workers AI 今日', s.aiUsage ? (s.aiUsage.used + ' / ' + (s.aiUsage.unlimited ? '不限制' : s.aiUsage.cap) + ' 次' + (s.aiUsage.capSource === 'admin' ? '（上限来自后台）' : '')) : '—', true) +
        subLine('这次会推送', (s.urlCount ? (s.urlCount + ' 条（含首页、/articles 与前 100 篇文章）') : '—') + (s.urlSample && s.urlSample.length ? '<br><span class="muted">' + s.urlSample.slice(0, 3).map(function (u) { return navEsc(u); }).join('<br>') + '</span>' : ''), !!s.urlCount) +
        subLine('冷却状态', (s.cooldown && s.cooldown.seconds > 0) ? '还要等 ' + s.cooldown.seconds + ' 秒才能再推（防 IndexNow 429）' : '可以提交', !(s.cooldown && s.cooldown.seconds > 0)) +
        subLine('最近一次提交', last ? ((last.at ? new Date(last.at).toLocaleString() : '时间未知（旧记录）') + '　' + ((last.results && last.results.indexNow && last.results.indexNow.ok) ? 'IndexNow 成功' : 'IndexNow 未成功')) : '还没提交过', !!last);
      var cool = (s.cooldown && s.cooldown.seconds) ? s.cooldown.seconds : 0;
      (function () {
        var wrap = $('subStatus');
        if (!wrap) return;
        var el = $('subCool');
        if (!el) { el = document.createElement('div'); el.id = 'subCool'; wrap.appendChild(el); }
        var left = cool;
        var tick = function () {
          el.innerHTML = left > 0
            ? '<p class="note">冷却中：还要等 <b>' + left + '</b> 秒才能再推（防 IndexNow 429）</p>'
            : '<p class="note">现在可以提交</p>';
          if (left <= 0) { if (subTimer) { clearInterval(subTimer); subTimer = null; } return; }
          left -= 1;
        };
        tick();
        if (cool > 0) subTimer = setInterval(tick, 1000);
      })();
      var outBox = $('subOut');
      var res = (last && last.results) ? last.results : null;
      if (res) {
        box.innerHTML += '<div style="margin-top:10px">' +
          subBox('上次 IndexNow', res.indexNow) + subBox('上次百度', res.baidu) + '</div>';
        if (outBox) {
          outBox.innerHTML = '<p class="note">下面这些是上次提交的结果（' + new Date(last.at || Date.now()).toLocaleString() + '），重新提交会覆盖。</p>' +
            subBox('上次 IndexNow', res.indexNow) + subBox('上次百度', res.baidu);
        }
      } else if (last && outBox) {
        outBox.innerHTML = '<p class="note">上次提交（' + new Date(last.at || Date.now()).toLocaleString() + '）是旧记录，没有保存原始返回；下次提交后会显示在这里。</p>';
      }
    });
  }
  $('subReload').addEventListener('click', function () {
    $('subStatus').innerHTML = '<p class="empty">读取中…</p>';
    loadSubmit();
  });
  var subAction = 'all';
  var subTimer = null;
  function runSubmit(action, isTest) {
    subAction = action || 'all';
    var btn = $('subRun');
    var out = $('subOut');
    btn.disabled = true;
    btn.textContent = '提交中…';
    out.innerHTML = '<p class="note">正在提交…</p>';
    var forceEl = $('subForce');
    api('/api/submit', { method: 'POST', body: { password: pw, action: subAction, test: !!isTest, force: !!(forceEl && forceEl.checked) } }).then(function (r) {
      btn.disabled = false;
      btn.textContent = '全部提交';
      if (!r.ok) {
        out.innerHTML = '<div class="tr-box tr-bad">' + navEsc(trErr(r.error || '提交失败')) +
          (r.wait ? '<br>还剩 ' + r.wait + ' 秒。' : '') + '</div>';
        return;
      }
      var res = r.results || {};
      out.innerHTML = '<div class="tr-box">本次提交 <b>' + (r.urls || 0) + '</b> 个地址（首页 + 文章列表 + 每篇文章）' +
        (r.root ? '<br>站点地址：<code>' + navEsc(r.root) + '</code>（必须与百度验证、key 文件同域）' : '') + '</div>' +
        subBox('IndexNow（Bing / Yandex / Naver）', res.indexNow) +
        subBox('百度普通收录', res.baidu);
      toast('提交完成', true);
      loadSubmit();
    });
  }
  $('subRun').addEventListener('click', function () { runSubmit('all'); });
  if ($('subTest')) $('subTest').addEventListener('click', function () { runSubmit('all', true); });
  $('subRunIN').addEventListener('click', function () { runSubmit('indexnow'); });
  $('subRunBD').addEventListener('click', function () { runSubmit('baidu'); });

  // ---------- 分段 tab（SEO/GEO、广告位）----------
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-go]') : null;
    if (t) { enterTab(t.getAttribute('data-go')); return; }
    var a = e.target.closest ? e.target.closest('[data-adsec]') : null;
    if (a) {
      var pane = document.getElementById('pane-ad');
      pane.setAttribute('data-sec', a.getAttribute('data-adsec'));
      Array.prototype.forEach.call(document.querySelectorAll('[data-adsec]'), function (b) {
        b.classList.toggle('is-on', b === a);
      });
    }
  });
  function enterTab(name) {
    if (!name) return;
    go(name);
    Array.prototype.forEach.call(document.querySelectorAll('[data-group="seogeo"] [data-go]'), function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-go') === name);
    });
    if (history.replaceState) history.replaceState(null, '', '#' + name);
  }
  document.addEventListener('click', function (e) {
    var c = e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!c) return;
    var el = document.getElementById(c.getAttribute('data-copy'));
    if (!el) return;
    el.select();
    try {
      document.execCommand('copy');
      toast('已复制');
    } catch (err) {
      toast('复制失败，请手动选');
    }
  });
  // ---------- 问答（GEO）----------
  var qaState = { intro: '', items: [] };
  function qesc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function qaRow(it, i) {
    return '<div class="qa-row" data-i="' + i + '">' +
      '<div class="qa-top"><input class="qa-q" maxlength="200" placeholder="问题，例如：这个榜单的数据多久更新一次？" value="' + qesc(it.q) + '">' +
      '<input class="qa-tag" maxlength="20" placeholder="标签" value="' + qesc(it.tag) + '">' +
      '<button type="button" class="ghost small" data-qaup="' + i + '" title="上移"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button type="button" class="ghost small" data-qadn="' + i + '" title="下移"' + (i === qaState.items.length - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button type="button" class="ghost" data-qadel="' + i + '">删除</button></div>' +
      '<textarea class="qa-a" maxlength="4000" placeholder="答案（支持 Markdown）">' + qesc(it.a) + '</textarea>' +
      '</div>';
  }
  function bindQaActions() {
    var box = $('qaList');
    if (!box || box.dataset.bound === '1') return;
    box.dataset.bound = '1';
    box.addEventListener('click', function (e) {
      var up = e.target.closest('[data-qaup]'), dn = e.target.closest('[data-qadn]');
      if (up) {
        readQaForm();
        var i = +up.getAttribute('data-qaup');
        if (i > 0) { var t = qaState.items[i - 1]; qaState.items[i - 1] = qaState.items[i]; qaState.items[i] = t; renderQa(); }
      } else if (dn) {
        readQaForm();
        var j = +dn.getAttribute('data-qadn');
        if (j < qaState.items.length - 1) { var u = qaState.items[j + 1]; qaState.items[j + 1] = qaState.items[j]; qaState.items[j] = u; renderQa(); }
      }
    });
    var f = $('qaFilter');
    if (f && f.dataset.bound !== '1') { f.dataset.bound = '1'; imeBind(f, renderQa); }
    var tf = $('qaTagFilter');
    if (tf && tf.dataset.bound !== '1') { tf.dataset.bound = '1'; tf.addEventListener('change', renderQa); }
  }
  function fillQaTags() {
    var sel = $('qaTagFilter');
    if (!sel) return;
    var tags = {};
    (qaState.items || []).forEach(function (it) { var t = String((it && it.tag) || '').trim(); if (t) tags[t] = 1; });
    var arr = Object.keys(tags).sort();
    var want = ['|'].concat(arr).join('|');
    var has = ['|'].concat(Array.prototype.map.call(sel.options, function (o) { return o.value; }).filter(function (v) { return v !== ''; })).join('|');
    if (has !== want) {
      sel.innerHTML = '<option value="">全部标签</option>' + arr.map(function (t) { return '<option value="' + qesc(t) + '">' + qesc(t) + '</option>'; }).join('');
    }
    if (arr.indexOf(sel.value) < 0) sel.value = '';
  }
  function renderQa() {
    bindQaActions();
    var box = $('qaList');
    if (!box) return;
    fillQaTags();
    var qInp = $('qaFilter'), tagSel = $('qaTagFilter');
    var q = String((qInp && qInp.value) || '').trim().toLowerCase();
    var tag = String((tagSel && tagSel.value) || '');
    var rows = [];
    if (!qaState.items.length) {
      box.innerHTML = '<div class="empty">还没有问答。点右上角「＋ 新问题」开始。</div>';
    } else {
      qaState.items.forEach(function (it, i) {
        if (tag && String((it && it.tag) || '').trim() !== tag) return;
        if (q) {
          var hay = (String((it && it.q) || '') + ' ' + String((it && it.a) || '') + ' ' + String((it && it.tag) || '')).toLowerCase();
          if (hay.indexOf(q) < 0) return;
        }
        rows.push(qaRow(it, i));
      });
      box.innerHTML = rows.length ? rows.join('') : '<div class="empty">没有匹配的问答</div>';
    }
    var m = $('qaMsg');
    if (m) m.textContent = (q || tag)
      ? ('显示 ' + rows.length + ' / 共 ' + qaState.items.length + ' 条')
      : ('共 ' + qaState.items.length + ' 条');
  }
  function readQaForm() {
    var items = [];
    Array.prototype.forEach.call(document.querySelectorAll('#qaList .qa-row'), function (row) {
      var q = row.querySelector('.qa-q').value.trim();
      var a = row.querySelector('.qa-a').value.trim();
      var tag = row.querySelector('.qa-tag').value.trim();
      if (q && a) items.push({ q: q, a: a, tag: tag });
    });
    return { intro: $('qa-intro').value, items: items };
  }
  function loadQa() {
    api('/api/qa').then(function (r) {
      if (!r.ok) { toast(r.error || '读不到问答'); return; }
      qaState = { intro: (r.qa && r.qa.intro) || '', items: (r.qa && r.qa.items) || [] };
      if ($('qa-intro')) $('qa-intro').value = qaState.intro;
      renderQa();
    });
  }
  if ($('qaNew')) {
    $('qaNew').addEventListener('click', function () {
      qaState = readQaForm();
      if (qaState.items.length >= 200) { toast('最多 200 条'); return; }
      qaState.items.push({ q: '', a: '', tag: '' });
      renderQa();
      var rows = document.querySelectorAll('#qaList .qa-row');
      var last = rows[rows.length - 1];
      if (last) last.querySelector('.qa-q').focus();
    });
  }
  if ($('qaList')) {
    $('qaList').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-qadel]') : null;
      if (!b) return;
      var qi = Number(b.getAttribute('data-qadel'));
      var qq = (qaState.items[qi] && qaState.items[qi].q) || '';
      askConfirm('删除这条问答？', '会从列表里移除「' + qq.slice(0, 20) + '」。注意：还要点「保存问答」才真正生效，保存前可以先把文字复制走。', function () {
        qaState = readQaForm();
        qaState.items.splice(qi, 1);
        renderQa();
        paintDelMsg('#pane-qa [data-save="qa"]', '已从列表移除 1 条 · 点「保存问答」才生效', false);
        return Promise.resolve({ ok: true });
      });
    });
  }
  (function bindCmdk() {
    var d = $('cmdk'), inp = $('ckInput'), list = $('ckList');
    if (!d || !inp || !list) return;
    inp.addEventListener('input', function () { ckIndex = 0; paintCmdk(this.value.trim()); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); ckIndex = Math.min(ckIndex + 1, ckItems.length - 1); paintCmdk(this.value.trim()); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); ckIndex = Math.max(ckIndex - 1, 0); paintCmdk(this.value.trim()); }
      else if (e.key === 'Enter') { e.preventDefault(); var t = ckItems[ckIndex]; if (t) { closeCmdk(); go(t); } }
    });
    list.addEventListener('click', function (e) {
      var it = e.target.closest('[data-ck]');
      if (!it) return;
      closeCmdk();
      go(it.getAttribute('data-ck'));
    });
    d.addEventListener('click', function (e) { if (e.target === d) closeCmdk(); });
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); ckOpen ? closeCmdk() : openCmdk(); return; }
      if (e.key === '/' && !typing) { e.preventDefault(); openCmdk(); return; }
      if (e.key === 'Escape' && ckOpen) closeCmdk();
    });
    if ($('cmdkFab')) $('cmdkFab').addEventListener('click', openCmdk);
  /* 手机上侧栏是横向滚动条：x-start / x-end 控制两端渐隐，提示「还能划」 */
  (function () {
    var side = document.querySelector('.side');
    if (!side) return;
    function paintSide() {
      var max = side.scrollWidth - side.clientWidth;
      side.classList.toggle('x-start', side.scrollLeft > 4);
      side.classList.toggle('x-end', max <= 4 || side.scrollLeft >= max - 4);
    }
    side.addEventListener('scroll', paintSide, { passive: true });
    window.addEventListener('resize', paintSide);
    window.addEventListener('load', paintSide);
    setTimeout(paintSide, 80);
    window.__paintSide = paintSide;
  })();
  })();

  function openAdPrev(id) {
    var box = document.querySelector('[data-ad-slot="' + id + '"][data-ad-field="html"]');
    var dlg = $('adPrevDlg');
    var body = $('adPrevBody');
    if (!dlg || !body) return;
    var html = box ? String(box.value || '').trim() : '';
    if (!html) { toast('这段广告位还没填内容', false); return; }
    body.innerHTML = html.replace(/<script/gi, '&lt;script');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-adprev]') : null;
    if (b) { e.preventDefault(); openAdPrev(b.getAttribute('data-adprev')); }
  });
  var adPrevX = $('adPrevX');
  if (adPrevX) adPrevX.addEventListener('click', function () { var d = $('adPrevDlg'); if (d) d.close(); });
  // ---- 启动 ----
  var saved = sessionStorage.getItem(PW_KEY);
  if (saved) {
    pw = saved;
    enter();
  } else {
    $('gate').hidden = false;
  }
})();
</script>
</body>
</html>
`;


