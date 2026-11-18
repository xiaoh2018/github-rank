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
        const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>' + url.origin + '/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n</urlset>\n';
        return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
      }
  if (url.pathname === '/keepalive' && request.method === 'GET') {
        return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
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
  return new Response(r.body, {
    headers: { 'content-type': entry[1], 'cache-control': 'public, max-age=300' },
  });
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
  return { ad: { enabled: false, html: '' }, contact: { enabled: false, title: '联系我', wechat: '', qrUrl: '', email: '', note: '' } };
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
  return { ok: false, error: 'section 只能是 ad 或 contact' };
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
  if (body.section !== 'ad' && body.section !== 'contact') {
    return json({ ok: false, error: 'section 只能是 ad 或 contact' }, 400);
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
body{margin:0;font:15px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f7fb;color:#1f2937}
.wrap{max-width:860px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#6b7280;margin:0 0 16px;font-size:14px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px;margin-bottom:16px;min-width:0}
.title{font-weight:600;font-size:17px}
label{display:block;font-size:13px;color:#6b7280;margin:12px 0 4px}
input[type=text],input[type=password],input[type=url],textarea{width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;font:inherit;font-size:15px;min-height:44px}
textarea{min-height:140px;font-family:Consolas,monospace;font-size:13px;resize:vertical}
button{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-size:15px;cursor:pointer;min-height:44px;font-family:inherit}
button.ghost{background:#fff;color:#1f2937;border:1px solid #e5e7eb}
button.del{background:#dc2626;padding:6px 12px;min-height:34px;font-size:14px}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
nav#tabs{display:flex;gap:8px;overflow-x:auto;white-space:nowrap;margin-bottom:16px;padding-bottom:4px;-webkit-overflow-scrolling:touch}
nav#tabs button{background:#fff;color:#1f2937;border:1px solid #e5e7eb;flex:none}
nav#tabs button[aria-selected=true]{background:#2563eb;color:#fff;border-color:#2563eb}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:14px;word-break:break-all}
.toggle{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:15px;color:#1f2937}
.toggle input{width:20px;height:20px;margin:0;min-height:0}
.note{color:#6b7280;font-size:13px}
.err-text{color:#dc2626;font-size:14px;min-height:20px;margin-top:8px}
.kv{margin-top:12px;font-size:15px}
.kv div{margin-top:4px}
.stat{font-size:20px;font-weight:600}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#9ca3af;margin-right:8px;vertical-align:middle}
.dot.ok{background:#16a34a}
.dot.warn{background:#d97706}
.dot.bad{background:#dc2626}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:calc(100% - 32px);padding:10px 16px;border-radius:10px;background:#1f2937;color:#fff;font-size:14px;display:none;z-index:50}
.toast.show{display:block}
.toast.ok{background:#16a34a}
.toast.err{background:#dc2626}
dialog{border:1px solid #e5e7eb;border-radius:14px;padding:24px;width:min(420px,calc(100% - 32px));color:#1f2937;background:#fff}
dialog::backdrop{background:rgba(15,23,42,.45)}
dialog:modal{overscroll-behavior:contain}
dialog::backdrop{overflow:hidden;overscroll-behavior:contain}
@media (max-width:560px){.wrap{padding:16px 12px}.card{padding:16px}}
</style>
</head>
<body>
<div class='wrap'>
<div class='top'>
<div><h1>网站管理后台</h1><div class='sub'>不需要改代码，点按钮就能管理友情链接、广告、联系方式，并手动保活。</div></div>
<button type='button' class='ghost' id='logout' hidden>退出登录</button>
</div>

<div class='card' id='gate'>
<div class='title' id='gateTitle'>请先登录</div>
<div class='note' id='gateNote'>输入管理密码。密码只保存在本次标签页里，关掉页面即失效。</div>
<form id='loginForm'>
<label for='pw'>管理密码</label>
<input id='pw' type='password' autocomplete='current-password'>
<div class='row'><button type='submit' id='loginBtn'>登录</button></div>
</form>
<div class='err-text' id='loginErr'></div>
</div>

<div id='app' hidden>
<nav id='tabs' role='tablist'>
<button type='button' role='tab' data-tab='links' aria-selected='true'>友情链接</button>
<button type='button' role='tab' data-tab='ad' aria-selected='false'>广告位</button>
<button type='button' role='tab' data-tab='contact' aria-selected='false'>联系方式</button>
<button type='button' role='tab' data-tab='keepalive' aria-selected='false'>保活</button>
</nav>

<section class='card' data-panel='links'>
<div class='top'>
<div><div class='title'>友情链接</div><div class='note'>这里的网站会显示在排行榜的友情链接区。点「删除」会先弹窗确认。上限 50 条。</div></div>
<button type='button' id='openAdd'>添加友链</button>
</div>
<table><thead><tr><th>名称</th><th>网址</th><th style='width:90px'>操作</th></tr></thead><tbody id='rows'></tbody></table>
<div class='note' id='linkCount'></div>
</section>

<section class='card' data-panel='ad' hidden>
<div class='title'>广告位</div>
<div class='note'>粘贴广告平台给的代码，保存后会显示在排行榜列表下方。关闭「启用广告」后不显示。</div>
<label for='adHtml'>广告代码（最多 20000 字）</label>
<textarea id='adHtml' maxlength='20000' placeholder='把广告平台给的代码粘贴到这里'></textarea>
<label class='toggle'><input type='checkbox' id='adOn'> 启用广告</label>
<div class='row'><button type='button' id='adSave'>保存广告</button></div>
</section>

<section class='card' data-panel='contact' hidden>
<div class='title'>联系方式</div>
<div class='note'>填写后会显示在排行榜页面上。二维码地址只能是 https:// 开头，或留空。</div>
<label for='conTitle'>标题（最多 20 字，留空则显示「联系我」）</label>
<input id='conTitle' type='text' maxlength='20'>
<label for='conWechat'>微信号（最多 60 字）</label>
<input id='conWechat' type='text' maxlength='60'>
<label for='conQr'>二维码图片地址（https:// 开头，最多 300 字，可留空）</label>
<input id='conQr' type='url' maxlength='300' placeholder='https://'>
<label for='conEmail'>邮箱（最多 120 字）</label>
<input id='conEmail' type='text' maxlength='120'>
<label for='conNote'>说明文字（最多 200 字）</label>
<textarea id='conNote' maxlength='200' style='min-height:80px'></textarea>
<label class='toggle'><input type='checkbox' id='conOn'> 启用联系方式</label>
<div class='row'><button type='button' id='conSave'>保存联系方式</button></div>
</section>

<section class='card' data-panel='keepalive' hidden>
<div class='title'>保活</div>
<div class='note'>每周自动往仓库提交一次记录，防止公开仓库 60 天没有活动后定时任务被停用。</div>
<div class='kv'>
<div><span class='dot' id='kDot'></span><span class='stat' id='kState'>读取中…</span></div>
<div class='note' id='kNote'></div>
</div>
<div class='kv'>
<div>上次保活（北京时间）：<span id='kLast'>—</span></div>
<div>下次保活：<span id='kNext'>—</span></div>
<div>数据更新任务（最近一次）：<span id='kWf'>—</span> <span class='note' id='kWfNote'></span></div>
</div>
<div class='row'>
<button type='button' id='runBtn'>立即保活一次</button>
<button type='button' class='ghost' id='refreshBtn'>刷新状态</button>
</div>
</section>
</div>
</div>

<div class='toast' id='toast' role='status' aria-live='polite'></div>

<dialog id='addDlg' aria-labelledby='addTitle' closedby='any'>
<form id='addForm' novalidate>
<div class='title' id='addTitle'>添加友链</div>
<label for='nm'>名称（必填，最多 40 字）</label>
<input id='nm' type='text' maxlength='40' autocomplete='off' autofocus>
<label for='ur'>网址（必须以 http:// 或 https:// 开头，最多 300 字）</label>
<input id='ur' type='url' maxlength='300' autocomplete='off' placeholder='https://'>
<div class='err-text' id='addErr'></div>
<div class='row' style='justify-content:flex-end'>
<button type='button' class='ghost' id='addCancel'>取消</button>
<button type='submit' id='addSubmit'>添加</button>
</div>
</form>
</dialog>

<dialog id='delDlg' aria-labelledby='delTitle' aria-describedby='delNote' closedby='any'>
<form method='dialog'>
<div class='title' id='delTitle'>确认删除</div>
<div class='note' id='delNote' style='margin-top:8px'></div>
<div class='row' style='justify-content:flex-end'>
<button value='cancel' class='ghost' autofocus>取消</button>
<button value='ok' class='del' style='padding:10px 18px;min-height:44px;font-size:15px'>删除</button>
</div>
</form>
</dialog>
<script>
(function(){
var KEY = 'adminPw';
var linkList = [];
var siteData = null;
var pendingDel = null;

function $(id) { return document.getElementById(id); }

function toast(msg, ok) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () { t.className = 'toast'; }, 3500);
}

function getPw() { return sessionStorage.getItem(KEY) || ''; }

function api(method, path, body) {
  var opt = { method: method, headers: {} };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  return fetch(path, opt).then(function (r) {
    return r.text().then(function (txt) {
      var j;
      try { j = JSON.parse(txt); } catch (e) { j = { ok: false, error: '服务器返回了非 JSON 内容（HTTP ' + r.status + '）' }; }
      if (!j || typeof j !== 'object') j = { ok: false, error: '返回内容格式不正确' };
      j._status = r.status;
      return j;
    });
  });
}

function openDialog(d) {
  if (typeof d.showModal !== 'function') {
    toast('当前浏览器版本较旧，无法打开弹窗，请升级到新版浏览器', false);
    return false;
  }
  if (!d.open) d.showModal();
  return true;
}

// 老浏览器不认识 closedby 时，手动实现「点遮罩关闭」
if (window.HTMLDialogElement && !('closedBy' in HTMLDialogElement.prototype)) {
  Array.prototype.forEach.call(document.querySelectorAll('dialog[closedby="any"]'), function (dlg) {
    var pressedOutside = false;
    function outside(e) {
      var r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    }
    dlg.addEventListener('pointerdown', function (e) { pressedOutside = outside(e); });
    dlg.addEventListener('pointerup', function (e) { if (pressedOutside && outside(e) && dlg.open) dlg.close(); });
  });
}

// ---- 登录 ----
function showGate(note) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('logout').hidden = true;
  $('gateNote').textContent = note || '输入管理密码。密码只保存在本次标签页里，关掉页面即失效。';
}

function enterApp() {
  $('gate').hidden = true;
  $('app').hidden = false;
  $('logout').hidden = false;
  loadLinks();
  loadSite();
  loadStatus();
}

function tryLogin(pw) {
  return api('POST', '/api/admin/check', { password: pw }).then(function (j) {
    if (j.ok === true) return { ok: true };
    if (j._status === 403) return { ok: false, disabled: true, error: '后台未启用：请在 Cloudflare 添加 ADMIN_PASSWORD' };
    return { ok: false, error: j.error || '密码不对' };
  }).catch(function (e) {
    return { ok: false, error: '请求失败：' + e };
  });
}

$('loginForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var pw = $('pw').value;
  if (!pw) { $('loginErr').textContent = '请输入密码'; return; }
  $('loginBtn').disabled = true;
  $('loginErr').textContent = '登录中…';
  tryLogin(pw).then(function (r) {
    if (r.ok) {
      sessionStorage.setItem(KEY, pw);
      $('pw').value = '';
      $('loginErr').textContent = '';
      enterApp();
    } else {
      $('loginErr').textContent = r.error;
      if (r.disabled) $('loginBtn').disabled = true;
    }
  }).then(function () {
    if (!$('loginErr').textContent || $('loginErr').textContent.indexOf('后台未启用') !== 0) $('loginBtn').disabled = false;
  });
});

$('logout').addEventListener('click', function () {
  sessionStorage.removeItem(KEY);
  location.reload();
});

(function init() {
  var saved = getPw();
  if (!saved) { showGate(); return; }
  tryLogin(saved).then(function (r) {
    if (r.ok) { enterApp(); return; }
    sessionStorage.removeItem(KEY);
    showGate(r.disabled ? r.error : '登录已失效，请重新输入密码');
  });
})();

// ---- 标签页 ----
var tabs = document.querySelectorAll('#tabs button');
Array.prototype.forEach.call(tabs, function (b) {
  b.addEventListener('click', function () {
    var name = b.getAttribute('data-tab');
    Array.prototype.forEach.call(tabs, function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
    var panels = document.querySelectorAll('[data-panel]');
    Array.prototype.forEach.call(panels, function (p) { p.hidden = p.getAttribute('data-panel') !== name; });
    if (name === 'keepalive') loadStatus();
  });
});

// ---- 友情链接 ----
function loadLinks() {
  api('GET', '/api/links').then(function (j) {
    if (!j.ok) { toast(j.error || '读取友链失败', false); return; }
    linkList = j.links || [];
    renderLinks();
  }).catch(function (e) { toast('读取失败：' + e, false); });
}

function renderLinks() {
  var tb = $('rows');
  tb.textContent = '';
  linkList.forEach(function (l, i) {
    var tr = document.createElement('tr');
    var a = document.createElement('td'); a.textContent = l.name || '';
    var b = document.createElement('td'); b.textContent = l.url || '';
    var c = document.createElement('td');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'del';
    btn.textContent = '删除';
    btn.addEventListener('click', function () { askDelete(i); });
    c.appendChild(btn);
    tr.appendChild(a); tr.appendChild(b); tr.appendChild(c);
    tb.appendChild(tr);
  });
  $('linkCount').textContent = '共 ' + linkList.length + ' 条（上限 50 条）';
}

function askDelete(i) {
  var l = linkList[i];
  if (!l) return;
  pendingDel = i;
  $('delNote').textContent = '确定删除「' + (l.name || '') + '」？删除后会从仓库的友链列表中移除。';
  openDialog($('delDlg'));
}

$('delDlg').addEventListener('close', function () {
  var d = $('delDlg');
  var ok = d.returnValue === 'ok';
  d.returnValue = '';
  var idx = pendingDel;
  pendingDel = null;
  if (!ok || idx === null) return;
  toast('正在删除…', true);
  api('POST', '/api/links', { password: getPw(), action: 'remove', index: idx }).then(function (j) {
    if (j.ok) { linkList = j.links || []; renderLinks(); toast('已删除并保存到仓库', true); }
    else toast(j.error || '删除失败', false);
  }).catch(function (e) { toast('请求失败：' + e, false); });
});

$('openAdd').addEventListener('click', function () {
  $('nm').value = '';
  $('ur').value = '';
  $('addErr').textContent = '';
  if (openDialog($('addDlg'))) $('nm').focus();
});

$('addCancel').addEventListener('click', function () { $('addDlg').close(); });

$('addForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var name = $('nm').value.trim();
  var url = $('ur').value.trim();
  var err = '';
  if (!name) err = '名称必填';
  else if (name.length > 40) err = '名称不能超过 40 个字';
  else if (url.length > 300) err = '网址不能超过 300 个字符';
  else if (url.slice(0, 8).toLowerCase() !== 'https://' && url.slice(0, 7).toLowerCase() !== 'http://') err = '网址必须以 http:// 或 https:// 开头';
  if (err) { $('addErr').textContent = err; return; }
  $('addErr').textContent = '';
  $('addSubmit').disabled = true;
  api('POST', '/api/links', { password: getPw(), action: 'add', name: name, url: url }).then(function (j) {
    if (j.ok) {
      linkList = j.links || [];
      renderLinks();
      $('addDlg').close();
      toast('已添加并保存到仓库', true);
    } else {
      $('addErr').textContent = j.error || '添加失败';
    }
  }).catch(function (e) {
    $('addErr').textContent = '请求失败：' + e;
  }).then(function () { $('addSubmit').disabled = false; });
});

// ---- 站点配置（广告 / 联系方式） ----
function loadSite() {
  api('GET', '/api/site').then(function (j) {
    if (!j.ok) { toast(j.error || '读取站点配置失败', false); return; }
    siteData = j.site || {};
    fillSite();
  }).catch(function (e) { toast('读取失败：' + e, false); });
}

function fillSite() {
  var ad = (siteData && siteData.ad) || {};
  var c = (siteData && siteData.contact) || {};
  $('adHtml').value = ad.html || '';
  $('adOn').checked = !!ad.enabled;
  $('conTitle').value = c.title || '';
  $('conWechat').value = c.wechat || '';
  $('conQr').value = c.qrUrl || '';
  $('conEmail').value = c.email || '';
  $('conNote').value = c.note || '';
  $('conOn').checked = !!c.enabled;
}

function saveSection(section, value, btn) {
  btn.disabled = true;
  api('POST', '/api/site', { password: getPw(), section: section, value: value }).then(function (j) {
    if (j.ok) {
      siteData = j.site || siteData;
      fillSite();
      toast('保存成功', true);
    } else {
      toast(j.error || '保存失败', false);
    }
  }).catch(function (e) {
    toast('请求失败：' + e, false);
  }).then(function () { btn.disabled = false; });
}

$('adSave').addEventListener('click', function () {
  var html = $('adHtml').value;
  if (html.length > 20000) { toast('广告代码不能超过 20000 字', false); return; }
  saveSection('ad', { enabled: $('adOn').checked, html: html }, $('adSave'));
});

$('conSave').addEventListener('click', function () {
  var qr = $('conQr').value.trim();
  if (qr && qr.slice(0, 8) !== 'https://') { toast('二维码地址必须以 https:// 开头，或留空', false); return; }
  saveSection('contact', {
    enabled: $('conOn').checked,
    title: $('conTitle').value.trim(),
    wechat: $('conWechat').value.trim(),
    qrUrl: qr,
    email: $('conEmail').value.trim(),
    note: $('conNote').value.trim()
  }, $('conSave'));
});

// ---- 保活 ----
function loadStatus() {
  $('kState').textContent = '读取中…';
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    var dot = $('kDot');
    if (!s.configured) {
      dot.className = 'dot bad';
      $('kState').textContent = '未配置';
      $('kNote').textContent = s.error || '';
      $('kNext').textContent = s.next || '—';
      $('runBtn').disabled = true;
      return;
    }
    $('runBtn').disabled = false;
    dot.className = 'dot ' + (s.level || '');
    $('kState').textContent = s.stateText || '';
    $('kNote').textContent = s.stateNote || '';
    $('kLast').textContent = s.lastKeepalive || '还没有记录';
    $('kNext').textContent = s.next || '—';
    if (s.workflow) {
      $('kWf').textContent = s.workflow.conclusion || s.workflow.status;
      $('kWfNote').textContent = '（' + s.workflow.time + '，北京时间）';
    } else {
      $('kWf').textContent = '—';
      $('kWfNote').textContent = s.workflowError || '没有查到运行记录';
    }
  }).catch(function (e) {
    $('kState').textContent = '读取失败';
    $('kNote').textContent = String(e);
  });
}

$('refreshBtn').addEventListener('click', loadStatus);

$('runBtn').addEventListener('click', function () {
  var btn = $('runBtn');
  btn.disabled = true;
  toast('正在保活…', true);
  api('POST', '/api/run', { password: getPw() }).then(function (j) {
    if (j.ok) toast('保活成功，已写入仓库', true);
    else toast('保活失败：' + (j.error || ''), false);
  }).catch(function (e) {
    toast('请求失败：' + e, false);
  }).then(function () {
    btn.disabled = false;
    loadStatus();
  });
});
})();
</script>
</body>
</html>`;

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>仓库定时保活</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--text:#1f2937;--muted:#6b7280;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--line:#e5e7eb;--accent:#2563eb}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:720px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 24px}
.hero{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;display:flex;align-items:center;gap:16px}
.dot{width:16px;height:16px;border-radius:50%;background:var(--muted);flex:none}
.dot.ok{background:var(--ok)}
.dot.warn{background:var(--warn)}
.dot.bad{background:var(--bad)}
.state{font-size:20px;font-weight:600}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;min-width:0}
.label{color:var(--muted);font-size:13px}
.value{font-size:18px;font-weight:600;margin-top:4px;word-break:break-all}
.note{color:var(--muted);font-size:13px;margin-top:8px}
.bar{height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;margin-top:10px}
.bar span{display:block;height:100%;background:var(--accent);width:0;transition:width .4s}
.actions{margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.links{margin-top:20px;font-size:14px}
.links a{color:var(--accent);margin-right:16px}
button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:15px;cursor:pointer;min-height:44px}
button:disabled{opacity:.5;cursor:not-allowed}
#msg{color:var(--muted);font-size:14px}
@media (max-width:560px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <h1>GitHub 排行榜 · 定时保活</h1>
  <p class="sub">每周自动往仓库里提交一次记录，防止公开仓库 60 天没有活动后，定时更新被停用。</p>

  <div class="hero">
    <span class="dot" id="dot"></span>
    <div>
      <div class="label">当前状态</div>
      <div class="state" id="state">读取中…</div>
      <div class="note" id="stateNote"></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="label">上次保活（北京时间）</div>
      <div class="value" id="last">—</div>
    </div>
    <div class="card">
      <div class="label">下次保活</div>
      <div class="value" id="next">—</div>
      <div class="note">每周一 10:00（北京时间）</div>
    </div>
    <div class="card">
      <div class="label">距离上次保活</div>
      <div class="value" id="age">—</div>
      <div class="bar"><span id="bar"></span></div>
      <div class="note">进度条满格 = 60 天（超过就会被停用）</div>
    </div>
    <div class="card">
      <div class="label">数据更新任务（Update data）</div>
      <div class="value" id="wf">—</div>
      <div class="note" id="wfNote"></div>
    </div>
  </div>

  <div class="actions">
    <button id="run">立即保活一次</button>
    <span id="msg"></span>
  </div>
  <div class="links"><a href="/">查看排行榜</a></div>
</div>
<dialog id="dlg" style="border:1px solid #e5e7eb;border-radius:14px;padding:24px;max-width:340px;width:calc(100% - 32px)">
  <form method="dialog">
    <div style="font-weight:600;margin-bottom:12px">请输入手动保活密码</div>
    <input id="pw" type="password" autocomplete="current-password" style="width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;font-size:15px;min-height:44px">
    <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:16px">
      <button value="cancel" style="background:#fff;color:#1f2937;border:1px solid #e5e7eb">取消</button>
      <button id="ok" value="ok">确定</button>
    </div>
  </form>
</dialog>
<script>
(function () {
  function $(id) { return document.getElementById(id); }
  function setDot(level) { $('dot').className = 'dot ' + (level || ''); }

  function render(s) {
    if (!s.configured) {
      setDot('bad');
      $('state').textContent = '未配置';
      $('stateNote').textContent = s.error;
      $('next').textContent = s.next;
      $('run').disabled = true;
      return;
    }
    $('run').disabled = false;
    setDot(s.level);
    $('state').textContent = s.stateText;
    $('stateNote').textContent = s.stateNote;
    $('last').textContent = s.lastKeepalive || '还没有记录';
    $('next').textContent = s.next;
    $('age').textContent = s.age == null ? '—' : s.age + ' 天前';
    $('bar').style.width = s.age == null ? '0%' : Math.min(100, s.age / 60 * 100) + '%';
    if (s.workflow) {
      $('wf').textContent = s.workflow.conclusion || s.workflow.status;
      $('wfNote').textContent = '最近一次运行：' + s.workflow.time + '（北京时间）';
    } else {
      $('wf').textContent = '—';
      $('wfNote').textContent = s.workflowError || '没有查到运行记录';
    }
  }

  function load() {
    fetch('/api/status')
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function (e) {
        setDot('bad');
        $('state').textContent = '读取失败';
        $('stateNote').textContent = String(e);
      });
  }

  $('run').onclick = function () {
    var dlg = $('dlg');
    $('pw').value = '';
    dlg.showModal();
    $('pw').focus();
  };

  $('dlg').addEventListener('close', function () {
    var pw = $('pw').value;
    if ($('dlg').returnValue !== 'ok' || !pw) return;
    var btn = $('run');
    btn.disabled = true;
    $('msg').textContent = '正在保活…';
    fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        $('msg').textContent = x.ok ? '保活成功，已写入仓库' : '保活失败：' + x.j.error;
      })
      .catch(function (e) { $('msg').textContent = '请求失败：' + e; })
      .then(function () { btn.disabled = false; load(); });
    });

  load();
})();
</script>
</body>
</html>`;
