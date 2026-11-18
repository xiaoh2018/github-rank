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
        if (!env.RUN_PASSWORD) {
          return json({ ok: false, error: '没有设置 RUN_PASSWORD，手动保活已关闭' }, 403);
        }
        const body = await request.json().catch(() => ({}));
        if (body.password !== env.RUN_PASSWORD) {
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
    if (!url.startsWith('https://') || url.length > 200) {
      return json({ ok: false, error: '网址必须以 https:// 开头，且不超过 200 个字符' }, 400);
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

const ADMIN_PAGE = `<!doctype html>
<html lang='zh-CN'>
<head>
<meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<meta name='robots' content='noindex'>
<title>友链后台</title>
<style>
body{margin:0;font:15px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f7fb;color:#1f2937}
.wrap{max-width:720px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;margin:0 0 16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px;margin-bottom:16px}
label{display:block;font-size:13px;color:#6b7280;margin-bottom:4px}
input{width:100%;padding:10px;border:1px solid #e5e7eb;border-radius:10px;font-size:15px;min-height:44px;margin-bottom:12px;box-sizing:border-box}
button{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-size:15px;cursor:pointer;min-height:44px}
button.del{background:#dc2626;padding:6px 12px;min-height:32px;font-size:14px}
button:disabled{opacity:.5;cursor:not-allowed}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:14px;word-break:break-all}
#msg{color:#6b7280;font-size:14px;margin-left:12px}
.note{color:#6b7280;font-size:13px}
</style>
</head>
<body>
<div class='wrap'>
<h1>友链后台</h1>
<div class='card'>
<label for='pw'>管理密码（只在本页使用，不会保存）</label>
<input id='pw' type='password' autocomplete='current-password'>
<div class='note' id='cnt'></div>
</div>
<div class='card'>
<table><thead><tr><th>名称</th><th>网址</th><th style='width:80px'>操作</th></tr></thead><tbody id='rows'></tbody></table>
</div>
<div class='card'>
<form id='addForm'>
<label for='nm'>名称（最多 40 字）</label>
<input id='nm' maxlength='40' required>
<label for='ur'>网址（必须以 https:// 开头）</label>
<input id='ur' maxlength='200' required>
<button type='submit' id='addBtn'>添加</button><span id='msg'></span>
</form>
</div>
</div>
<script>
(function(){
function $(id){return document.getElementById(id);}
var links=[];
function say(t){$('msg').textContent=t;}
function render(){
  var tb=$('rows'); tb.textContent='';
  links.forEach(function(l,i){
    var tr=document.createElement('tr');
    var a=document.createElement('td'); a.textContent=l.name;
    var b=document.createElement('td'); b.textContent=l.url;
    var c=document.createElement('td');
    var btn=document.createElement('button'); btn.className='del'; btn.textContent='删除';
    btn.onclick=function(){ if(confirm('确定删除「'+l.name+'」？')) post({action:'remove',index:i}); };
    c.appendChild(btn); tr.appendChild(a); tr.appendChild(b); tr.appendChild(c); tb.appendChild(tr);
  });
  $('cnt').textContent='共 '+links.length+' 条（上限 50 条）';
}
function load(){
  fetch('/api/links').then(function(r){return r.json();}).then(function(j){
    if(!j.ok){say(j.error);return;} links=j.links||[]; render();
  }).catch(function(e){say('读取失败：'+e);});
}
function post(body){
  body.password=$('pw').value;
  $('addBtn').disabled=true;
  say('提交中…');
  fetch('/api/links',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json().catch(function(){return {ok:false,error:'服务器返回了非 JSON 内容（HTTP '+r.status+'）'};});})
    .then(function(j){
      if(j.ok){ links=j.links||[]; render(); say('已保存到仓库'); $('nm').value=''; $('ur').value=''; }
      else say(j.error||'操作失败');
    })
    .catch(function(e){say('请求失败：'+e);})
    .then(function(){$('addBtn').disabled=false;});
}
$('addForm').addEventListener('submit',function(e){
  e.preventDefault();
  post({action:'add',name:$('nm').value,url:$('ur').value});
});
load();
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
