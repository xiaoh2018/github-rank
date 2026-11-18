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
  '/js/bundle.js': ['js/bundle.js', 'application/javascript; charset=utf-8'],
  '/data/repos.js': ['data/repos.js', 'application/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/data/links.json': ['data/links.json', 'application/json; charset=utf-8'],
  '/data/site.json': ['data/site.json', 'application/json; charset=utf-8'],
  '/articles': ['articles.html', 'text/html; charset=utf-8'],
  '/articles.html': ['articles.html', 'text/html; charset=utf-8'],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && SITE[url.pathname]) {
        if (url.pathname === '/' || url.pathname === '/index.html') {
          ctx.waitUntil(maybeRefresh(env).catch((e) => console.log('auto refresh error: ' + String(e))));
        }
        return serveSite(env, SITE[url.pathname]);
      }
      if (url.pathname === '/robots.txt' && request.method === 'GET') {
        return new Response('User-agent: *\nAllow: /\nSitemap: ' + url.origin + '/sitemap.xml\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      if (url.pathname === '/sitemap.xml' && request.method === 'GET') {
        const seoSite = (await loadSiteRaw(env)).seo;
        const origin = seoSite.siteUrl ? seoSite.siteUrl.replace(/\/+$/, '') : url.origin;
        const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>' + origin + '/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n  <url><loc>' + origin + '/articles</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>\n</urlset>\n';
        return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
      }
      if (url.pathname === '/keepalive' && request.method === 'GET') {
        return Response.redirect(url.origin + '/admin#keepalive', 302);
      }
      if (url.pathname === '/api/status' && request.method === 'GET') {
        return json(await getStatus(env));
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
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(keepalive(env).then((r) => console.log(JSON.stringify(r))));
  },
};

function text(msg, status) {
  return new Response(msg, { status: status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// 从仓库 raw 地址读取站点文件，边缘缓存 5 分钟
async function serveSite(env, entry) {
  if (!env.REPO_OWNER || !env.REPO_NAME) {
    return text('还没配置 REPO_OWNER / REPO_NAME 变量，请按部署说明添加', 503);
  }
  const raw =
    'https://raw.githubusercontent.com/' + env.REPO_OWNER + '/' + env.REPO_NAME + '/' + branch(env) + '/' + entry[0];
  const r = await fetch(raw, { cf: { cacheTtl: 300, cacheEverything: true } });
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

// 后台可以保存的站点配置分组
const SITE_SECTIONS = ['ad', 'contact', 'beian', 'seo', 'geo'];

// 读取仓库 data/site.json（raw 地址，边缘缓存 5 分钟），给站点页和 sitemap 用；失败时用默认值
async function loadSiteRaw(env) {
  if (!env.REPO_OWNER || !env.REPO_NAME) return normalizeSite(null);
  const u = 'https://raw.githubusercontent.com/' + env.REPO_OWNER + '/' + env.REPO_NAME + '/' + branch(env) + '/' + SITE_FILE;
  const r = await fetch(u, { cf: { cacheTtl: 300, cacheEverything: true } });
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

async function getStatus(env) {
  const now = new Date();
  const next = fmtBJ(nextRunUTC(now)) + '（北京时间）';

  const miss = checkConfig(env);
  if (miss.length) {
    return { configured: false, error: '还没配置变量：' + miss.join('、') + '，请按部署说明添加', next: next };
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
  };
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
  return json({ ok: true, links: links });
}

// ---- 站点配置（广告 / 联系方式）：数据存在仓库 data/site.json ----
const SITE_FILE = 'data/site.json';
const AD_HTML_MAX = 20000;

function defaultSite() {
  return {
    ad: { enabled: false, html: '' },
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
    if (typeof value.enabled !== 'boolean') return { ok: false, error: '广告开关必须是 true 或 false' };
    const html = value.html == null ? '' : value.html;
    if (typeof html !== 'string') return { ok: false, error: '广告代码必须是文字' };
    if (html.length > AD_HTML_MAX) return { ok: false, error: '广告代码不能超过 ' + AD_HTML_MAX + ' 个字符' };
    return { ok: true, clean: { enabled: value.enabled, html: html } };
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
  return { ok: false, error: 'section 只能是 ad、contact、beian、seo 或 geo' };
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
    return json({ ok: false, error: 'section 只能是 ad、contact、beian、seo 或 geo' }, 400);
  }
  const check = checkSection(body.section, body.value);
  if (!check.ok) return json({ ok: false, error: check.error }, 400);

  const cur = await readSite(env);
  if (!cur.ok) return json({ ok: false, error: cur.error }, 502);
  const site = cur.site;
  site[body.section] = check.clean;

  const w = await writeSite(env, site, cur.sha);
  if (!w.ok) return json({ ok: false, error: w.error }, 500);
  return json({ ok: true, site: site });
}

// ---- 文章（GEO 内容）：数据存在仓库 data/articles.json ----
const ARTICLES_FILE = 'data/articles.json';
const ARTICLES_MAX = 200;
const ART_LIMITS = { title: 100, summary: 300, body: 5000 };

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
.pane{max-width:920px}
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
    <button type="button" class="nav" data-tab="overview">概览</button>
    <button type="button" class="nav" data-tab="links">友链</button>
    <button type="button" class="nav" data-tab="ad">广告</button>
    <button type="button" class="nav" data-tab="contact">联系方式</button>
    <button type="button" class="nav" data-tab="beian">备案信息</button>
    <button type="button" class="nav" data-tab="seo">SEO</button>
    <button type="button" class="nav" data-tab="geo">GEO 与文章</button>
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
      <div class="intro">友链会显示在排行榜页面的友情链接区域。名称建议 40 字以内，网址必须以 http:// 或 https:// 开头，最多 50 条。删除后约 5 分钟生效（页面有缓存）。</div>
      <div class="card">
        <div class="msg">当前 <span id="linkCount">0</span> 条</div>
        <table>
          <thead><tr><th>名称</th><th>网址</th><th style="width:90px">操作</th></tr></thead>
          <tbody id="linkBody"><tr><td colspan="3" class="empty">加载中…</td></tr></tbody>
        </table>
      </div>
    </section>

    <section class="pane" id="pane-ad" hidden>
      <div class="bar"><div><h1>广告</h1><div class="sub">站点上的广告位代码</div></div></div>
      <div class="intro">这里放广告代码（如联盟广告、统计代码）。开关打开后，代码会显示在站点页面上；关闭时页面不显示广告。代码直接粘贴 HTML 片段，最多 20000 字符。</div>
      <div class="card">
        <label class="toggle"><input type="checkbox" id="ad-enabled">显示广告</label>
        <label for="ad-html">广告代码（HTML）</label>
        <textarea class="code" id="ad-html" maxlength="20000" spellcheck="false"></textarea>
        <div class="hint">只粘贴来源可信的代码。拿不准时先关闭开关再保存，访客就看不到。</div>
        <div class="actions"><button type="button" data-save="ad">保存广告</button></div>
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

    <section class="pane" id="pane-seo" hidden>
      <div class="bar"><div><h1>SEO</h1><div class="sub">搜索引擎与分享卡片</div></div></div>
      <div class="intro">这些内容会写进页面标题和 meta 标签，决定搜索结果和微信、微博分享时显示的样子。全部留空时保持页面原样；填写后保存，约 5 分钟内生效（页面有缓存）。</div>
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
    </section>

    <section class="pane" id="pane-geo" hidden>
      <div class="bar"><div><h1>GEO 与文章</h1><div class="sub">给 AI 搜索和读者看的内容</div></div></div>
      <div class="intro">GEO 摘要和问答会帮助 AI 搜索（如 ChatGPT、Perplexity）准确理解并引用网站。文章用来沉淀长内容，也会被搜索引擎收录。两块都可以留空，留空时不影响网站正常访问。</div>
      <div class="card">
        <h2>GEO 摘要</h2>
        <p class="desc">2–3 句话说清网站是什么、收录了什么、多久更新一次。</p>
        <textarea id="geo-summary" maxlength="500" placeholder="本站每周自动抓取 GitHub 热门开源项目……"></textarea>
        <div class="hint">500 字以内。</div>
        <h2 style="margin-top:20px">常见问答</h2>
        <p class="desc">写访客最常问的问题和简短回答，最多 20 条。</p>
        <div id="faqList"></div>
        <div class="actions"><button type="button" class="ghost" id="faqAdd">新增一条</button></div>
        <div class="actions"><button type="button" data-save="geo">保存 GEO 设置</button></div>
      </div>
      <div class="card">
        <div class="bar" style="margin-bottom:6px">
          <div><h2>文章</h2><p class="desc">共 <span id="artCount">0</span> 篇。标题、摘要、正文会显示在文章页。</p></div>
          <button type="button" id="artNew">新增文章</button>
        </div>
        <table>
          <thead><tr><th>标题</th><th style="width:110px">日期</th><th>摘要</th><th style="width:130px">操作</th></tr></thead>
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
<dialog id="artDlg">
  <h3 id="artTitle">新增文章</h3>
  <p class="msg">标题必填；日期留空默认今天；正文段落之间空一行。</p>
  <label for="artTitleIn">标题</label>
  <input type="text" id="artTitleIn" maxlength="100">
  <div class="hint">100 字以内。</div>
  <label for="artDate">日期</label>
  <input type="date" id="artDate">
  <label for="artSummary">摘要</label>
  <textarea id="artSummary" maxlength="300"></textarea>
  <div class="hint">300 字以内，显示在文章列表里，也会被 AI 搜索引用。</div>
  <label for="artBody">正文（纯文本）</label>
  <textarea id="artBody" maxlength="5000" style="min-height:200px"></textarea>
  <div class="hint">5000 字以内，段落之间用空行分隔，不支持 HTML。</div>
  <div class="err" id="artErr"></div>
  <div class="actions"><button type="button" class="ghost" data-close="artDlg">取消</button><button type="button" id="artSubmit">保存文章</button></div>
</dialog>
<div class="toast" id="toast" role="status"></div>

<script>
(function () {
  'use strict';
  var PW_KEY = 'adminPw';
  var TABS = ['overview', 'links', 'ad', 'contact', 'beian', 'seo', 'geo'];
  var FIELDS = {
    ad: ['html'],
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
    var init = { method: opt.method || 'GET', headers: {} };
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
    askConfirm('删除友链', '确定删除「' + name + '」吗？删除后约 5 分钟生效。', function () {
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
    $('ad-enabled').checked = !!a.enabled;
    $('ad-html').value = a.html || '';
    $('contact-enabled').checked = !!c.enabled;
    $('beian-enabled').checked = !!b.enabled;
    var src = { contact: c, beian: b, seo: o, geo: g };
    Object.keys(src).forEach(function (sec) {
      FIELDS[sec].forEach(function (k) {
        var el = $(sec + '-' + k);
        if (el) el.value = src[sec][k] || '';
      });
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
      api('/api/site', { method: 'POST', body: { password: pw, section: sec, value: collect(sec) } }).then(function (r) {
        btn.disabled = false;
        if (r.ok) toast('已保存', true);
        else toast(r.error || '保存失败', false);
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
    var list = state.articles.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    $('artCount').textContent = list.length;
    if (!list.length) {
      $('artTbody').innerHTML = '<tr><td colspan="4" class="empty">还没有文章，点「新增文章」开始写</td></tr>';
      return;
    }
    $('artTbody').innerHTML = list.map(function (a) {
      return '<tr><td>' + esc(a.title) + '</td><td>' + esc(a.date) + '</td><td>' + esc(a.summary) +
        '</td><td><button type="button" class="ghost small" data-artedit="' + esc(a.id) + '">编辑</button> ' +
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
    $('artTitle').textContent = a ? '编辑文章' : '新增文章';
    $('artTitleIn').value = a ? a.title : '';
    $('artDate').value = a ? a.date : today();
    $('artSummary').value = a ? a.summary : '';
    $('artBody').value = a ? a.body : '';
    $('artErr').textContent = '';
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
  $('artTbody').addEventListener('click', function (e) {
    var t = e.target;
    var ed = t.getAttribute && t.getAttribute('data-artedit');
    var dl = t.getAttribute && t.getAttribute('data-artdel');
    if (ed != null) {
      var a = state.articles.filter(function (x) { return String(x.id) === ed; })[0];
      if (a) openArt(a);
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


