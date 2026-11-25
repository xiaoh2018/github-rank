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
  '/articles': ['articles.html', 'text/html; charset=utf-8'],
  '/articles.html': ['articles.html', 'text/html; charset=utf-8'],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // HEAD 也放行：监控探针、链接预检、社交平台抓取大量使用 HEAD，只认 GET 会被当成死链
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
      if (url.pathname === '/llms.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(await llmsTxt(env, url.origin), {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }
      if (url.pathname === '/' + indexNowKey(env) + '.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
        const key = indexNowKey(env);
        return new Response(request.method === 'HEAD' ? null : key, {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }
      if (url.pathname === '/sitemap.xml' && (request.method === 'GET' || request.method === 'HEAD')) {
        const seoSite = (await loadSiteRaw(env)).seo;
        const origin = seoSite.siteUrl ? seoSite.siteUrl.replace(/\/+$/, '') : url.origin;
        const arts = await rawJson(env, 'data/articles.json');
        const list = Array.isArray(arts) ? arts : [];
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        xml += '  <url><loc>' + origin + '/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n';
        xml += '  <url><loc>' + origin + '/articles</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>\n';
        for (const a of list.slice(0, 200)) {
          if (!a || !a.id) continue;
          const lm = a.date ? String(a.date).slice(0, 10) : '';
          xml += '  <url><loc>' + origin + '/articles#' + encodeURIComponent(String(a.id)) + '</loc>' +
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
      return new Response('Not found', { status: 404 });
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
  const cache = globalThis.caches.default;
  const items = {};
  await Promise.all(list.map(async (t) => {
    const key = new Request(new URL('/__desc_zh/' + encodeURIComponent(t), request.url).toString());
    const hit = await cache.match(key);
    if (hit) { items[t] = await hit.text(); return; }
    const zh = await translateText(t, env);
    if (!zh) return;
    items[t] = zh;
    ctx.waitUntil(cache.put(key, new Response(zh, { headers: { 'cache-control': 'public, max-age=2592000' } })));
  }));
  return json({ ok: true, items: items });
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

// MyMemory：免费、无需 Key。返回 { ok, text, error }，error 带类型前缀方便后台显示
async function translateMM(text, env) {
  const chunks = chunkText(text, 450);
  if (!chunks.length) return { ok: false, error: 'empty: 没有可翻译的内容' };
  const parts = [];
  for (const piece of chunks) {
    let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(piece) + '&langpair=en|zh-CN';
    // 带上联系邮箱，MyMemory 每天额度从 5000 提到 50000 字符
    url += '&de=' + encodeURIComponent(env.TRANSLATE_EMAIL || 'xiaoh2018@gmail.com');
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      return { ok: false, error: 'network: 连不上 MyMemory（' + (e && e.message ? e.message : 'fetch failed') + '）' };
    }
    if (r.status === 429 || r.status === 403) {
      return { ok: false, error: 'quota: MyMemory 当天免费额度用完了（HTTP ' + r.status + '），明天自动恢复' };
    }
    if (!r.ok) return { ok: false, error: 'http: MyMemory 返回 HTTP ' + r.status };
    let d = null;
    try {
      d = await r.json();
    } catch (e) {
      return { ok: false, error: 'parse: MyMemory 返回的不是 JSON' };
    }
    if (d && d.responseStatus !== 200) {
      const detail = String(d.responseDetails || d.responseStatus || '').slice(0, 90);
      if (/quota|limit/i.test(detail)) return { ok: false, error: 'quota: MyMemory 额度用尽（' + detail + '）' };
      return { ok: false, error: 'status: MyMemory 报错「' + detail + '」' };
    }
    const t = d && d.responseData && d.responseData.translatedText;
    if (!t || /MYMEMORY WARNING|QUOTA/i.test(t)) {
      return { ok: false, error: 'quota: MyMemory 提示额度用尽（' + String(t || '').slice(0, 60) + '）' };
    }
    parts.push(String(t));
  }
  return { ok: true, text: parts.join(' ') };
}

// Workers AI 翻译（m2m100）：需要在 Worker 上绑定 AI（变量名 AI）；没有绑定时直接跳过
async function translateAI(text, env) {
  if (!env.AI) return { ok: false, error: 'not-bound: 没有绑定 Workers AI（变量名必须是 AI）' };
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
async function staticReadmeZh(env, repo) {
  if (!env.REPO_OWNER || !env.REPO_NAME) return null;
  try {
    const r = await fetch('https://raw.githubusercontent.com/' + env.REPO_OWNER + '/' + env.REPO_NAME + '/' + branch(env) + '/data/readme-zh.json', { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) return null;
    const map = await r.json();
    return (map && map[repo]) || null;
  } catch (e) {
    return null;
  }
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
async function serveSite(env, entry) {
  if (!env.REPO_OWNER || !env.REPO_NAME) {
    return text('还没配置 REPO_OWNER / REPO_NAME 变量，请按部署说明添加', 503);
  }
  const raw =
    'https://raw.githubusercontent.com/' + env.REPO_OWNER + '/' + env.REPO_NAME + '/' + branch(env) + '/' + entry[0];
  const r = await fetch(raw, { cf: { cacheTtl: RAW_TTL, cacheEverything: true } });
  if (!r.ok) {
      return text('读取站点文件失败：' + r.status + '（请确认仓库是公开的，且文件已经推送到 ' + branch(env) + ' 分支）', 502);
    }
    if (entry[0] === 'index.html') {
      const html = applySeo(await r.text(), (await loadSiteRaw(env)).seo);
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
// 回源 raw.githubusercontent 时 CF 给子请求的缓存时长。以前是 300s，等于后台保存后
// 最多还要旧 5 分钟才换新；压到 60s，再用 warmEdge 主动换新，改完基本立刻生效。
const RAW_TTL = 60;

// 后台随时会改的三个 JSON：缓存必须很短，否则改完前台还是旧值（实测过）
const CONFIG_FILES = ['/data/site.json', '/data/links.json', '/data/articles.json', '/data/nav.json'];

// ttl=边缘保留秒数；browser=浏览器 max-age；swr=stale-while-revalidate
function cachePolicy(pathname) {
  if (pathname === '/sw.js') return { ttl: 60, browser: 60, sMaxAge: 60 };
  if (CONFIG_FILES.indexOf(pathname) >= 0) return { ttl: 60, browser: 60, sMaxAge: 60, swr: 300 };
  if (pathname.indexOf('/data/') === 0) return { ttl: 900, browser: 600, sMaxAge: 900, swr: 86400 };
  if (pathname === '/' || pathname === '/index.html' || pathname === '/nav' || pathname === '/articles' || pathname === '/articles.html') {
    return { ttl: 600, browser: 300, sMaxAge: 600, swr: 3600 };
  }
  // js / css / 图标 / manifest 这类 shell 文件几个月才变一次，浏览器可以放心长缓存
  return { ttl: 86400, browser: 604800, sMaxAge: 86400, swr: 604800 };
}

function cacheControlOf(p, immutable) {
  if (immutable) return 'public, max-age=31536000, immutable';
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
    await Promise.all(paths.map((p) => EDGE_CACHE.delete(new Request(EDGE_KEY_BASE + p))));
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
    await EDGE_CACHE.put(new Request(EDGE_KEY_BASE + pathname, { method: 'GET' }), new Response(buf, { status: 200, headers: headers }));
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
  const cacheKey = new Request(EDGE_KEY_BASE + pathname + (ver ? '?v=' + encodeURIComponent(ver) : ''), { method: 'GET' });

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

  const res = await serveSite(env, entry);
  const status = res.status;
  const buf = status === 200 ? await res.arrayBuffer() : null;
  const headers = new Headers();
  headers.set('content-type', entry[1]);
  headers.set('cache-control', cacheControlOf(pol, immutable));
  headers.set('x-edge', 'MISS');
  if (buf) headers.set('etag', '"h' + hash32(buf) + '"');
  // 首页提前告诉浏览器马上要用的两个脚本，少一轮「先拿 HTML 再发现脚本」
  if (pathname === '/' || pathname === '/index.html') {
    headers.set('link', '</js/bundle.js>; rel=preload; as=script, </data/repos-meta.js>; rel=preload; as=script');
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

// 后台可以保存的站点配置分组
const SITE_SECTIONS = ['ad', 'layout', 'contact', 'beian', 'seo', 'geo'];

// 读取仓库 data/site.json（raw 地址，边缘缓存 RAW_TTL 秒），给站点页和 sitemap 用；失败时用默认值
async function loadSiteRaw(env) {
  if (!env.REPO_OWNER || !env.REPO_NAME) return normalizeSite(null);
  const u = 'https://raw.githubusercontent.com/' + env.REPO_OWNER + '/' + env.REPO_NAME + '/' + branch(env) + '/' + SITE_FILE;
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

function branch(env) {
  return env.BRANCH || DEFAULT_BRANCH;
}

function repoApi(env, p) {
  return 'https://api.github.com/repos/' + env.REPO_OWNER + '/' + env.REPO_NAME + p;
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
    'https://raw.githubusercontent.com/' + env.REPO_OWNER + '/' + env.REPO_NAME + '/' + branch(env) + '/data/repos.js';
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
function translatorStatus(env) {
  return {
    githubToken: !!env.GITHUB_TOKEN,
    ai: !!env.AI,
    contactEmail: !!env.TRANSLATE_EMAIL,
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
  if (body.action !== 'add' && body.action !== 'remove') {
    return json({ ok: false, error: 'action 只能是 add 或 remove' }, 400);
  }

  const cur = await readLinks(env);
  if (!cur.ok) return json({ ok: false, error: cur.error }, 502);
  const links = cur.links;

  if (body.action === 'add') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!name) return json({ ok: false, error: '名称不能为空' }, 400);
    if (name.length > 40) return json({ ok: false, error: '名称不能超过 40 个字符' }, 400);
    if (!/^https?:\/\//i.test(url) || url.length > 300) {
      return json({ ok: false, error: '网址必须以 http:// 或 https:// 开头，且不超过 300 个字符' }, 400);
    }
    try {
      new URL(url);
    } catch (e) {
      return json({ ok: false, error: '网址格式不正确' }, 400);
    }
    if (links.length >= LINKS_MAX) return json({ ok: false, error: '友链最多 ' + LINKS_MAX + ' 条，请先删除再添加' }, 400);
    if (links.some((l) => l && l.url === url)) return json({ ok: false, error: '这个网址已经在友链里了' }, 409);
    links.push({ name: name, url: url });
  } else {
    const idx = body.index;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= links.length) {
      return json({ ok: false, error: '序号不正确' }, 400);
    }
    links.splice(idx, 1);
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
const NAV_FILE = 'data/nav.json';

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

function robotsTxt(origin) {
  let t = 'User-agent: *\nAllow: /\n\n';
  t += '# 各家 AI 搜索 / 大模型的抓取器：明确放行\n';
  for (const b of AI_BOTS) t += 'User-agent: ' + b + '\nAllow: /\n\n';
  t += 'Sitemap: ' + origin + '/sitemap.xml\n';
  t += '# 给大模型读的站点说明：' + origin + '/llms.txt\n';
  return t;
}

// IndexNow 的 key 会在 /<key>.txt 上公开，用来证明域名归属
function indexNowKey(env) {
  if (env.INDEXNOW_KEY && String(env.INDEXNOW_KEY).trim()) return String(env.INDEXNOW_KEY).trim();
  const seed = String(env.REPO_OWNER || '') + '/' + String(env.REPO_NAME || '') + '/' + branch(env);
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
  if (!env.REPO_OWNER || !env.REPO_NAME) return null;
  try {
    const r = await fetch(
      'https://raw.githubusercontent.com/' + env.REPO_OWNER + '/' + env.REPO_NAME + '/' + branch(env) + '/' + path,
      { cf: { cacheTtl: RAW_TTL, cacheEverything: true } }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// llms.txt：给大模型看的站点说明（llmstxt.org 约定）
async function llmsTxt(env, origin) {
  const site = (await loadSiteRaw(env)).seo || {};
  const root = site.siteUrl ? String(site.siteUrl).replace(/\/+$/, '') : origin;
  const arts = await rawJson(env, 'data/articles.json');
  const nav = await rawJson(env, 'data/nav.json');
  const lines = [];
  lines.push('# ' + (site.siteName || 'GitHub 热门项目排行榜'));
  lines.push('');
  lines.push('> ' + (site.description || '按星标数排序的 GitHub 热门项目榜单，支持近 7 天 / 30 天 / 1 年 / 全部，另有开发者榜、组织榜与常用站点导航。'));
  lines.push('');
  lines.push('## 页面');
  lines.push('');
  lines.push('- 榜单首页：' + root + '/ （项目榜，可切语言、时间范围、排序方式；另有开发者榜、组织榜）');
  lines.push('- 文章列表：' + root + '/articles （使用说明与更新记录）');
  lines.push('- 站点地图：' + root + '/sitemap.xml');
  lines.push('');
  const list = Array.isArray(arts) ? arts : [];
  if (list.length) {
    lines.push('## 文章');
    lines.push('');
    for (const a of list.slice(0, 50)) {
      if (!a || !a.title) continue;
      lines.push('- ' + String(a.title) + (a.date ? '（' + String(a.date).slice(0, 10) + '）' : '') +
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
  return lines.join('\n');
}

// 主动提交：IndexNow（Bing / Yandex / Seznam / Naver 共用）、百度普通收录推送
async function handleSubmit(request, env, origin) {
  if (request.method === 'GET') {
    const key = indexNowKey(env);
    return json({
      ok: true,
      status: {
        indexNowKey: key,
        keyFile: origin + '/' + key + '.txt',
        sitemap: origin + '/sitemap.xml',
        llms: origin + '/llms.txt',
        baiduToken: !!env.BAIDU_TOKEN,
      },
    });
  }
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: '没有设置 ADMIN_PASSWORD，后台已关闭' }, 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ ok: false, error: '请求体必须是 JSON' }, 400);
  if (!safeEqual(body.password == null ? '' : body.password, env.ADMIN_PASSWORD)) {
    return json({ ok: false, error: '密码不对' }, 403);
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
    if (a && a.id) urls.push(root + '/articles#' + encodeURIComponent(String(a.id)));
  });
  const want = String(body.action || 'all');
  const out = { ok: true, urls: urls.length, root: root, results: {} };

  if (want === 'all' || want === 'indexnow') {
    const key = indexNowKey(env);
    try {
      const r = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: host, key: key, keyLocation: root + '/' + key + '.txt', urlList: urls }),
      });
      out.results.indexNow = {
        ok: r.ok || r.status === 202,
        status: r.status,
        note: r.ok || r.status === 202
          ? '已提交给 IndexNow（Bing / Yandex / Seznam / Naver 共用一套）'
          : 'IndexNow 返回 HTTP ' + r.status,
      };
    } catch (e) {
      out.results.indexNow = { ok: false, status: 0, note: '连不上 api.indexnow.org：' + ((e && e.message) || 'network') };
    }
  }

  if (want === 'all' || want === 'baidu') {
    if (!env.BAIDU_TOKEN) {
      out.results.baidu = { ok: false, status: 0, note: '没配 BAIDU_TOKEN（百度搜索资源平台的准入密钥），跳过百度推送' };
    } else {
      try {
        const r = await fetch(
          'https://data.zz.baidu.com/urls?site=' + encodeURIComponent(root) + '&token=' + encodeURIComponent(env.BAIDU_TOKEN),
          { method: 'POST', headers: { 'content-type': 'text/plain' }, body: urls.join('\n') }
        );
        const t = await r.text();
        out.results.baidu = { ok: r.ok, status: r.status, note: String(t).slice(0, 300) };
      } catch (e) {
        out.results.baidu = { ok: false, status: 0, note: '连不上百度推送接口：' + ((e && e.message) || 'network') };
      }
    }
  }

  return json(out);
}

const SITE_FILE = 'data/site.json';
const AD_HTML_MAX = 20000;
// 广告位：id 是前端约定的槽位名，name/where 只用于后台展示
const AD_SLOTS = [
  { id: 'home-top', name: '首页顶部横幅', where: '页头下面、统计卡上面，通栏' },
  { id: 'list-top', name: '榜单上方', where: '搜索筛选栏下面、榜单开始之前' },
  { id: 'list-bottom', name: '榜单下方', where: '分页器下面、文章区之前' },
  { id: 'sidebar', name: '侧栏底部', where: '右侧栏「变化」卡片下面；侧栏下沉时跟着走' },
  { id: 'article', name: '文章区上方', where: '首页文章列表上方（文章详情页顶部也用它）' },
  { id: 'list-inline', name: '榜单信息流', where: '榜单列表里每 10 个项目之间插一条（分页器不受影响）' },
  { id: 'article-inline', name: '文章信息流', where: '首页文章列表里每 2 篇文章之间插一条' },
  { id: 'nav-inline', name: '导航信息流', where: '导航页每个分组里每 8 个站点之间插一条' },
];

function emptyAdSlots() {
  const o = {};
  for (const s of AD_SLOTS) o[s.id] = { enabled: false, html: '' };
  return o;
}

function defaultSite() {
  return {
    ad: { enabled: false, html: '', slots: emptyAdSlots() },
    layout: { mode: 'auto', side: 'right', users: 'auto' },
    contact: { enabled: false, title: '联系我', wechat: '', qrUrl: '', email: '', note: '' },
    beian: { enabled: false, icp: '', icpUrl: 'https://beian.miit.gov.cn/', police: '', policeUrl: '', text: '' },
    seo: { siteName: '', title: '', description: '', keywords: '', ogImage: '', siteUrl: '' },
    geo: { summary: '', faq: [{ q: '', a: '' }] },
  };
}

// 读出来的内容统一成标准结构，缺的字段用默认值补齐
function normalizeSite(o) {
  const d = defaultSite();
  const ad = o && typeof o.ad === 'object' && o.ad ? o.ad : {};
  const c = o && typeof o.contact === 'object' && o.contact ? o.contact : {};
  const str = (v, fb) => (typeof v === 'string' ? v : fb);
  d.ad.enabled = ad.enabled === true;
  d.ad.html = str(ad.html, '');
  const rawSlots = ad.slots && typeof ad.slots === 'object' ? ad.slots : null;
  if (rawSlots) {
    for (const s of AD_SLOTS) {
      const v = rawSlots[s.id];
      if (v && typeof v === 'object') {
        d.ad.slots[s.id] = { enabled: v.enabled === true, html: str(v.html, '').slice(0, AD_HTML_MAX) };
      }
    }
  } else if (d.ad.enabled && d.ad.html.trim()) {
    // 老结构（只有 ad.enabled + ad.html）：当成「首页顶部横幅」，保证升级后原有广告继续显示
    d.ad.slots['home-top'] = { enabled: true, html: d.ad.html };
  }
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
  d.layout.users = ['auto', 'single', 'double'].indexOf(lo.users) >= 0 ? lo.users : 'auto';
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
  if (section === 'ad') {
    // 新结构：{ slots: { '<槽位>': { enabled, html } } }；老结构 { enabled, html } 仍然接受
    const clean = { enabled: false, html: '', slots: emptyAdSlots() };
    if (value.slots && typeof value.slots === 'object' && !Array.isArray(value.slots)) {
      for (const key of Object.keys(value.slots)) {
        if (!AD_SLOTS.some((s) => s.id === key)) {
          return { ok: false, error: '不认识的广告位：' + key + '（可选：' + AD_SLOTS.map((s) => s.id).join('、') + '）' };
        }
        const v = value.slots[key] || {};
        if (typeof v.enabled !== 'boolean') return { ok: false, error: '广告位「' + key + '」的开关必须是 true 或 false' };
        const html = v.html == null ? '' : v.html;
        if (typeof html !== 'string') return { ok: false, error: '广告位「' + key + '」的代码必须是文字' };
        if (html.length > AD_HTML_MAX) return { ok: false, error: '广告位「' + key + '」的代码不能超过 ' + AD_HTML_MAX + ' 个字符' };
        clean.slots[key] = { enabled: v.enabled, html: html };
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
    clean.slots['home-top'] = { enabled: value.enabled, html: html };
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
    if (['auto', 'single', 'double'].indexOf(users) < 0) return { ok: false, error: '开发者/组织榜列数只能是 auto、single 或 double' };
    return { ok: true, clean: { mode: mode, side: side, users: users } };
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
  return { ok: false, error: 'section 只能是 ad、layout、contact、beian、seo 或 geo' };
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
    const status = translatorStatus(env);
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
    const mm = await translateMM(text, env);
    out.myMemory = { ok: mm.ok === true, text: mm.text || '', ms: Date.now() - t0, error: mm.ok ? null : String(mm.error || 'unknown') };
    if (env.AI) {
      const t1 = Date.now();
      const ai = await translateAI(text, env);
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
    return json({ ok: false, error: 'section 只能是 ad、layout、contact、beian、seo 或 geo' }, 400);
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
  return json({ ok: true, site: site });
}

// ---- 文章（GEO 内容）：数据存在仓库 data/articles.json ----
const ARTICLES_FILE = 'data/articles.json';
const ARTICLES_MAX = 200;
const ART_LIMITS = { title: 100, summary: 300, body: 20000 };

function todayBJ() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
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

// 校验一篇文章：title / summary / body 为文字，date 为 YYYY-MM-DD（缺省为今天）
function checkArticle(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: '文章内容必须是对象' };
  const clean = {};
  for (const k of ['title', 'summary', 'body']) {
    const s = v[k] == null ? '' : v[k];
    if (typeof s !== 'string') return { ok: false, error: '文章的「' + k + '」必须是文字' };
    const t = s.replace(/\r\n/g, '\n').trim();
    if (t.length > ART_LIMITS[k]) return { ok: false, error: '文章的「' + k + '」不能超过 ' + ART_LIMITS[k] + ' 个字符' };
    clean[k] = t;
  }
  if (!clean.title) return { ok: false, error: '文章标题不能为空' };
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
    return json({ ok: true, articles: r.articles });
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
  if (body.action !== 'add' && body.action !== 'update' && body.action !== 'remove') {
    return json({ ok: false, error: 'action 只能是 add、update 或 remove' }, 400);
  }

  const cur = await readArticles(env);
  if (!cur.ok) return json({ ok: false, error: cur.error }, 502);
  const list = cur.articles;

  if (body.action === 'add') {
    const c = checkArticle(body.article);
    if (!c.ok) return json({ ok: false, error: c.error }, 400);
    if (list.length >= ARTICLES_MAX) return json({ ok: false, error: '文章最多 ' + ARTICLES_MAX + ' 篇，请先删除旧文章' }, 400);
    let id = String(Date.now());
    while (list.some((a) => a && String(a.id) === id)) id = String(Number(id) + 1);
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
      list[idx] = Object.assign({ id: id }, c.clean);
    }
  }

  const w = await writeArticles(env, list, cur.sha, 'chore: update articles');
  if (!w.ok) return json({ ok: false, error: w.error }, 500);
  await purgeEdge(['/articles', '/articles.html', '/data/articles.json']);
  await warmEdge('/data/articles.json', JSON.stringify(list, null, 2) + '\n', 'application/json; charset=utf-8');
  return json({ ok: true, articles: list });
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
.toggle{display:flex;align-items:center;gap:10px;margin:4px 0 2px;font-weight:600;color:var(--text)}
.toggle input{width:20px;height:20px;margin:0}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top;word-break:break-all}
th{color:var(--muted);font-weight:600;font-size:13px}
.empty{color:var(--muted);padding:18px 0;text-align:center;font-size:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:14px}
.stat{background:#f8fafc;border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.stat b{display:block;font-size:12px;color:var(--muted);font-weight:500}
.stat span{font-size:15px;font-weight:600}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#94a3b8;margin-right:8px;vertical-align:middle}
.dot.ok{background:var(--ok)}
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
.row-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 4px}
    /* ---- 广告位 ---- */
    .ad-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;margin-bottom:14px}
    .ad-card{margin:0}
    .ad-card .hint{margin:2px 0 8px}
    .ad-code{min-height:96px;margin-top:6px}
    code.slot-id{font-size:11px;padding:2px 6px;border-radius:6px;background:#f1f5f9;color:#475569;font-weight:600}
    /* ---- 导航页后台 ---- */
    #navAdmin .card{margin-bottom:14px}
    .nav-g-head{display:flex;gap:8px;flex-wrap:wrap;flex:1;min-width:0}
    .nav-g-head input{max-width:260px}
    #navAdmin td input{font-size:13px;padding:7px 9px}
    #navAdmin table{margin-top:6px}
/* ---- 单选卡片（布局设置） ---- */
.choice-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:10px;margin:10px 0 4px}
.choice{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0;cursor:pointer;background:#fff;font-weight:600;color:var(--text)}
.choice:hover{border-color:#94a3b8}
.choice input{width:18px;height:18px;margin:0;flex:none}
.choice:has(input:checked){border-color:var(--brand);background:#eff6ff;box-shadow:0 0 0 1px var(--brand) inset}
.choice-t{display:flex;flex-direction:column;font-size:14px}
.choice-t b{font-weight:400;font-size:12px;color:var(--muted);margin-top:2px}
/* ---- 状态清单 / 键值 ---- */
.status-list{display:grid;gap:8px;margin-top:8px}
.status-item{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px}
.status-item .dot{margin:0}
.status-item small{color:var(--muted);margin-left:auto;font-size:12px;text-align:right}
.kv{display:grid;grid-template-columns:132px minmax(0,1fr);gap:10px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px}
.kv:last-child{border-bottom:0;padding-bottom:0}
.kv b{font-family:Consolas,ui-monospace,monospace;font-size:13px}
.kv span{color:#334155}
.tr-out{display:grid;gap:10px;margin-top:14px}
.tr-box{border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:14px;background:#f8fafc}
.tr-box h4{margin:0 0 6px;font-size:12px;color:var(--muted);font-weight:600}
.tr-box p{margin:0;color:var(--text);word-break:break-word;line-height:1.6}
.tr-bad{border-color:#fecaca;background:#fef2f2}
/* ---- 宽弹窗（写文章） ---- */
dialog.wide{width:min(1120px,calc(100% - 24px));max-height:calc(100dvh - 24px);padding:0;overflow:hidden}
dialog.wide[open]{display:grid;grid-template-rows:auto minmax(0,1fr)}
dialog.wide.full{width:calc(100% - 16px);max-height:calc(100dvh - 16px)}
.dlg-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:16px 22px;border-bottom:1px solid var(--line)}
.dlg-head h3{margin:0 0 2px}
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
dialog h3{margin:0 0 4px;font-size:18px}
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
</style>
</head>
<body>
<div id="gate">
  <form class="gbox" id="loginForm">
    <h1>网站管理后台</h1>
    <label for="pw">管理密码</label>
    <input type="password" id="pw" autocomplete="current-password">
    <div class="actions"><button type="submit" id="loginBtn" style="width:100%">进入后台</button></div>
    <div class="err" id="loginErr"></div>
  </form>
</div>

<div class="app" id="app" hidden>
  <aside class="side">
    <div class="brand">网站管理后台<small>仅管理员可见</small></div>
    <div class="navgroup">常用</div>
    <button type="button" class="nav" data-tab="overview">概览</button>
    <button type="button" class="nav" data-tab="layout">榜单布局</button>
    <button type="button" class="nav" data-tab="articles">文章<span class="nav-badge" id="navArtCount" hidden>0</span></button>
    <div class="navgroup">内容</div>
    <button type="button" class="nav" data-tab="seo">SEO 与 GEO</button>
    <button type="button" class="nav" data-tab="links">友链</button>
    <button type="button" class="nav" data-tab="nav">导航页<span class="nav-badge" id="navItemCount" hidden>0</span></button>
    <button type="button" class="nav" data-tab="ad">广告</button>
    <div class="navgroup">站点信息</div>
    <button type="button" class="nav" data-tab="contact">联系方式</button>
    <button type="button" class="nav" data-tab="beian">备案信息</button>
    <div class="navgroup">运维</div>
    <button type="button" class="nav" data-tab="submit">收录提交</button>
    <button type="button" class="nav" data-tab="translate">翻译与密钥</button>
    </aside>

  <main class="main">

    <section class="pane" id="pane-overview">
      <div class="bar"><div><h1>概览</h1><div class="sub">保活状态与定时任务</div></div></div>
      <div class="intro">这里显示仓库的保活状态。GitHub 连续 60 天没有提交，定时任务就会被停用，所以系统每周自动写入一次时间戳。平时不需要操作；如果状态是「注意」或「有风险」，点下方按钮立即保活一次。</div>
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
          <thead><tr><th>名称</th><th>网址</th><th style="width:90px">操作</th></tr></thead>
          <tbody id="linkBody"><tr><td colspan="3" class="empty">加载中…</td></tr></tbody>
        </table>
      </div>
    </section>

    <section class="pane" id="pane-ad" hidden>
      <div class="bar"><div><h1>广告</h1><div class="sub">${AD_SLOTS.length} 个广告位，各自独立开关（含 3 个信息流位）</div></div></div>
      <div class="intro">前台一共有 ${AD_SLOTS.length} 个位置，每个位置单独开关、单独粘代码：勾上并保存就出现在那个位置，不勾就完全不渲染（不会留空占位）。<b>固定位</b>（home-top / list-top / list-bottom / sidebar / article）是通栏；<b>信息流位</b>（list-inline / article-inline / nav-inline）是插在列表中间的——榜单每 10 个项目一条、文章每 2 篇一条、导航每组每 8 个站点一条，位置会自动跟着数据走。代码直接粘贴 HTML 片段（联盟广告、统计脚本都行），带 <code>&lt;script&gt;</code> 也会执行；每格最多 20000 字符。只粘贴来源可信的代码，拿不准就先别勾。位置示意图见 <code>docs/shots/ad-slots.png</code>。</div>
      <div class="ad-grid">
${AD_SLOTS.map(
  (s) => `        <div class="card ad-card">
          <div class="card-head"><b>${s.name}</b><code class="slot-id">${s.id}</code></div>
          <div class="hint">${s.where}</div>
          <label class="toggle"><input type="checkbox" data-ad-slot="${s.id}" data-ad-field="enabled">在这里显示</label>
          <textarea class="code ad-code" data-ad-slot="${s.id}" data-ad-field="html" maxlength="20000" spellcheck="false" placeholder="粘贴广告 HTML 片段…"></textarea>
        </div>`
).join('\n')}
      </div>
      <div class="card">
        <div class="actions"><button type="button" data-save="ad">保存全部广告位</button></div>
        <div class="hint">保存后前台刷新立刻生效（Worker 会把新配置直接写回边缘缓存）。</div>
      </div>
    </section>

      <section class="pane" id="pane-translate" hidden>
        <div class="bar"><div><h1>翻译与密钥</h1><div class="sub">简介的中文是自动翻的；这里看链路状态、实测一次、确认密钥是否就位</div></div></div>
        <div class="intro">翻译顺序：<b>先查译文缓存</b>（同一段英文只翻一次，不会重复花钱花额度）→ <b>MyMemory</b>（免费、不需要 Key，带联系邮箱每天约 5 万字符）→ <b>Workers AI</b>（需要在 Cloudflare 绑定，变量名必须是 <b>AI</b>）。长文本会按句子切成小块逐段翻，失败原因会分类显示（网络不通 / 额度用完 / 服务端报错 / 未绑定）。两条链路都不用在后台填任何东西，GitHub Token 也只放在 Cloudflare 的 Variables and Secrets 里。</div>
        <div class="card">
          <div class="card-head"><div><h2>链路状态</h2><p class="desc">只显示「有没有」，不会显示任何密钥内容。</p></div><button type="button" class="ghost small" id="trReload">刷新</button></div>
          <div class="status-list" id="trStatus"><p class="empty">读取中…</p></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>实测一次</h2><p class="desc">拿一段英文同时打两条链路，看谁给出结果、各花多少毫秒。</p></div></div>
          <label for="trText">英文原文</label>
          <textarea id="trText" maxlength="400" spellcheck="false">A fast, static GitHub trending board built on Cloudflare Workers.</textarea>
          <div class="hint">400 字以内；留空会用默认示例句。</div>
          <div class="actions"><button type="button" id="trRun">开始实测</button><span class="msg" id="trNote"></span></div>
          <div id="trOut"></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>两个密钥怎么设</h2><p class="desc">都在 Cloudflare 面板 → 你的 Worker → Settings 里改，改完记得 Deploy。</p></div></div>
          <div class="kv"><b>GITHUB_TOKEN</b><span>Variables and Secrets → 添加 Secret。权限给 Contents: Read and write、Actions: Read and write（保活和工作流状态要用）。</span></div>
          <div class="kv"><b>Workers AI</b><span>Bindings → + Add → Workers AI，Variable name 填 <b>AI</b>（必须大写），保存后 Deploy。绑定后 MyMemory 限流时自动兜底。</span></div>
          <div class="kv"><b>TRANSLATE_EMAIL</b><span>可选。填邮箱后 MyMemory 每日额度从 5000 字符提到 50000。</span></div>
        </div>
      </section>


    <section class="pane" id="pane-layout" hidden>
        <div class="bar"><div><h1>榜单布局</h1><div class="sub">榜单几列、侧栏放哪、开发者 / 组织榜怎么排</div></div></div>
        <div class="intro">这三项都只影响排版，不影响数据。保存后刷新首页立刻生效；移动端一律单列，避免挤成一条。</div>
        <div class="card">
          <div class="card-head"><div><h2>榜单列数</h2><p class="desc">项目榜、开发者榜、组织榜都用这一档。</p></div></div>
          <div class="choice-grid">
            <label class="choice"><input type="radio" name="layout-mode" value="auto"><span class="choice-t">自动<b>随屏幕宽度</b></span></label>
            <label class="choice"><input type="radio" name="layout-mode" value="single"><span class="choice-t">单列<b>一行一个</b></span></label>
            <label class="choice"><input type="radio" name="layout-mode" value="double"><span class="choice-t">双列<b>900px 以上两栏</b></span></label>
            <label class="choice"><input type="radio" name="layout-mode" value="triple"><span class="choice-t">三列<b>1280px 以上三栏</b></span></label>
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
            <label class="choice"><input type="radio" name="layout-users" value="single"><span class="choice-t">单列</span></label>
            <label class="choice"><input type="radio" name="layout-users" value="double"><span class="choice-t">双列</span></label>
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
      <div class="bar"><div><h1>导航页</h1><div class="sub">前台「榜单 / 导航」两个标签里的导航那一栏</div></div><div class="row-actions"><button type="button" id="navAddGroup">＋ 分类</button></div></div>
      <div class="intro">前台顶部有「榜单」和「导航」两个标签，这里是导航栏的分类与站点卡片。填了网址可以点「自动获取」把网页标题、描述、图标抓回来（抓不到就自己写），保存后前台刷新立刻生效。分类最多 20 个、站点最多 400 个。</div>
      <div id="navAdmin"><p class="empty">读取中…</p></div>
      <div class="card">
        <div class="actions"><button type="button" data-save="nav">保存导航页</button><span class="msg" id="navMsg"></span></div>
        <div class="hint">保存会写回仓库的 <code>data/nav.json</code>，并立刻刷新边缘缓存。</div>
      </div>
    </section>

    <section class="pane" id="pane-submit" hidden>
      <div class="bar"><div><h1>收录提交</h1><div class="sub">把站点推给搜索引擎和 AI 搜索</div></div><div class="row-actions"><button type="button" id="subRun">立即提交</button></div></div>
      <div class="intro">能自动推的就自动推：<b>IndexNow</b> 一次提交给 Bing / Yandex / Seznam / Naver；<b>百度</b>要在 Cloudflare 配 <b>BAIDU_TOKEN</b> 才能推。豆包、通义千问、DeepSeek、ChatGPT 这些<b>没有公开的提交入口</b>，能做的三件事本站已经都做了：robots.txt 明确放行它们的抓取器、提供 llms.txt 站点说明、提供 sitemap.xml。抓取器来抓的时候拿到的就是最新榜单。</div>
      <div class="card">
        <div class="card-head"><div><h2>当前状态</h2><p class="desc">key 文件、站点地图、说明书的地址，填到对应平台即可。</p></div><button type="button" class="ghost small" id="subReload">刷新</button></div>
        <div class="status-list" id="subStatus"><p class="empty">读取中…</p></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>提交结果</h2><p class="desc">点右上角「立即提交」会真的发请求出去。</p></div></div>
        <div id="subOut"><p class="note">还没提交过。</p></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>这些 Token 在哪拿</h2><p class="desc">全是免费的，点进去按下面一句话操作就行。</p></div></div>
        <div class="kv"><b>百度推送 token</b><span><a href="https://ziyuan.baidu.com/dailysubmit/index" target="_blank" rel="noopener">百度搜索资源平台 → 普通收录 → API 提交</a>：先加站点并验证，然后复制页面上的「准入密钥」，到 Cloudflare 变量里存成 <code>BAIDU_TOKEN</code>；同一页能看到当天剩余配额（普通账号每天几百条）。</span></div>
        <div class="kv"><b>IndexNow key（Bing / Yandex）</b><span>不用申请，本站已经自动生成并挂在 <code>/&lt;key&gt;.txt</code> 上（地址见上方「当前状态」）。想看推送记录去 <a href="https://www.bing.com/webmasters/indexnow" target="_blank" rel="noopener">Bing Webmaster Tools → IndexNow</a>；想换 key 就在 Cloudflare 变量里加 <code>INDEXNOW_KEY</code>（32 位字母数字）。</span></div>
        <div class="kv"><b>Google</b><span><a href="https://search.google.com/search-console" target="_blank" rel="noopener">Search Console</a> → 左侧「站点地图」→ 填 <code>sitemap.xml</code> → 提交。Google 2023 年就关了 ping 接口，只能在这里交，没有 token。</span></div>
        <div class="kv"><b>Cloudflare API Token（自动部署用）</b><span><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">dash.cloudflare.com/profile/api-tokens</a> → 「创建令牌」→ 选「编辑 Cloudflare Workers」模板 → 权限保留 <code>Account · Workers Scripts · Edit</code> 与 <code>Zone · Workers Routes · Edit</code> → 创建后那一串只显示一次，马上复制。</span></div>
        <div class="kv"><b>Cloudflare Account ID</b><span><a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">dash.cloudflare.com</a> 首页右侧栏「账户 ID」，或者看地址栏 <code>dash.cloudflare.com/&lt;这一串就是&gt;/...</code>。</span></div>
        <div class="kv"><b>存到哪里</b><span><a href="https://github.com/xiaoh2018/github-rank/settings/secrets/actions" target="_blank" rel="noopener">仓库 Settings → Secrets and variables → Actions</a>，New repository secret：<code>CLOUDFLARE_API_TOKEN</code>、<code>CLOUDFLARE_ACCOUNT_ID</code>（部署用）、<code>BAIDU_TOKEN</code>（百度推送用，也可放 Cloudflare 变量）。配好之后往 main 推代码就自动部署 Worker，不用再手粘代码。</span></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>手动入口</h2><p class="desc">自动推送覆盖不到的，去这些地方贴 sitemap 或网址。</p></div></div>
        <div class="kv"><b>Google</b><span>Search Console → 站点地图 → 填 <code>/sitemap.xml</code>。Google 已停用 ping 接口，只能在这里提交。</span></div>
        <div class="kv"><b>Bing</b><span>IndexNow 已经自动推；也可以在 Bing Webmaster Tools 里手动贴 sitemap。</span></div>
        <div class="kv"><b>百度</b><span>搜索资源平台 → 普通收录 → 提交 sitemap；配了 BAIDU_TOKEN 之后本站也能主动推。</span></div>
        <div class="kv"><b>AI 搜索</b><span>豆包 / 千问 / DeepSeek / Kimi / 秘塔 没有公开提交接口。已放行 GPTBot、ClaudeBot、PerplexityBot、Bytespider、Qwen-Bot 等抓取器，并提供 <code>/llms.txt</code> 作站点说明。</span></div>
      </div>
    </section>

    <section class="pane" id="pane-seo" hidden>
      <div class="bar"><div><h1>SEO 与 GEO</h1><div class="sub">搜索结果、分享卡片，以及给 AI 搜索看的摘要与问答</div></div></div>
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

    <section class="pane" id="pane-articles" hidden>
      <div class="bar">
        <div><h1>文章</h1><div class="sub">共 <span id="artCount">0</span> 篇，标题、摘要、正文会显示在站点的文章页</div></div>
        <button type="button" id="artNew">写新文章</button>
      </div>
      <div class="intro">文章用来沉淀长内容：会被搜索引擎收录，也会被 AI 搜索引用。正文支持 Markdown（标题、列表、代码块、链接、图片），写作时右侧实时预览。保存即发布，刷新文章页即可看到。</div>
      <div class="card">
        <div class="toolbar">
          <input type="text" id="artSearch" placeholder="搜索标题、摘要或正文…">
          <span class="msg" id="artSearchNote"></span>
        </div>
        <table>
          <thead><tr><th style="width:96px">日期</th><th>标题</th><th>摘要</th><th style="width:170px">操作</th></tr></thead>
          <tbody id="artTbody"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
        </table>
      </div>
    </section>

  </main>
</div>
<dialog id="addDlg">
  <h3>添加友链</h3>
  <p class="msg">名称和网址都会显示在排行榜页面上。</p>
  <label for="addName">名称</label>
  <input type="text" id="addName" maxlength="40" placeholder="例如：某某博客">
  <div class="hint">40 字以内。</div>
  <label for="addUrl">网址</label>
  <input type="url" id="addUrl" maxlength="300" placeholder="https://example.com">
  <div class="hint">必须以 http:// 或 https:// 开头。</div>
  <div class="err" id="addErr"></div>
  <div class="actions"><button type="button" class="ghost" data-close="addDlg">取消</button><button type="button" id="addSubmit">添加</button></div>
</dialog>
<dialog id="delDlg">
  <h3 id="delTitle">确认删除</h3>
  <p class="msg" id="delNote"></p>
  <div class="err" id="delErr"></div>
  <div class="actions"><button type="button" class="ghost" data-close="delDlg">取消</button><button type="button" class="danger" id="delSubmit">确定删除</button></div>
</dialog>
<dialog id="artDlg" class="wide">
  <div class="dlg-head">
    <div><h3 id="artTitle">写新文章</h3><p class="msg">标题必填；日期留空默认今天；正文支持 Markdown，段落之间空一行。</p></div>
    <div class="dlg-head-actions">
      <button type="button" class="ghost small" id="artFullBtn" title="铺满窗口">⤢ 放大</button>
      <button type="button" class="ghost small" data-close="artDlg">关闭</button>
    </div>
  </div>
  <div class="art-grid">
    <div class="art-col">
      <div class="field-row">
        <div><label for="artTitleIn">标题</label><input type="text" id="artTitleIn" maxlength="100" placeholder="例如：2026 年 11 月值得关注的 10 个项目"></div>
        <div><label for="artDate">日期</label><input type="date" id="artDate"></div>
      </div>
      <label for="artSummary">摘要</label>
      <textarea id="artSummary" maxlength="300" style="min-height:74px" placeholder="一两句话说清这篇讲什么，会显示在列表里，也会被 AI 搜索引用。"></textarea>
      <div class="row-actions">
        <button type="button" class="ghost small" id="artImport">导入 .md</button>
        <button type="button" class="ghost small" id="artPreviewBtn">隐藏预览</button>
        <span class="msg" id="artLen"></span>
        <input type="file" id="artFile" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden>
      </div>
      <label for="artBody">正文（Markdown）</label>
      <textarea id="artBody" maxlength="20000" class="art-body" spellcheck="false"></textarea>
      <div class="hint">20000 字以内。支持标题、列表、代码块、链接；图片写成 ![说明](图片网址)。不支持 HTML 标签。</div>
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
<script src="/js/md.js"></script>

<script>
(function () {
  'use strict';
  var PW_KEY = 'adminPw';
  var TABS = ['overview', 'layout', 'articles', 'nav', 'seo', 'links', 'ad', 'contact', 'beian', 'submit', 'translate'];
  var FIELDS = {
    ad: ['html'],
    layout: ['mode', 'side', 'users'],
    contact: ['title', 'wechat', 'qrUrl', 'email', 'note'],
    beian: ['icp', 'icpUrl', 'police', 'policeUrl', 'text'],
    seo: ['siteName', 'title', 'description', 'keywords', 'ogImage', 'siteUrl'],
    geo: ['summary']
  };
  var pw = '';
  var state = { links: [], articles: [], faq: [] };
  var editingId = null;
  var confirmFn = null;

  function $(id) { return document.getElementById(id); }
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
    loadLinks();
    loadSite();
    loadArticles();
    loadNavAdmin();
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
  function go(tab) {
    if (tab === 'keepalive') tab = 'overview';
    if (TABS.indexOf(tab) < 0) tab = 'overview';
    TABS.forEach(function (t) { $('pane-' + t).hidden = t !== tab; });
    document.querySelectorAll('.nav').forEach(function (b) {
      b.setAttribute('aria-current', b.getAttribute('data-tab') === tab ? 'true' : 'false');
    });
    history.replaceState(null, '', '#' + tab);
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.nav').forEach(function (b) {
    b.addEventListener('click', function () { go(b.getAttribute('data-tab')); });
  });

  // ---- 弹窗 ----
  function askConfirm(title, note, fn) {
    $('delTitle').textContent = title;
    $('delNote').textContent = note;
    $('delErr').textContent = '';
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
    if (c) $(c).close();
  });

  // ---- 概览：保活状态 ----
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
      b.innerHTML = '<tr><td colspan="3" class="empty">还没有友链，点右上角「添加友链」</td></tr>';
      return;
    }
    b.innerHTML = state.links.map(function (l, i) {
      return '<tr><td>' + esc(l.name) + '</td><td><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.url) +
        '</a></td><td><button type="button" class="danger small" data-del="' + i + '">删除</button></td></tr>';
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
  $('addLinkBtn').addEventListener('click', function () {
    $('addName').value = '';
    $('addUrl').value = '';
    $('addErr').textContent = '';
    $('addDlg').showModal();
  });
  $('addSubmit').addEventListener('click', function () {
    var name = $('addName').value.trim();
    var url = $('addUrl').value.trim();
    if (!name) { $('addErr').textContent = '请填写名称'; return; }
    if (!/^https?:\\/\\//i.test(url)) { $('addErr').textContent = '网址必须以 http:// 或 https:// 开头'; return; }
    var btn = this;
    btn.disabled = true;
    api('/api/links', { method: 'POST', body: { password: pw, action: 'add', name: name, url: url } }).then(function (r) {
      btn.disabled = false;
      if (r.ok) {
        state.links = r.links;
        renderLinks();
        $('addDlg').close();
        toast('已添加友链', true);
      } else {
        $('addErr').textContent = r.error || '添加失败';
      }
    });
  });
  $('linkBody').addEventListener('click', function (e) {
    var d = e.target.getAttribute && e.target.getAttribute('data-del');
    if (d == null) return;
    var i = Number(d);
    var name = state.links[i] ? state.links[i].name : '';
    askConfirm('删除友链', '确定删除「' + name + '」吗？删除后刷新首页立刻生效。', function () {
      return api('/api/links', { method: 'POST', body: { password: pw, action: 'remove', index: i } }).then(function (r) {
        if (r.ok) {
          state.links = r.links;
          renderLinks();
          toast('已删除', true);
        }
        return r;
      });
    });
  });

  // ---- 站点配置：广告 / 联系方式 / 备案 / SEO / GEO ----
  function fillSite(s) {
    var a = s.ad || {}, c = s.contact || {}, b = s.beian || {}, o = s.seo || {}, g = s.geo || {};
    // 广告：5 个槽位各自回填
    var adSlots = (a && a.slots && typeof a.slots === 'object') ? a.slots : null;
    Array.prototype.forEach.call(document.querySelectorAll('[data-ad-slot]'), function (el) {
      var id = el.getAttribute('data-ad-slot');
      var field = el.getAttribute('data-ad-field');
      var v = (adSlots && adSlots[id]) || null;
      if (!v && !adSlots && id === 'home-top') v = { enabled: a.enabled === true, html: a.html || '' };
      if (!v) v = { enabled: false, html: '' };
      if (field === 'enabled') el.checked = v.enabled === true;
      else el.value = typeof v.html === 'string' ? v.html : '';
    });
    $('contact-enabled').checked = !!c.enabled;
    $('beian-enabled').checked = !!b.enabled;
    var src = { contact: c, beian: b, seo: o, geo: g };
    Object.keys(src).forEach(function (sec) {
      FIELDS[sec].forEach(function (k) {
        var el = $(sec + '-' + k);
        if (el) el.value = src[sec][k] || '';
      });
    });
    var lay = s.layout || {};
    var picked = { 'layout-mode': lay.mode || 'auto', 'layout-side': lay.side || 'right', 'layout-users': lay.users || 'auto' };
    Object.keys(picked).forEach(function (name) {
      document.querySelectorAll('input[name="' + name + '"]').forEach(function (r) { r.checked = r.value === picked[name]; });
    });
    state.faq = Array.isArray(g.faq) ? g.faq.slice() : [];
    renderFaq();
  }
  function loadSite() {
    api('/api/site').then(function (r) {
      if (!r.ok) { toast(r.error || '读取站点配置失败', false); return; }
      fillSite(r.site);
    });
  }
  function collect(sec) {
    if (sec === 'nav') return navState || { groups: [] };
    if (sec === 'ad') {
      // 5 个广告位：按 data-ad-slot / data-ad-field 收集
      var slots = {};
      Array.prototype.forEach.call(document.querySelectorAll('[data-ad-slot]'), function (el) {
        var id = el.getAttribute('data-ad-slot');
        var field = el.getAttribute('data-ad-field');
        if (!slots[id]) slots[id] = { enabled: false, html: '' };
        if (field === 'enabled') slots[id].enabled = el.checked === true;
        else slots[id].html = el.value || '';
      });
      return { slots: slots };
    }
    if (sec === 'layout') {
      var pick = function (name, dflt) {
        var r = document.querySelector('input[name="' + name + '"]:checked');
        return r ? r.value : dflt;
      };
      return { mode: pick('layout-mode', 'auto'), side: pick('layout-side', 'right'), users: pick('layout-users', 'auto') };
    }
    var v = {};
    if (sec !== 'seo' && sec !== 'geo') v.enabled = $(sec + '-enabled').checked;
    FIELDS[sec].forEach(function (k) { v[k] = $(sec + '-' + k).value; });
    if (sec === 'geo') v.faq = readFaq();
    return v;
  }
  document.querySelectorAll('[data-save]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sec = btn.getAttribute('data-save');
      btn.disabled = true;
      var done = function (r) {
        btn.disabled = false;
        if (r.ok) toast('已保存', true);
        else toast(r.error || '保存失败', false);
      };
      if (sec === 'nav') {
        api('/api/nav', { method: 'POST', body: { password: pw, nav: collect('nav') } }).then(function (r) {
          done(r);
          if (r.ok && r.nav) { navState = r.nav; renderNavAdmin(); }
        });
        return;
      }
      api('/api/site', { method: 'POST', body: { password: pw, section: sec, value: collect(sec) } }).then(done);
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
      return '<div class="faq-row"><div><label>问题</label><input type="text" class="fq" maxlength="100" value="' + esc(f.q) +
        '"></div><div><label>回答</label><textarea class="fa" maxlength="500">' + esc(f.a) +
        '</textarea></div><div><button type="button" class="ghost small" data-faqdel="' + i + '">删除</button></div></div>';
    }).join('');
    $('faqList').innerHTML = h || '<p class="empty">还没有问答，点下方「新增一条」</p>';
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
  function renderArticles() {
    var box = $('artSearch');
    var q = (box && box.value || '').trim().toLowerCase();
    var all = state.articles.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    $('artCount').textContent = all.length;
    var badge = $('navArtCount');
    if (badge) { badge.textContent = all.length; badge.hidden = !all.length; }
    var list = q ? all.filter(function (a) {
      return (String(a.title) + ' ' + String(a.summary) + ' ' + String(a.body)).toLowerCase().indexOf(q) >= 0;
    }) : all;
    if ($('artSearchNote')) $('artSearchNote').textContent = q ? '匹配 ' + list.length + ' / ' + all.length + ' 篇' : '';
    if (!all.length) {
      $('artTbody').innerHTML = '<tr><td colspan="4" class="empty">还没有文章，右上角「写新文章」开始</td></tr>';
      return;
    }
    if (!list.length) {
      $('artTbody').innerHTML = '<tr><td colspan="4" class="empty">没有匹配的文章</td></tr>';
      return;
    }
    $('artTbody').innerHTML = list.map(function (a) {
      return '<tr><td>' + esc(a.date) + '</td><td><b>' + esc(a.title) + '</b></td><td>' + esc(a.summary) +
        '</td><td><button type="button" class="ghost small" data-artedit="' + esc(a.id) + '">编辑</button> ' +
        '<button type="button" class="ghost small" data-artview="' + esc(a.id) + '">预览</button> ' +
        '<button type="button" class="danger small" data-artdel="' + esc(a.id) + '">删除</button></td></tr>';
    }).join('');
  }
  function loadArticles() {
    api('/api/articles').then(function (r) {
      if (!r.ok) {
        $('artTbody').innerHTML = '<tr><td colspan="4" class="empty">' + esc(r.error) + '</td></tr>';
        return;
      }
      state.articles = r.articles || [];
      renderArticles();
    });
  }
  function openArt(a) {
    editingId = a ? a.id : null;
    $('artTitle').textContent = a ? '编辑文章' : '写新文章';
    $('artTitleIn').value = a ? a.title : '';
    $('artDate').value = a ? a.date : today();
    $('artSummary').value = a ? a.summary : '';
    $('artBody').value = a ? a.body : '';
    $('artErr').textContent = '';
    paintPreview();
    $('artDlg').showModal();
  }
  $('artNew').addEventListener('click', function () { openArt(null); });
  $('artSubmit').addEventListener('click', function () {
    var article = {
      title: $('artTitleIn').value,
      date: $('artDate').value || today(),
      summary: $('artSummary').value,
      body: $('artBody').value
    };
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
      };
      rd.readAsText(f, 'utf-8');
    });
    function paintPreview() {
      var body = $('artBody').value;
      if ($('artLen')) $('artLen').textContent = body.length ? body.length + ' / 20000 字' : '';
      $('artPrev').innerHTML = body.trim() ? KeeMd.render(body) : '<p class="empty">左边写正文，这里实时显示渲染效果</p>';
    }
    $('artBody').addEventListener('input', paintPreview);
    $('artPreviewBtn').addEventListener('click', function () {
      var grid = document.querySelector('#artDlg .art-grid');
      grid.classList.toggle('preview-off');
      this.textContent = grid.classList.contains('preview-off') ? '显示预览' : '隐藏预览';
    });
    $('artFullBtn').addEventListener('click', function () {
      var dlg = $('artDlg');
      dlg.classList.toggle('full');
      this.textContent = dlg.classList.contains('full') ? '⤡ 还原' : '⤢ 放大';
    });
    if ($('artSearch')) $('artSearch').addEventListener('input', renderArticles);
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
      askConfirm('删除文章', '确定删除《' + (art ? art.title : '') + '》吗？', function () {
        return api('/api/articles', { method: 'POST', body: { password: pw, action: 'remove', id: dl } }).then(function (r) {
          if (r.ok) {
            state.articles = r.articles;
            renderArticles();
            toast('已删除', true);
          }
          return r;
        });
      });
    }
  });

    // ---- 翻译与密钥：只显示状态；实测会真的打两条翻译链路 ----
    function trErr(s) {
      var raw = String(s == null ? '' : s);
      var m = raw.match(/^([a-z-]+):\s*([\s\S]*)$/);
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
        ['MyMemory', true, st.contactEmail ? '可用（已填联系邮箱，额度更高）' : '可用（免 Key；填 TRANSLATE_EMAIL 可提额）']
      ];
      $('trStatus').innerHTML = rows.map(function (r) {
        return '<div class="status-item"><span class="dot ' + (r[1] ? 'ok' : 'warn') + '"></span><b>' + esc(r[0]) +
          '</b><small>' + esc(r[2]) + '</small></div>';
      }).join('');
    }
    function loadTranslate() {
      api('/api/translate').then(function (r) {
        if (!r.ok) { $('trStatus').innerHTML = '<p class="empty">' + esc(r.error || '读取失败') + '</p>'; return; }
        paintTranslate(r.status);
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
  function navRowHtml(gi, ii, it) {
    return '<tr data-g="' + gi + '" data-i="' + ii + '">' +
      '<td><input type="text" data-f="name" value="' + navEsc(it.name) + '" placeholder="名称"></td>' +
      '<td><input type="text" data-f="url" value="' + navEsc(it.url) + '" placeholder="https://…"></td>' +
      '<td><input type="text" data-f="desc" value="' + navEsc(it.desc) + '" placeholder="一句话描述（可空）"></td>' +
      '<td><input type="text" data-f="icon" value="' + navEsc(it.icon) + '" placeholder="图标 URL（可空）"></td>' +
      '<td><div class="row-actions"><button type="button" class="ghost small" data-ifetch="1">自动获取</button>' +
      '<button type="button" class="ghost small danger" data-idel="1">删</button></div></td></tr>';
  }
  function renderNavAdmin() {
    var box = $('navAdmin');
    if (!box) return;
    navBadge();
    var gs = navState.groups || [];
    if (!gs.length) {
      box.innerHTML = '<p class="empty">还没有分类，点右上角「＋ 分类」开始。</p>';
      return;
    }
    box.innerHTML = gs.map(function (g, gi) {
      var rows = (g.items || []).map(function (it, ii) { return navRowHtml(gi, ii, it); }).join('');
      return '<div class="card nav-g">' +
        '<div class="card-head"><div class="nav-g-head">' +
        '<input type="text" data-gf="name" data-g="' + gi + '" value="' + navEsc(g.name) + '" placeholder="分类名">' +
        '<input type="text" data-gf="desc" data-g="' + gi + '" value="' + navEsc(g.desc) + '" placeholder="分类说明（可空）">' +
        '</div><div class="row-actions"><button type="button" class="ghost small" data-gadd="' + gi + '">＋ 站点</button>' +
        '<button type="button" class="ghost small danger" data-gdel="' + gi + '">删分类</button></div></div>' +
        (rows
          ? '<table><thead><tr><th style="width:150px">名称</th><th style="width:250px">网址</th><th>描述</th>' +
            '<th style="width:190px">图标</th><th style="width:150px">操作</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<p class="empty">这个分类还没有站点。</p>') +
        '</div>';
    }).join('');
  }
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
    var tr = el.closest ? el.closest('tr') : null;
    if (!tr) return;
    var g = parseInt(tr.getAttribute('data-g'), 10);
    var i = parseInt(tr.getAttribute('data-i'), 10);
    if (!navState.groups[g] || !navState.groups[g].items[i]) return;
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
  function subLine(label, value, ok) {
    return '<div class="status-item"><b>' + label + '</b><span' +
      (ok === false ? ' class="tr-bad"' : '') + '>' + value + '</span></div>';
  }
  function loadSubmit() {
    var box = $('subStatus');
    if (!box) return;
    api('/api/submit').then(function (r) {
      if (!r.ok || !r.status) {
        box.innerHTML = '<p class="empty">' + navEsc(trErr(r.error || '读取失败')) + '</p>';
        return;
      }
      var s = r.status;
      box.innerHTML =
        subLine('IndexNow key', '<code>' + navEsc(s.indexNowKey) + '</code>　key 文件：<code>' + navEsc(s.keyFile) + '</code>', true) +
        subLine('站点地图', '<a href="' + navEsc(s.sitemap) + '" target="_blank" rel="noopener">' + navEsc(s.sitemap) + '</a>', true) +
        subLine('大模型说明', '<a href="' + navEsc(s.llms) + '" target="_blank" rel="noopener">' + navEsc(s.llms) + '</a>（llms.txt，抓到就是最新榜单）', true) +
        subLine('百度推送', s.baiduToken ? '已配置 BAIDU_TOKEN，可以主动推' : '没配 BAIDU_TOKEN，点提交时会跳过百度', !!s.baiduToken);
    });
  }
  $('subReload').addEventListener('click', function () {
    $('subStatus').innerHTML = '<p class="empty">读取中…</p>';
    loadSubmit();
  });
  $('subRun').addEventListener('click', function () {
    var btn = $('subRun');
    var out = $('subOut');
    btn.disabled = true;
    btn.textContent = '提交中…';
    out.innerHTML = '<p class="note">正在提交…</p>';
    api('/api/submit', { method: 'POST', body: { password: pw, action: 'all' } }).then(function (r) {
      btn.disabled = false;
      btn.textContent = '立即提交';
      if (!r.ok) {
        out.innerHTML = '<div class="tr-box tr-bad">' + navEsc(trErr(r.error || '提交失败')) + '</div>';
        return;
      }
      var res = r.results || {};
      var html = '<div class="tr-box">本次提交 <b>' + (r.urls || 0) + '</b> 个地址（首页 + 文章列表 + 每篇文章）</div>';
      var keys = [['indexNow', 'IndexNow（Bing / Yandex / Naver）'], ['baidu', '百度普通收录']];
      keys.forEach(function (kv) {
        var o = res[kv[0]];
        if (!o) return;
        html += '<div class="tr-box' + (o.ok ? '' : ' tr-bad') + '"><b>' + kv[1] + '</b>· ' +
          (o.ok ? '成功' : '失败') + (o.status ? '（HTTP ' + o.status + '）' : '') +
          '<br>' + navEsc(o.note || '') + '</div>';
      });
      out.innerHTML = html;
      toast('提交完成', true);
    });
  });

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


