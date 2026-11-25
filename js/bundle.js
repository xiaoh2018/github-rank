/* 由 js/ 下的各模块合并而成：普通脚本，双击 index.html 即可运行 */
(function () {
'use strict';
// ===== config.js =====
// 常量与分类规则（ES Module）
const RANGES = {
  week: { days: 7 },
  month: { days: 30 },
  year: { days: 365 },
  total: { days: 0 },   // 总榜：全站星标前 500，不分时间
  all: { days: 0 }      // 旧链接 ?range=all 兼容，数据同 total
};

const LANGS = ['JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'C++', 'C', 'C#', 'PHP', 'Ruby', 'Swift', 'Kotlin', 'Dart', 'Shell'];

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Go: '#00ADD8', Rust: '#dea584',
  Java: '#b07219', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600', PHP: '#4F5D95',
  Ruby: '#701516', Swift: '#F05138', Kotlin: '#A97BFF', Dart: '#00B4AB', Shell: '#89e051'
};

// 分类在已拉取的项目里按 topics / 描述关键词过滤（GitHub 搜索不支持 OR 分组）
const CATS = [
  { id: '', label: '全部' },
  { id: 'ai', label: 'AI / LLM', topics: ['ai', 'llm', 'machine-learning', 'deep-learning', 'gpt', 'agents', 'ai-agents', 'openai', 'claude', 'diffusion'], kw: ['ai', 'llm', 'gpt', 'neural', 'model'] },
  { id: 'tools', label: '工具 / 效率', topics: ['cli', 'tools', 'automation', 'productivity', 'utility'], kw: ['tool', 'cli', '自动化', '效率'] },
  { id: 'frontend', label: '前端 / Web', topics: ['frontend', 'react', 'vue', 'web', 'css', 'nextjs', 'typescript'], kw: ['web', '前端', 'react', 'vue'] },
  { id: 'devtools', label: '开发工具', topics: ['developer-tools', 'devtools', 'ide', 'editor', 'debugger'], kw: ['developer', 'ide', '编辑器'] },
  { id: 'security', label: '安全', topics: ['security', 'pentest', 'vulnerability', 'cve', 'privacy'], kw: ['security', '安全', '隐私'] },
  { id: 'data', label: '数据 / 后端', topics: ['database', 'sql', 'backend', 'api', 'server'], kw: ['database', '数据库', 'api', '后端'] },
  { id: 'game', label: '游戏', topics: ['game', 'gamedev', 'game-engine', 'games'], kw: ['game', '游戏'] },
  { id: 'learn', label: '学习资源', topics: ['awesome', 'tutorial', 'learning', 'interview', 'course'], kw: ['tutorial', '教程', '学习'] }
];

function matchCat(r, cat) {
  if (!cat || !cat.topics) return true;
  const topics = new Set(r.topics || []);
  if (cat.topics.some(t => topics.has(t))) return true;
  const desc = (r.desc || '').toLowerCase();
  return cat.kw.some(k => desc.includes(k));
}

// ===== state.js =====
// 页面共享状态（ES Module 单例）
const state = {
  view: 'repos',          // repos | devs | orgs
  range: 'week',
  lang: '',
  cat: '',
  sort: 'stars',          // stars | trend | activity | forks | updated
  q: '',
  page: 1,
  pageSize: 20,
  favOnly: false,
  repos: [],
  trend: {},              // name -> {dStars, dRank, isNew}
  dropped: [],            // 相对上次快照掉出榜的项目
  hasBase: false,         // 是否已经有至少 1 小时前的快照可对比
  users: []
};

// ===== cache.js =====
// 缓存 / 收藏 / Token / 趋势快照（ES Module）
const CACHE_TTL = 2 * 60 * 60 * 1000;     // 2 小时内直接命中
const STALE_TTL = 24 * 60 * 60 * 1000;    // 24 小时内可先显示再后台刷新
const CACHE_PREFIX = 'ghrank:cache:';
const SNAP_PREFIX = 'ghrank:snap:';
const SNAP_MAX = 6;                              // 每个查询保留最近 6 份快照
const SNAP_GAP = 60 * 60 * 1000;                 // 1 小时内不重复记快照，也不和自己比
const TOKEN_KEY = 'ghrank:token';
const FAV_KEY = 'ghrank:favs';

function safeParse(s, fb) {
  try { return JSON.parse(s) ?? fb; } catch (e) { return fb; }
}

// ---------- 榜单缓存 ----------
function readCache(key, maxAge) {
  const c = readCacheEntry(key, maxAge);
  return c ? c.repos : null;
}

// 返回完整缓存记录（含保存时间 t），过期或不存在返回 null
function readCacheEntry(key, maxAge) {
  const c = safeParse(localStorage.getItem(key), null);
  return c && Date.now() - c.t < (maxAge || CACHE_TTL) ? c : null;
}

function saveCache(key, repos) {
  const data = JSON.stringify({ t: Date.now(), repos });
  try { localStorage.setItem(key, data); return; } catch (e) { /* 满了，淘汰后重试 */ }
  const keys = Object.keys(localStorage)
    .filter(k => k.startsWith(CACHE_PREFIX) && k !== key)
    .map(k => [k, (safeParse(localStorage.getItem(k), {}) || {}).t || 0])
    .sort((a, b) => a[1] - b[1]);
  for (const [k] of keys) {                                   // 最旧优先，装下为止
    localStorage.removeItem(k);
    try { localStorage.setItem(key, data); return; } catch (err) { /* 继续 */ }
  }
}

// ---------- 收藏 ----------
function getFavs() { return new Set(safeParse(localStorage.getItem(FAV_KEY), [])); }
function toggleFav(name) {
  const f = getFavs();
  f.has(name) ? f.delete(name) : f.add(name);
  localStorage.setItem(FAV_KEY, JSON.stringify([...f]));
  return f.has(name);
}

// ---------- Token ----------
const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
function setToken(v) {
  if (v) localStorage.setItem(TOKEN_KEY, v);
  else localStorage.removeItem(TOKEN_KEY);
}

// ---------- 趋势快照：按查询存 [{t, repos:[{n,s}]}]，最新在前 ----------
function readSnaps(q) { return safeParse(localStorage.getItem(SNAP_PREFIX + q), []); }

function pushSnap(q, repos) {
  const list = readSnaps(q);
  const last = list[0];
  if (last && Date.now() - last.t < SNAP_GAP) return;
  list.unshift({ t: Date.now(), repos: repos.map(r => ({ n: r.name, s: r.stars })) });
  try { localStorage.setItem(SNAP_PREFIX + q, JSON.stringify(list.slice(0, SNAP_MAX))); }
  catch (e) { /* 存不下就算了，趋势是增强功能 */ }
}

// 是否已有至少 1 小时前的快照可对比
function hasBaseSnap(q) {
  const cutoff = Date.now() - SNAP_GAP;
  return readSnaps(q).some(s => s.t <= cutoff);
}

// 和至少 1 小时前的快照对比：每个项目的星标增量和排名变化
function diffSnap(q, repos) {
  const cutoff = Date.now() - SNAP_GAP;
  const old = readSnaps(q).find(s => s.t <= cutoff);
  if (!old) return {};
  const map = {};
  old.repos.forEach((r, i) => { map[r.n] = { s: r.s, r: i + 1 }; });
  const out = {};
  repos.forEach((r, i) => {
    const o = map[r.name];
    out[r.name] = {
      dStars: o ? r.stars - o.s : null,
      dRank: o ? o.r - (i + 1) : null,   // 正数 = 排名上升
      isNew: !o
    };
  });
  return out;
}

// 相对上次快照掉出本榜的项目（按上次排名排序，最多 20 个）
function droppedSnap(q, repos) {
  const cutoff = Date.now() - SNAP_GAP;
  const old = readSnaps(q).find(s => s.t <= cutoff);
  if (!old) return [];
  const now = new Set(repos.map(r => r.name));
  return old.repos
    .map((r, i) => ({ name: r.n, stars: r.s, rank: i + 1 }))
    .filter(x => !now.has(x.name))
    .slice(0, 20);
}

// ===== api.js =====
// GitHub API：分段 + 分页扩量、用户榜、详情（README / Release / 贡献者）、活跃度（ES Module）



const MIN_STARS = 50;
const PAGE_SIZE = 100;          // GitHub 单页上限
const PAGES_PER_SEG = 3;        // 每段最多翻 3 页（300 条）
const MAX_TOTAL = 500;          // 合并后最多保留 500 条

// 各时间范围的星标区间（互不重叠，由高到低）
const SEGMENTS = {
  week:  [{ lo: 500 }, { lo: 200, hi: 500 }, { lo: 50, hi: 200 }],
  month: [{ lo: 1000 }, { lo: 200, hi: 1000 }, { lo: 50, hi: 200 }],
  year:  [{ lo: 2000 }, { lo: 500, hi: 2000 }, { lo: 100, hi: 500 }, { lo: 50, hi: 100 }],
  total: [{ lo: 1000 }],
  all:   [{ lo: 1000 }]
};

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function buildQuery(state) {
  const parts = ['stars:>' + MIN_STARS];
  const days = RANGES[state.range].days;
  if (days) parts.push('created:>' + dateStr(days));
  if (state.lang) parts.push('language:"' + state.lang + '"');
  return parts.join(' ');
}

function segQuery(base, seg) {
  const stars = seg.hi ? `stars:${seg.lo}..${seg.hi}` : `stars:>${seg.lo}`;
  return base.replace('stars:>' + MIN_STARS, stars);
}

async function fetchSearch(q, kind = 'repositories', sort = 'stars', page = 1) {
  let url = `https://api.github.com/search/${kind}?q=${encodeURIComponent(q)}` +
      `&sort=${sort}&order=desc&per_page=${PAGE_SIZE}&page=${page}`;
  const headers = { Accept: 'application/vnd.github+json' };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  else if (serverMode && kind === 'repositories') url = '/api/gh-search?q=' + encodeURIComponent(q) + '&sort=' + sort + '&page=' + page + '&per_page=' + PAGE_SIZE;
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    res = await fetch(url, { headers, signal: ctrl.signal });
    } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError'
      ? '请求超时（GitHub 接口响应太慢），请重试或稍后再来。'
      : '网络请求失败，请检查网络连接后重试。');
    }
  if ((res.status === 403 || res.status === 429) && serverMode && !token) {
    clearTimeout(timer);
    throw new Error('服务器共用的额度已用完，请在「设置」中填写你自己的 Token 后再刷新。');
  }
  if (res.status === 403 || res.status === 429) {
    clearTimeout(timer);
    throw new Error(token
      ? '已触发 GitHub 请求限制，当前 Token 的额度也已用完，请稍后再试。'
      : '已触发 GitHub 请求限制（未填 Token 时搜索每分钟只能 10 次），请稍后再试；也可以在「设置」中填写 Token。');
  }
  if (res.status === 401) { clearTimeout(timer); throw new Error('Token 无效或已过期，请在「设置」中重新填写。'); }
  if (res.status === 422) { clearTimeout(timer); throw new Error('查询条件无效，请换一个筛选条件。'); }
  if (!res.ok) { clearTimeout(timer); throw new Error('请求失败（HTTP ' + res.status + '），请稍后重试。'); }
  // 读取返回内容也要受超时保护，否则响应体卡住时整个刷新会一直停在进度文字上
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? '请求超时（GitHub 接口响应太慢），请重试或稍后再来。'
      : '返回内容解析失败，请稍后重试。');
  } finally { clearTimeout(timer); }
  return data.items || [];
}

function trimRepo(r) {
  return {
    name: r.full_name, url: r.html_url, desc: r.description || '',
    lang: r.language || '', stars: r.stargazers_count, forks: r.forks_count,
    issues: r.open_issues_count, updated: r.updated_at, pushed: r.pushed_at,
    created: r.created_at, license: (r.license && r.license.spdx_id) || '',
    topics: (r.topics || []).slice(0, 5)
  };
}

// ---------- 静态数据：meta + 每个时间范围一个文件，用到才加载 ----------
// 以前四个 range 全塞在 data/repos.js（约 400KB 压缩后），页面只用其中一个。
// 现在首屏只下载 meta（约 2KB）+ 当前 range（约 100KB）。
const RANGE_FILES = {
  week: 'data/repos-week.js',
  month: 'data/repos-month.js',
  year: 'data/repos-year.js',
  total: 'data/repos-total.js',
  all: 'data/repos-total.js'   // 旧链接兼容，同一份数据
};
const rangePending = {};

// 兼容旧版单文件（window.__GHRANK_DATA__）：旧 Worker 或旧缓存页面还会加载它
function staticMeta() {
  const m = window.__GHRANK_META__;
  if (m && m.generatedAt) return m;
  const old = window.__GHRANK_DATA__;
  return old && old.generatedAt ? old : null;
}

function staticUsers() {
  const m = window.__GHRANK_META__;
  if (m && m.users) return m.users;
  const old = window.__GHRANK_DATA__;
  return old && old.users ? old.users : null;
}

function staticRange(name) {
  const old = window.__GHRANK_DATA__;
  if (old && old.ranges && old.ranges[name]) return old.ranges[name];
  const map = window.__GHRANK_RANGES__;
  return (map && map[name]) || null;
}

// 按需插入 <script> 加载某个 range；失败返回 reject，调用方降级到实时拉取
function ensureRange(name) {
  const ready = staticRange(name);
  if (ready) return Promise.resolve(ready);
  const file = RANGE_FILES[name];
  if (!file) return Promise.resolve(null);
  if (rangePending[name]) return rangePending[name];
  rangePending[name] = new Promise((resolve, reject) => {
    const meta = staticMeta();
    const s = document.createElement('script');
    s.src = file + (meta && meta.generatedAt ? '?v=' + encodeURIComponent(meta.generatedAt) : '');
    s.async = true;
    s.onload = () => {
      const got = (window.__GHRANK_RANGES__ || {})[name];
      delete rangePending[name];
      if (got && Array.isArray(got.repos)) resolve(got);
      else reject(new Error('数据文件格式不对'));
    };
    s.onerror = () => {
      delete rangePending[name];
      // 总榜文件是后加的：Worker 还没重新部署、或边缘缓存里还是旧 SITE 映射时会 404。
      // 这时退到仓库里仍然存在的旧 data/repos-all.js，页面不至于空掉。
      if (file !== 'data/repos-all.js') {
        const alt = document.createElement('script');
        alt.src = 'data/repos-all.js' + (meta && meta.generatedAt ? '?v=' + encodeURIComponent(meta.generatedAt) : '');
        alt.async = true;
        alt.onload = () => {
          const map2 = window.__GHRANK_RANGES__ || {};
          const got = map2[name] || map2.all;
          if (got && Array.isArray(got.repos)) resolve(got);
          else reject(new Error('数据文件加载失败'));
        };
        alt.onerror = () => reject(new Error('数据文件加载失败'));
        document.head.appendChild(alt);
        return;
      }
      reject(new Error('数据文件加载失败'));
    };
    document.head.appendChild(s);
  });
  return rangePending[name];
}

// 分段 + 分页拉取，合并去重。返回 {repos, partial}；partial=中途失败，只用了已拿到的数据（不缓存）
async function loadRepos(state, bypassCache, onProgress) {
  const base = buildQuery(state);
  const key = CACHE_PREFIX + base;
  if (!bypassCache) {
    const cached = readCache(key);
    if (cached) return { repos: cached, partial: false };
  } else localStorage.removeItem(key);

  const segs = SEGMENTS[state.range] || SEGMENTS.all;
  const out = [];
  const seen = new Set();
  let partial = false;
  // 总榜要翻得更深（GitHub 搜索最多 1000 条），其它时间范围仍按 3 页/段控制请求量
  const deep = state.range === 'total' || state.range === 'all';
  const maxPages = deep ? 10 : PAGES_PER_SEG;
  outer: for (const seg of segs) {
    for (let page = 1; page <= maxPages; page++) {
      let items;
      try {
        items = await fetchSearch(segQuery(base, seg), 'repositories', 'stars', page);
      } catch (e) {
        if (out.length) { partial = true; break outer; }   // 已有数据，容忍部分失败
        throw e;
      }
      items.forEach(r => {
        if (!seen.has(r.full_name)) { seen.add(r.full_name); out.push(trimRepo(r)); }
      });
      if (onProgress) onProgress(out.length);
      if (items.length < PAGE_SIZE) break;                  // 这一段已经取完
    }
    if (out.length >= MAX_TOTAL) break;
  }
  out.sort((a, b) => b.stars - a.stars);
  const repos = out.slice(0, MAX_TOTAL);
  if (!partial) {
    saveCache(key, repos);
    pushSnap(base, repos);
  }
  return { repos, partial };
}

// 开发者榜 / 组织榜：搜索接口不返回粉丝数，所以按粉丝数排序后只显示账号
async function loadUsers(kind, bypassCache) {
  // 默认走静态数据（data/repos-meta.js 里的 users），不发请求；没有静态数据时降级到实时拉取
  const sd = !bypassCache && staticUsers();
  const staticList = sd && (kind === 'org' ? sd.orgs : sd.devs);
  if (Array.isArray(staticList)) return staticList.filter(u => !u.kind || u.kind === kind);
  const q = 'type:' + kind + ' followers:>1000';
  const key = CACHE_PREFIX + 'users:' + q;
  if (!bypassCache) {
    const cached = readCache(key);
    if (cached) return cached;
  } else localStorage.removeItem(key);
  const items = await fetchSearch(q, 'users', 'followers', 1);
  const users = items.slice(0, 50).map(u => ({ login: u.login, url: u.html_url, avatar: u.avatar_url }));
  saveCache(key, users);
  return users;
}

// ---------- 详情（抽屉用） ----------
async function gh(path, raw) {
  // 走本站 Worker 代理（/api/gh），由 Worker 用 GITHUB_TOKEN 请求 GitHub，避免访客浏览器未登录被限流；15 秒超时，慢了直接显示「暂时读取不到」
  const res = await fetch('/api/gh?path=' + encodeURIComponent(path) + (raw ? '&raw=1' : ''), { signal: timeoutSignal(15000) });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return raw ? res.text() : res.json();
}

const fetchRepoDetail = name => gh('/repos/' + name);
const fetchReadme = name => gh('/repos/' + name + '/readme', true);

// 没有 Release 时接口返回 404，这里返回 null 而不是报错
async function fetchLatestRelease(name) {
  try { return await gh('/repos/' + name + '/releases/latest'); } catch (e) { return null; }
}

async function fetchContributors(name) {
  try { return (await gh('/repos/' + name + '/contributors?per_page=8')) || []; } catch (e) { return []; }
}

// ---------- 活跃度评分（0-100） ----------
// 权重：最近 push 40% + 星标量 25% + Fork 20% + open issues 15%
function activityScore(r) {
  const daysSincePush = Math.min(730, (Date.now() - new Date(r.pushed || r.updated)) / 86400000);
  const fresh = Math.max(0, 1 - daysSincePush / 365) * 40;
  const starS = Math.min(1, Math.log10(Math.max(1, r.stars)) / 5.5) * 25;
  const forkS = Math.min(1, Math.log10(Math.max(1, r.forks)) / 4.5) * 20;
  const issS = Math.min(1, Math.log10(Math.max(1, r.issues)) / 3) * 15;
  return Math.round(fresh + starS + forkS + issS);
}

// ===== ui.js =====
// 渲染层：列表 / 统计 / 语言分布 / 作者榜 / 新晋与掉队 / 详情抽屉 / 分享卡片（ES Module）





// 由 app.js 注入，避免模块之间循环依赖
const hooks = {
  onLangPick: () => {},
  onLangClear: () => {},
  onFavChanged: () => {}
};

const $ = id => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmt(n) {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}

function signed(n) {
  return (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n));
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 3600) return '刚刚';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
  if (s < 86400 * 365) return Math.floor(s / 86400 / 30) + ' 个月前';
  return Math.floor(s / 86400 / 365) + ' 年前';
}

// ---------- 列表项 ----------
function renderItem(r, rank, maxStars, trend) {
  const favs = getFavs();
  const faved = favs.has(r.name);
  const li = el('li', 'item' + (faved ? ' faved' : ''));

  const rankEl = el('div', 'rank', rank <= 3 ? '' : String(rank).padStart(2, '0'));
  if (rank <= 3) rankEl.append(el('span', 'rank-top rank-' + rank, String(rank)));
  li.append(rankEl);

  const body = el('div');
  const a = el('a', 'name', r.name);
  a.href = r.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.onclick = e => { e.preventDefault(); openDrawer(r); };   // 中键 / 右键仍可新开
  body.append(a);
  const descText = (getLang() === 'zh' && r.desc_zh) ? r.desc_zh : r.desc;
  if (descText) body.append(el('p', 'desc', descText));

  const meta = el('div', 'meta');
  if (r.lang) {
    const ls = el('span');
    const dot = el('i', 'lang-dot');
    dot.style.background = LANG_COLORS[r.lang] || 'var(--muted)';
    ls.append(dot, document.createTextNode(r.lang));
    meta.append(ls);
  }
  meta.append(el('span', 'stars', '★ ' + fmt(r.stars)));

  const t = trend && trend[r.name];
  if (t) {
    if (t.isNew) meta.append(el('span', 'badge new', 'NEW'));
    else if (t.dRank > 0) meta.append(el('span', 'badge up', '↑' + t.dRank));
    else if (t.dRank < 0) meta.append(el('span', 'badge down', '↓' + (-t.dRank)));
    if (t.dStars != null) {
      const g = el('span', 'gain' + (t.dStars > 0 ? ' up' : t.dStars < 0 ? ' down' : ''), '较上次 ' + signed(t.dStars) + ' ★');
      g.title = '和至少 1 小时前的一次记录相比的星标变化';
      meta.append(g);
    }
  }

  const act = activityScore(r);
  const actEl = el('span', 'act', '活跃 ' + act);
  actEl.title = '按最近提交、星标、Fork、Issue 综合计算（0-100）';
  meta.append(actEl);
  meta.append(el('span', null, 'Fork ' + fmt(r.forks)));
  meta.append(el('span', null, '更新于 ' + timeAgo(r.updated)));

  const copy = el('button', 'mini', '复制');
  copy.title = '复制项目名、描述和链接';
  copy.onclick = async () => {
    const text = r.name + ' ★' + fmt(r.stars) + '\n' + (r.desc ? r.desc + '\n' : '') + r.url;
    try { await navigator.clipboard.writeText(text); copy.textContent = '已复制'; }
    catch (e) { copy.textContent = '复制失败'; }
    setTimeout(() => { copy.textContent = '复制'; }, 1500);
  };
  meta.append(copy);

  const share = el('button', 'mini', '卡片');
  share.title = '生成分享卡片图片';
  share.onclick = () => shareCard(r, rank);
  meta.append(share);
  body.append(meta);

  if (r.topics.length) {
    const tags = el('div', 'tags');
    r.topics.forEach(tp => tags.append(el('span', 'tag', tp)));
    body.append(tags);
  }
  const bar = el('div', 'starbar');
  const fill = el('i');
  fill.style.width = (maxStars ? Math.max(2, Math.round(r.stars / maxStars * 100)) : 0) + '%';
  bar.append(fill);
  body.append(bar);
  li.append(body);

  const fav = el('button', 'fav' + (faved ? ' on' : ''), faved ? '★' : '☆');
  fav.title = '收藏 / 取消收藏';
  fav.setAttribute('aria-label', fav.title);
  fav.onclick = () => {
    const on = toggleFav(r.name);
    fav.textContent = on ? '★' : '☆';
    fav.classList.toggle('on', on);
    li.classList.toggle('faved', on);
    if (state.favOnly) hooks.onFavChanged();
  };
  li.append(fav);
  return li;
}

// ---------- 统计 / 分布 / 作者榜 ----------
function renderStats(list) {
  const box = $('stats');
  if (!list.length) { box.hidden = true; return; }
  const totalStars = list.reduce((s, r) => s + r.stars, 0);
  const langCount = {};
  list.forEach(r => { if (r.lang) langCount[r.lang] = (langCount[r.lang] || 0) + 1; });
  const topLang = Object.entries(langCount).sort((a, b) => b[1] - a[1])[0];
  box.hidden = false;
  const mk = (v, label) => { const d = el('div', 'stat'); d.append(el('b', null, v), el('span', null, label)); return d; };
  box.replaceChildren(
    mk(String(list.length), '当前榜单项目数'),
    mk(fmt(totalStars), '星标总数'),
    mk(fmt(Math.round(totalStars / list.length)), '平均星标'),
    mk(topLang ? topLang[0] + ' × ' + topLang[1] : '—', '最热门语言')
  );
}

function renderDist(list) {
  const box = $('dist');
  const counts = {};
  list.forEach(r => { if (r.lang) counts[r.lang] = (counts[r.lang] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!top.length) { box.hidden = true; return; }
  const max = top[0][1];
  const rows = top.map(([lang, n]) => {
    const clickable = LANGS.includes(lang);
    const row = el('button', 'dist-row');
    row.type = 'button';
    row.disabled = !clickable;
    row.title = clickable ? '只看 ' + lang : lang;
    const track = el('span', 'dist-track');
    const fill = el('i');
    fill.style.width = Math.round(n / max * 100) + '%';
    fill.style.background = LANG_COLORS[lang] || 'var(--muted)';
    track.append(fill);
    row.append(el('span', null, lang), track, el('span', 'dist-n', String(n)));
    row.onclick = () => hooks.onLangPick(lang);
    return row;
  });
  box.hidden = false;
  if (state.lang) {
    const reset = el('button', 'mini', '清除语言筛选');
    reset.onclick = () => hooks.onLangClear();
    box.replaceChildren(el('div', 'dist-title', `当前只看 ${state.lang}，共 ${list.length} 个`), reset);
    return;
  }
  box.replaceChildren(el('div', 'dist-title', '语言分布（点击筛选）'), ...rows);
}

function renderAuthors(list) {
  const box = $('authors');
  if (list.length < 3) { box.hidden = true; return; }
  const by = {};
  list.forEach(r => {
    const o = r.name.split('/')[0];
    by[o] = by[o] || { n: 0, stars: 0 };
    by[o].n++; by[o].stars += r.stars;
  });
  const top = Object.entries(by).filter(([, v]) => v.n >= 2).sort((a, b) => b[1].stars - a[1].stars).slice(0, 6);
  if (!top.length) { box.hidden = true; return; }
  box.hidden = false;
  const max = top[0][1].stars || 1;
  box.replaceChildren(el('div', 'dist-title', '上榜项目最多的作者 / 组织（当前榜单）'),
    ...top.map(([name, v], i) => {
      const row = el('div', 'author-row');
      const rank = el('span', 'au-rank', String(i + 1).padStart(2, '0'));
      const img = document.createElement('img');
      img.className = 'au-avatar';
      img.alt = '';
      img.loading = 'lazy';
      img.src = 'https://github.com/' + encodeURIComponent(name) + '.png?size=56';
      img.onerror = () => img.replaceWith(el('span', 'au-avatar au-fallback', name.charAt(0).toUpperCase()));
      const info = el('div', 'au-info');
      const nameLink = el('a', 'au-name', name);
      nameLink.href = 'https://github.com/' + encodeURIComponent(name);
      nameLink.target = '_blank';
      nameLink.rel = 'noopener noreferrer';
      info.append(nameLink, el('span', 'au-count', v.n + ' 个项目'));
      const bar = el('div', 'au-bar');
      const fill = el('i');
      fill.style.width = (v.stars / max * 100).toFixed(1) + '%';
      bar.append(fill);
      row.append(rank, img, info, bar, el('span', 'au-stars', fmt(v.stars) + ' ★'));
      return row;
    }));
}


// ---------- 榜单对比：上次记录以来的新晋 / 掉队 ----------
function renderChanges(repos, trend, dropped) {
  const box = $('changes');
  if (!repos.length) { box.hidden = true; return; }
  box.hidden = false;
  if (!state.hasBase) {
    box.replaceChildren(
      el('div', 'dist-title', '上次记录以来的变化'),
      el('p', 'note', '暂无对比记录，隔 1 小时以上再来一次即可看到新进前 20 和掉出榜单的项目。')
    );
    return;
  }
  const newcomers = repos.slice(0, 20)
    .map((r, i) => ({ r, rank: i + 1 }))
    .filter(x => trend[x.r.name] && trend[x.r.name].isNew);
  const col = (title, rows) => {
    const c = el('div', 'chg-col');
    c.append(el('div', 'dist-title', title));
    if (!rows.length) c.append(el('p', 'note', '无'));
    else rows.forEach(x => c.append(x));
    return c;
  };
  const rowNew = ({ r, rank }) => {
      const row = el('div', 'chg-row');
      const name = el('b');
      const link = el('a', null, '#' + rank + ' ' + r.name);
      link.href = 'https://github.com/' + r.name;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = r.name;
      name.append(link);
      row.append(name, el('span', null, '★ ' + fmt(r.stars)));
    return row;
  };
  const rowDrop = d => {
      const row = el('div', 'chg-row');
      const name = el('b');
      const link = el('a', null, '原 #' + d.rank + ' ' + d.name);
      link.href = 'https://github.com/' + d.name;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = d.name;
      name.append(link);
      row.append(name, el('span', null, '★ ' + fmt(d.stars)));
    return row;
  };
  const grid = el('div', 'chg-grid');
  grid.append(col('新进前 20', newcomers.map(rowNew)), col('掉出榜单', dropped.map(rowDrop)));
  box.replaceChildren(el('div', 'dist-title', '上次记录以来的变化（对比至少 1 小时前的一次记录）'), grid);
}

// ---------- 详情抽屉 ----------
let drawerTarget = '';

async function openDrawer(r) {
  drawerTarget = r.name;
  const d = $('drawer'), bd = $('drawerBack');
  d.hidden = false; bd.hidden = false;
  requestAnimationFrame(() => { d.classList.add('open'); bd.classList.add('show'); });
  $('drawerTitle').textContent = r.name;
  $('drawerTitle').href = r.url;
  $('drawerBody').replaceChildren(el('p', 'note', '加载详情…'));

  // 详情、README、Release、贡献者并行请求；任何一项慢或失败都不影响其它部分
  const [full, readme, rel, contribs] = await Promise.all([
    fetchRepoDetail(r.name).catch(() => null),
    fetchReadme(r.name).catch(() => null),
    fetchLatestRelease(r.name),
    fetchContributors(r.name)
  ]);
  if (drawerTarget !== r.name) return;   // 用户已经切到别的项目或关掉了

  const view = { full, rel, contribs, readme, zh: false, zhPartial: false, zhPending: false };
  renderDrawerBody(r, view);

  // 中文 README 单独请求，到了再替换 README 部分，不再让它拖住整个抽屉
  if (readme && getLang() === 'zh') {
    const zh = await fetch('/api/readme-zh?repo=' + encodeURIComponent(r.name), { signal: timeoutSignal(20000) })
      .then(x => x.json()).catch(() => null);
    if (drawerTarget !== r.name) return;
    if (zh && zh.ok && zh.text) {
      view.readme = zh.text; view.zh = true; view.zhPartial = !!zh.partial;
      // 只替换 README 这一块，滚动位置和上面其它内容都不动
      const old = document.getElementById('readmeWrap');
      if (old) old.replaceWith(readmeBlock(r, view));
    }
  }
}

function timeoutSignal(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// 按现有数据重画抽屉内容（同一个项目可以多次调用）

// README 是 Markdown 源码：先把 GitHub 上常见的 HTML 片段降级成 Markdown 写法，
// 再交给 KeeMd（先整体转义再解析），这样抽屉里看到的就是渲染后的样子，也不会有注入风险。
function sanitizeReadme(t, repoUrl) {
  let s = String(t || '').replace(/\r/g, '');
  const dec = x => x.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
  // 图片 / 链接（含 <img align="center" ...>、<a href>）
  s = s.replace(/<img\b[^>]*?src=["']?([^"'\s>]+)["']?[^>]*>/gi, function (m, src) {
    const u = dec(src);
    const altM = /alt=["']([^"']*)["']/i.exec(m);
    const a = dec((altM && altM[1]) || '');
    return u ? '![' + a + '](' + u + ')' : '';   // 相对图片留给下面的「补全成 raw 地址」处理
  });
  s = s.replace(/<a\b[^>]*?href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, function (m, href, txt) {
    const u = dec(href);
    const t = dec(txt.replace(/<[^>]+>/g, '')).trim();
    return /^https?:\/\//i.test(u) && t ? '[' + t + '](' + u + ')' : t;
  });
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, function (m, n, txt) {
    return '\n' + '#'.repeat(Math.min(Number(n), 6)) + ' ' + dec(txt.replace(/<[^>]+>/g, '')).trim() + '\n';
  });
  s = s.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/li>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<hr\b[^>]*>/gi, '\n---\n');
  s = s.replace(/<p\b[^>]*>/gi, '\n').replace(/<\/p>/gi, '\n');
  // 其余标签（details/summary/div/picture/table 里的属性等）去掉，文字保留
  s = s.replace(/<[^>]+>/g, '');
  s = dec(s);
  // 站内锚点（#xxx）在抽屉里点了没意义，去掉只留文字
  s = s.replace(/\[([^\]]+)\]\(#[^)]*\)/g, '$1');
  // 相对路径的图片/链接补成 GitHub 上的绝对地址，否则渲染出来是死链
  const base = String(repoUrl || '').replace(/\/$/, '');
  if (base) {
    s = s.replace(/!\[([^\]]*)\]\((?!https?:|\/|#)([^)\s]+)\)/g, (m, alt, p) => '![' + alt + '](' + base + '/raw/HEAD/' + p.replace(/^\.\//, '') + ')');
    s = s.replace(/\[([^\]]+)\]\((?!https?:|\/|#)([^)\s]+)\)/g, (m, txt, p) => '[' + txt + '](' + base + '/blob/HEAD/' + p.replace(/^\.\//, '') + ')');
  }
  s = s.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');
  return s;
}

function readmeBlock(r, v) {
  const wrap = el('div', 'readme-wrap');
  wrap.id = 'readmeWrap';
  const head = el('div', 'readme-head');
  head.append(el('h4', null, 'README'));
  if (v.readme && v.zh) head.append(el('span', 'readme-badge', v.zhPartial ? '机器翻译 · 部分段落仍为英文' : '机器翻译 · 仅供参考'));
  wrap.append(head);
  const LIMIT = 20000;
  if (!v.readme) {
    wrap.append(el('p', 'note', '没有读取到 README。'));
    return wrap;
  }
  const body = el('div', 'article-body readme-body');
  const canRender = window.KeeMd && window.KeeMd.render;
  body.innerHTML = canRender ? window.KeeMd.render(sanitizeReadme(v.readme.slice(0, LIMIT), r.url)) : '';
  if (!canRender) body.textContent = v.readme.slice(0, LIMIT);
  wrap.append(body);
  if (v.readme.length > LIMIT) wrap.append(el('p', 'note', '（仅显示前 ' + LIMIT + ' 字符，完整内容请到 GitHub 看原文）'));
  const more = el('a', 'btn readme-more', '在 GitHub 看完整 README');
  more.href = r.url; more.target = '_blank'; more.rel = 'noopener noreferrer';
  wrap.append(more);
  return wrap;
}

function renderDrawerBody(r, v) {
  const rows = [];
  const meta = el('div', 'meta');
  meta.append(el('span', 'stars', '★ ' + fmt(r.stars)), el('span', null, 'Fork ' + fmt(r.forks)));
  if (r.license && r.license !== 'NOASSERTION') meta.append(el('span', null, r.license));
  meta.append(el('span', null, '创建于 ' + (r.created || '').slice(0, 10)));
  meta.append(el('span', 'act', '活跃 ' + activityScore(r)));
  rows.push(meta);
  if (v.full) {
    rows.push(el('p', 'note', '最近提交 ' + timeAgo(v.full.pushed_at) + ' · Watch ' + fmt(v.full.subscribers_count || 0)));
  } else {
    rows.push(el('p', 'note', '项目详情暂时读取不到，可点上方项目名去 GitHub 查看。'));
  }

  rows.push(el('h4', null, '最新 Release'));
  if (v.rel) {
    const a = el('a', 'name', (v.rel.name || v.rel.tag_name) + '（' + v.rel.tag_name + '）');
    a.href = v.rel.html_url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.style.fontSize = '14px';
    rows.push(a, el('p', 'note', '发布于 ' + (v.rel.published_at || '').slice(0, 10)));
  } else {
    rows.push(el('p', 'note', '该项目还没有发布 Release。'));
  }

  rows.push(el('h4', null, '主要贡献者'));
  if (v.contribs.length) {
    const list = el('div', 'contribs');
    v.contribs.forEach(c => {
      const row = el('div', 'author-row');
      const img = document.createElement('img');
      img.className = 'avatar-sm'; img.src = c.avatar_url; img.alt = ''; img.width = 24; img.height = 24; img.loading = 'lazy';
      const who = el('div', 'contrib-who');
      const link = el('a', null, c.login);
      link.href = c.html_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      who.append(img, link);
      row.append(who, el('span', null, fmt(c.contributions) + ' 次提交'));
      list.append(row);
    });
    rows.push(list);
  } else {
    rows.push(el('p', 'note', '没有读取到贡献者信息。'));
  }

  rows.push(readmeBlock(r, v));
  $('drawerBody').replaceChildren(...rows);
}


function closeDrawer() {
  drawerTarget = '';
  const d = $('drawer'), bd = $('drawerBack');
  d.classList.remove('open'); bd.classList.remove('show');
  setTimeout(() => { if (!d.classList.contains('open')) { d.hidden = true; bd.hidden = true; } }, 200);
}

function initDrawer() {
  $('drawerClose').onclick = closeDrawer;
  $('drawerBack').onclick = closeDrawer;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer();
  });
}

// ---------- Canvas 分享卡片 ----------
function shareCard(r, rank) {
  const W = 900, H = 470;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const dark = document.documentElement.dataset.theme === 'dark';
  const bg = dark ? '#0a0e1a' : '#faf7f0', fg = dark ? '#e8ecf4' : '#1c2230';
  const muted = dark ? '#8b95a7' : '#6b7280';
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  const grad = x.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#f0b429'); grad.addColorStop(1, '#ffd977');
  x.fillStyle = grad; x.fillRect(0, 0, W, 6);
  x.font = '600 20px Consolas, monospace';
  x.fillStyle = '#f0b429'; x.fillText('★ GitHub 排行榜 · 第 ' + rank + ' 名', 40, 60);
  x.fillStyle = fg; x.font = 'bold 44px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  x.fillText(r.name.length > 32 ? r.name.slice(0, 32) + '…' : r.name, 40, 125);
  x.fillStyle = muted; x.font = '22px "Segoe UI", "PingFang SC", sans-serif';
  const desc = r.desc || '';
  x.fillText(desc.length > 52 ? desc.slice(0, 52) + '…' : desc, 40, 170);
  x.font = 'bold 34px Consolas, monospace';
  x.fillStyle = '#f0b429'; x.fillText('★ ' + fmt(r.stars), 40, 260);
  x.fillStyle = fg; x.fillText('Fork ' + fmt(r.forks), 260, 260);
  x.fillText('活跃 ' + activityScore(r), 500, 260);
  x.fillStyle = muted; x.font = '20px "Segoe UI", sans-serif';
  if (r.lang) x.fillText('语言 ' + r.lang, 40, 305);
  x.fillText('更新于 ' + timeAgo(r.updated), 260, 305);
  x.fillStyle = '#f0b429'; x.font = '600 22px Consolas, monospace';
  x.fillText(r.url.replace('https://', ''), 40, 400);
  x.fillStyle = grad; x.fillRect(0, H - 6, W, 6);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = r.name.replace('/', '_') + '-card.png';
  a.click();
}

// ===== app.js =====
// 应用入口：状态、事件、视图切换、网址同步（ES Module）






const SORTS = ['stars', 'forks', 'updated', 'trend', 'activity'];
const VIEWS = ['repos', 'devs', 'orgs'];
let reqId = 0;

// ---------- 主题 ----------
// 多主题（paper / ink / stripe / notion）由 index.html 的内联脚本统一管理，这里只保留兼容入口
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }

// ---------- 中英文（简介 / README 中文）：默认中文，中文没有译文时显示英文原文 ----------
function getLang() { return localStorage.getItem('ghrank:lang') || 'zh'; }
function refreshLangBtn() { $('btnLang').textContent = getLang() === 'zh' ? 'English' : '中文'; }
$('btnLang').onclick = () => { localStorage.setItem('ghrank:lang', getLang() === 'zh' ? 'en' : 'zh'); refreshLangBtn(); render(); };
refreshLangBtn();

// ---------- 下拉框 / 分类 ----------
$('lang').append(new Option('全部语言', ''), ...LANGS.map(l => new Option(l, l)));
CATS.forEach(c => {
  const b = el('button', 'cat', c.label);
  b.dataset.cat = c.id;
  b.onclick = () => {
    if (state.cat === c.id) return;
    state.cat = c.id; state.page = 1; markCat(); syncHash(); load();
  };
  $('cats').append(b);
});
function markCat() {
  document.querySelectorAll('.cat').forEach(x => x.classList.toggle('on', x.dataset.cat === state.cat));
}

// ---------- 设置：Token ----------
function refreshTokenHint() {
  $('token').placeholder = getToken()
    ? '已保存 Token（仅本机），输入新值可覆盖'
    : 'GitHub Personal Token（可选，仅保存在本浏览器）';
  updateSourceNote();
}
$('btnSettings').onclick = () => { $('settings').hidden = !$('settings').hidden; refreshTokenHint(); };
$('btnSaveToken').onclick = () => {
  const v = $('token').value.trim();
  if (!v) return;
  setToken(v); $('token').value = ''; refreshTokenHint();
};
$('btnClearToken').onclick = () => { setToken(''); $('token').value = ''; refreshTokenHint(); };

// ---------- 网址状态（可分享）：range/lang/cat/sort/view ----------
// 地址形如 ?range=month&lang=Python&sort=trend&view=devs，默认值不写进地址
let legacyRange = false; // 从旧链接 #week/... 进来时，地址里明确写出 range=week
  function syncHash() {
    const sp = new URLSearchParams();
    if (state.range !== 'week' || legacyRange) sp.set('range', state.range);
  if (state.lang) sp.set('lang', state.lang);
  if (state.cat) sp.set('cat', state.cat);
  if (state.sort !== 'stars') sp.set('sort', state.sort);
  if (state.view !== 'repos') sp.set('view', state.view);
  // page=nav 是「导航页」这个视图的地址标记（与榜单的 view 参数不是一回事），同步地址时保留它
  const pageMark = new URLSearchParams(location.search).get('page');
  if (pageMark === 'nav') sp.set('page', 'nav');
  const qs = sp.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
}
function readHash() {
  const sp = new URLSearchParams(location.search);
  if (!sp.toString() && location.hash.length > 1) {
    // 兼容旧链接 #week/-/-/stars/repos
    const p = location.hash.slice(1).split('/');
    if (p.length >= 4) {
      if (RANGES[p[0]]) { state.range = p[0]; legacyRange = true; }
      state.lang = p[1] === '-' ? '' : p[1];
      state.cat = CATS.some(c => c.id === p[2]) ? p[2] : '';
      if (SORTS.includes(p[3])) state.sort = p[3];
    }
    if (VIEWS.includes(p[4])) state.view = p[4];
    return;
  }
  if (RANGES[sp.get('range')]) state.range = sp.get('range');
  state.lang = sp.get('lang') || '';
  state.cat = CATS.some(c => c.id === sp.get('cat')) ? sp.get('cat') : '';
  if (SORTS.includes(sp.get('sort'))) state.sort = sp.get('sort');
  if (VIEWS.includes(sp.get('view'))) state.view = sp.get('view');
}

// ---------- 数据：筛选 + 排序 ----------
// 智能搜索：空格分词，每个词都要命中（名称、描述、中文译文、语言、主题）；常用中文词映射到英文主题
const SEARCH_SYN = {
  '命令行': ['cli', 'command-line', 'terminal'], '终端': ['terminal', 'cli'], '机器学习': ['machine-learning', 'deep-learning'],
  '人工智能': ['ai', 'llm'], '大模型': ['llm', 'gpt'], '绘图': ['diffusion', 'image', 'stable-diffusion'], '图片': ['image'],
  '前端': ['frontend', 'react', 'vue', 'css'], '后端': ['backend', 'server', 'api'], '数据库': ['database', 'sql'],
  '游戏': ['game', 'gamedev'], '安全': ['security', 'pentest'], '教程': ['tutorial', 'learning', 'awesome'],
  '编辑器': ['editor', 'ide'], '自动化': ['automation'], '爬虫': ['crawler', 'scraper'], '视频': ['video'],
  '音频': ['audio'], '笔记': ['notes'], '部署': ['deploy', 'docker', 'kubernetes'], '容器': ['docker', 'container'],
  '代理': ['proxy', 'vpn'], '面试': ['interview']
};

function searchMatch(r, tokens) {
  const topics = (r.topics || []).map(t => t.toLowerCase());
  const hay = [r.name, r.desc, r.desc_zh || '', r.lang || '', topics.join(' ')].join(' ').toLowerCase();
  return tokens.every(tk => {
    if (hay.includes(tk)) return true;
    const syn = SEARCH_SYN[tk] || [];
    return syn.some(s => topics.includes(s) || hay.includes(s));
  });
}

function visibleRepos() {
  const tokens = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const favs = getFavs();
  let list = state.repos.filter(r => !tokens.length || searchMatch(r, tokens));
  const cat = CATS.find(c => c.id === state.cat);
  if (cat) list = list.filter(r => matchCat(r, cat));
  if (state.favOnly) list = list.filter(r => favs.has(r.name));
  list = [...list];
  const dStars = r => {
    const d = (state.trend[r.name] || {}).dStars;
    return d == null ? -1e18 : d;
  };
  if (state.sort === 'forks') list.sort((a, b) => b.forks - a.forks);
  else if (state.sort === 'updated') list.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  else if (state.sort === 'trend') list.sort((a, b) => dStars(b) - dStars(a));
  else if (state.sort === 'activity') list.sort((a, b) => activityScore(b) - activityScore(a));
  return list;
}

// ---------- 渲染 ----------
function setStatus(text, isError) {
  const s = $('status');
  s.textContent = text;
  s.className = isError ? 'error' : '';
}

function renderSkeleton() {
  const n = window.matchMedia('(min-width:900px)').matches ? 6 : 4;
  $('list').replaceChildren(...Array.from({ length: n }, () => {
    const li = el('li', 'skel');
    li.innerHTML = '<i class="s1"></i><i class="s2"></i><i class="s3"></i><i class="s4"></i>';
    return li;
  }));
  $('list').setAttribute('aria-busy', 'true');
  $('pager').hidden = true;
  setStatus('加载数据…');
}

function showError(e, retryFn) {
  $('list').replaceChildren();
  $('pager').hidden = true;
  ['stats', 'dist', 'authors', 'changes'].forEach(id => { $(id).hidden = true; });
  setStatus(e.message + ' ', true);
  const retry = el('button', 'btn', '重试');
  retry.style.marginLeft = '8px';
  retry.onclick = retryFn;
  $('status').append(retry);
}

function renderRepos() {
  const list = visibleRepos();
  const size = state.pageSize;
  const pages = Math.max(1, Math.ceil(list.length / size));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * size;
  const maxStars = list.length ? Math.max(...list.map(r => r.stars)) : 0;
  $('list').classList.remove('users-view');
  const pageNodes = [];
  list.slice(start, start + size).forEach((r, i) => {
    pageNodes.push(renderItem(r, start + i + 1, maxStars, state.trend));
    const adEvery = (window.ghrankAdEvery && window.ghrankAdEvery.list) || 10;
    if (adEvery > 0 && (i + 1) % adEvery === 0) {
      const ad = document.createElement('li');
      ad.className = 'item ad-inline';
      ad.setAttribute('data-ad-inline', 'list');
      pageNodes.push(ad);
    }
  });
  if (!list.length && state.repos.length) {
    const li = document.createElement('li');
    li.className = 'item empty-item';
    li.innerHTML = '<div class="empty-c"><b>没有符合条件的项目</b><p class="hint">换个关键词，或者清空筛选看看全部榜单。</p></div>';
    const btn = el('button', 'btn', '清空筛选');
    btn.onclick = () => {
      state.q = ''; state.cat = ''; state.lang = ''; state.page = 1;
      if ($('q')) $('q').value = '';
      if ($('lang')) $('lang').value = '';
      markCat();
      syncHash();
      render();
    };
    li.querySelector('.empty-c').append(btn);
    pageNodes.push(li);
  }
  $('list').replaceChildren(...pageNodes);
  $('list').removeAttribute('aria-busy');
  if (window.ghrankMountInline) window.ghrankMountInline();

  renderStats(list);
  renderDist(list);
  renderAuthors(list);
  renderChanges(state.repos, state.trend, state.dropped);

  if (!list.length) setStatus(state.repos.length ? '' : '该条件下暂无项目。');
  else if (state.sort === 'trend' && !state.hasBase) {
    setStatus('增量需要和至少 1 小时前的一次记录对比，隔一段时间再来就能看到。');
  } else setStatus('');

  $('pager').hidden = list.length <= size;
  $('pageInfo').textContent = `第 ${state.page} / ${pages} 页，共 ${list.length} 个`;
  $('prev').disabled = state.page <= 1;
  $('next').disabled = state.page >= pages;
  translateDescs();
}

// 广告配置比榜单晚到（site.json 后到）：让首页脚本能要求重排一次，补上信息流占位
window.__ghrankRenderList = renderRepos;
window.__ghrankSkeleton = renderSkeleton;

// 列表简介：当前页没有中文译文的，批量请求 Worker 翻译（免 Key，结果缓存 30 天）。翻过或失败的不重复请求
const descTried = new Set();
async function translateDescs() {
  if (getLang() !== 'zh') return;
  // 本地静态预览没有 Worker 接口，直接跳过，避免控制台出现 404
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  const list = visibleRepos();
  const start = (state.page - 1) * state.pageSize;
  const todo = list.slice(start, start + state.pageSize)
    .filter(r => r.desc && !r.desc_zh && !descTried.has(r.desc.slice(0, 300)));
  if (!todo.length) return;
  const texts = [...new Set(todo.map(r => r.desc.slice(0, 300)))];
  texts.forEach(t => descTried.add(t));
  try {
    const res = await fetch('/api/desc-zh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: texts })
    }).then(x => x.json());
    if (!res || !res.ok || !res.items) return;
    let changed = false;
    todo.forEach(r => {
      const zh = res.items[r.desc.slice(0, 300)];
      if (zh) { r.desc_zh = zh; changed = true; }
    });
    if (changed && getLang() === 'zh') renderRepos();
  } catch (e) {
    // 翻译失败就继续显示英文原文
  }
}

function renderUsers() {
  const isOrg = state.view === 'orgs';
  const kindLabel = isOrg ? '组织' : '开发者';
  $('list').classList.add('users-view');
  $('list').replaceChildren(...state.users.map((u, i) => {
    const li = el('li', 'item user-item');
    li.append(el('div', 'rank', String(i + 1).padStart(2, '0')));
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = u.avatar; img.alt = ''; img.width = 40; img.height = 40; img.loading = 'lazy'; img.decoding = 'async';
    const body = el('div');
    const a = el('a', 'name', u.login);
    a.href = u.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    const meta = el('p', 'desc');
    meta.textContent = kindLabel + ' · ' + (u.followers != null ? fmt(u.followers) + ' 粉丝' : '按粉丝数从高到低');
    body.append(a, meta);
    const home = el('a', 'mini', '主页 ↗');
    home.href = u.url; home.target = '_blank'; home.rel = 'noopener noreferrer';
    li.append(img, body, home);
    return li;
  }));
  setStatus(state.users.length ? '' : '暂无数据。');
}

// 仓库专用控件在开发者 / 组织视图里隐藏
function toggleRepoOnly() {
  const isRepo = state.view === 'repos';
  document.querySelectorAll('.repo-only').forEach(e => { e.hidden = !isRepo; });
  ['stats', 'dist', 'authors', 'changes', 'pager'].forEach(id => { if (!isRepo) $(id).hidden = true; });
}

function paintFresh() {
  var note = document.getElementById('srcNote');
  if (!note || !note.parentNode) return;
  var box = document.getElementById('freshness');
  if (!box) {
    box = document.createElement('p');
    box.id = 'freshness';
    box.className = 'fresh';
    note.parentNode.insertBefore(box, note);
  }
  var meta = window.__ghrankMeta || null;
  var at = meta && meta.generatedAt ? Date.parse(meta.generatedAt) : 0;
  if (!at) { box.hidden = true; return; }
  var mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  var ago = mins < 60 ? mins + ' 分钟前' : (Math.round(mins / 60) + ' 小时前');
  box.textContent = '数据更新于 ' + ago + ' · 每 3 小时自动抓一次';
  box.hidden = false;
}

function render() {
  toggleRepoOnly();
  if (state.view === 'repos') renderRepos(); else renderUsers();
  updateSourceNote();
  paintFresh();
}

// ---------- 数据加载 ----------
function applyRepos(base, repos) {
  state.repos = repos;
  state.trend = diffSnap(base, repos);
  state.hasBase = hasBaseSnap(base);
  state.dropped = state.hasBase ? droppedSnap(base, repos) : [];
}

async function loadPeople(bypassCache) {
  const id = ++reqId;
  const kind = state.view === 'orgs' ? 'org' : 'user';
  setStatus('加载中…');
  renderSkeleton();
  try {
    const users = await loadUsers(kind, bypassCache);
    if (id !== reqId) return;
    state.users = users;
    renderUsers();
  } catch (e) {
    if (id !== reqId) return;
    showError(e, () => loadPeople(bypassCache));
  }
}

async function load(bypassCache) {
  if (state.view !== 'repos') return loadPeople(bypassCache);
  const id = ++reqId;
  const base = buildQuery(state);
  // 默认直接用静态数据（不发网络请求）；缺少对应 range 时降级到实时拉取
  const meta = bypassCache ? null : staticMeta();
  if (meta) window.__ghrankMeta = meta;
  if (meta) {
    let packed = staticRange(state.range);   // 已加载过（或旧版单文件已就绪）
    if (!packed) {
      // 当前 range 还没下载过：先出骨架屏，再按需插入 script 取回这一个 range
      setStatus('加载数据…');
      renderSkeleton();
      $('pager').hidden = true;
      try { packed = await ensureRange(state.range); } catch (e) { packed = null; }
      if (id !== reqId) return;
    }
    if (packed) {
      // 本地「立即刷新」的结果和仓库里的静态数据，哪个新用哪个；否则旧的本地缓存会一直盖住仓库里的新数据
      const live = readCacheEntry(CACHE_PREFIX + base, STALE_TTL);
      const genAt = Date.parse(meta.generatedAt) || 0;
      if (live && live.t >= genAt) {
        applyRepos(base, live.repos);
        state.source = 'live';
        state.updatedAt = new Date(live.t).toLocaleString();
        render();
        setStatus('');
        return;
      }
      const all = packed.repos || [];
      const repos = state.lang ? all.filter(r => r.lang === state.lang) : all;
      applyRepos(base, repos);
      pushSnap(base, repos);
      const t = meta.generatedAt ? new Date(meta.generatedAt) : null;
      state.source = 'static';
      state.updatedAt = t && !isNaN(t) ? t.toLocaleString() : (meta.generatedAt || '未知');
      render();
      setStatus('');
      return;
    }
  }
  // 24 小时内的旧缓存先显示，再后台更新
  const stale = bypassCache ? null : readCache(CACHE_PREFIX + base, STALE_TTL);
  if (stale) {
    applyRepos(base, stale);
    render();
    setStatus('显示缓存数据，正在后台更新…');
  } else {
    setStatus('加载中…');
    renderSkeleton();
    $('pager').hidden = true;
  }
  try {
    const { repos, partial } = await loadRepos(state, bypassCache);
    if (id !== reqId) return;
    applyRepos(base, repos);
    state.source = 'live';
    state.updatedAt = new Date().toLocaleString();
    render();
    if (partial) setStatus('部分数据加载失败，已显示能拿到的项目。');
  } catch (e) {
    if (id !== reqId) return;
    state.repos = []; state.trend = {}; state.dropped = []; state.hasBase = false;
    showError(e, () => load(bypassCache));
  }
}

// ---------- 数据来源提示 ----------
function updateSourceNote() {
  const el = $('srcNote');
  if (!el) return;
  const when = state.updatedAt ? '（' + state.updatedAt + '）' : '';
  const src = state.source === 'live' ? '当前数据：从 GitHub 实时拉取' + when
    : state.source === 'static' ? '当前数据：定时抓取的静态文件（每 3 小时更新）' + when
    : '当前数据：加载中';
  el.textContent = src + '。' + (getToken()
    ? '点「立即刷新」会用你的 Token 直接请求 GitHub，拉取最新数据。'
    : '点「立即刷新」会使用服务器配置的 Token 实时请求 GitHub；服务器额度用完时，再在「设置」里填写你自己的 Token。');
}

// ---------- 立即刷新（需要 Token；失败时保留当前数据） ----------
let serverMode = false;   // 本次刷新是否用服务端保存的 Token（访客没填自己的 Token 时）

async function serverHasToken() {
  try {
    const r = await fetch('/api/translate', { cache: 'no-store' });
    const d = await r.json();
    return !!(d && d.ok && d.ghConfigured);
  } catch (e) {
    return false;
  }
}

async function liveRefresh() {
  serverMode = false;
  if (!getToken()) {
    if (!(await serverHasToken())) {
      setStatus('还没有可用的 Token，无法立即刷新。当前显示的是定时抓取的静态数据；请在「设置」中填写你自己的 Token 后再试。', true);
      return;
    }
    serverMode = true;
  }
  const id = ++reqId;
  const base = buildQuery(state);
  const btn = $('btnRefresh');
  btn.disabled = true;
  setStatus('正在用 Token 实时刷新，请稍候…');
  // 同时让服务器触发一次仓库数据更新，之后所有访客打开都能拿到新数据
  let serverMsg = '';
  if (serverMode) {
    try {
      const r = await fetch('/api/refresh', { method: 'POST', cache: 'no-store' });
      const d = await r.json();
      serverMsg = d && d.msg ? d.msg : '';
    } catch (e) {
      serverMsg = '';
    }
  }
  try {
    const { repos, partial } = await loadRepos(state, true, n => {
      if (id === reqId) setStatus('正在用 Token 实时刷新，已取到 ' + n + ' 个项目…');
    });
    if (id !== reqId) return;
    applyRepos(base, repos);
    state.source = 'live';
    state.updatedAt = new Date().toLocaleString();
    render();
    const tail = serverMsg ? ' ' + serverMsg : '';
    setStatus((partial
      ? '刷新部分成功：中途有请求失败，只拿到 ' + repos.length + ' 个项目，更新于 ' + state.updatedAt + '。'
      : '刷新成功：共 ' + repos.length + ' 个项目，更新于 ' + state.updatedAt + '。') + tail);
  } catch (e) {
    if (id !== reqId) return;
    setStatus('实时刷新失败：' + e.message + ' 当前仍显示之前的数据。', true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 收藏是否已导出（用来决定关闭页面时要不要提醒） ----------
const FAV_EXPORTED_KEY = 'ghrank:favs-exported';
function favSnapshot() { return JSON.stringify([...getFavs()].sort()); }
function favsUnsaved() {
  if (!getFavs().size) return false;
  return localStorage.getItem(FAV_EXPORTED_KEY) !== favSnapshot();
}

// ---------- 收藏导出 / 导入（JSON 文件，换浏览器或换电脑时带过去） ----------
function exportFavs() {
  const favs = [...getFavs()];
  if (!favs.length) { setStatus('还没有收藏的项目。', true); return; }
  const data = JSON.stringify({ app: 'github-rank', type: 'favs', t: Date.now(), favs }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = 'github-rank-收藏.json';
  a.click();
  localStorage.setItem(FAV_EXPORTED_KEY, favSnapshot());
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importFavs() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let list;
    try {
      const obj = JSON.parse(await file.text());
      list = obj && obj.type === 'favs' && Array.isArray(obj.favs)
        ? obj.favs.filter(x => typeof x === 'string' && /^[\w.-]+\/[\w.-]+$/.test(x))
        : null;
    } catch (e) { list = null; }
    if (!list) { setStatus('导入失败：这不是本站导出的收藏文件。', true); return; }
    const f = getFavs();
    list.forEach(n => f.add(n));
    localStorage.setItem(FAV_KEY, JSON.stringify([...f]));
    render();
    setStatus('已导入 ' + list.length + ' 个收藏，当前共 ' + f.size + ' 个。');
  };
  input.click();
}

// ---------- 导出 CSV（含相对上次的星标变化） ----------
function exportCSV() {
  const list = visibleRepos();
  if (!list.length) { setStatus('当前没有可导出的项目。', true); return; }
  const rows = [['排名', '仓库', '链接', '语言', '星标', '较上次增量', 'Fork', '活跃度', '简介', '最近更新']];
  list.forEach((r, i) => {
    const d = (state.trend[r.name] || {}).dStars;
    rows.push([i + 1, r.name, r.url, r.lang, r.stars, d == null ? '' : d, r.forks, activityScore(r), r.desc, r.updated]);
  });
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const blob = new Blob(['\ufeff' + rows.map(r => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `github-rank-${state.range}-${state.lang || 'all'}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 回到顶部（哨兵 + IntersectionObserver） ----------
const sentinel = document.createElement('div');
sentinel.style.cssText = 'position:absolute;top:400px;width:0;height:0';
document.body.prepend(sentinel);
new IntersectionObserver(([e]) => $('top').classList.toggle('show', !e.isIntersecting)).observe(sentinel);
$('top').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

// ---------- 事件 ----------
function setRange(r) {
  state.range = r;
  document.querySelectorAll('#ranges .btn').forEach(b => b.classList.toggle('on', b.dataset.range === r));
}
function setView(v) {
  if (state.view === v) return;
  state.view = v; state.page = 1; state.users = [];
  document.querySelectorAll('#views .btn').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  toggleRepoOnly();
  syncHash(); load();
}
document.querySelectorAll('#views .btn').forEach(b => { b.onclick = () => setView(b.dataset.view); });
document.querySelectorAll('#ranges .btn').forEach(b => {
  b.onclick = () => {
    if (state.range === b.dataset.range) return;
    setRange(b.dataset.range);
    state.page = 1;
    syncHash(); load();
  };
});
$('lang').onchange = e => { state.lang = e.target.value; state.page = 1; syncHash(); load(); };
$('sort').onchange = e => { state.sort = e.target.value; state.page = 1; syncHash(); render(); };
$('pageSize').onchange = e => { state.pageSize = +e.target.value; state.page = 1; render(); };
$('q').oninput = e => { state.q = e.target.value; state.page = 1; render(); };
$('prev').onclick = () => { state.page--; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
$('next').onclick = () => { state.page++; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
$('btnFavFilter').onclick = () => {
  state.favOnly = !state.favOnly;
  $('btnFavFilter').classList.toggle('on', state.favOnly);
  $('btnFavFilter').textContent = state.favOnly ? '★ 只看收藏（开）' : '☆ 只看收藏';
  state.page = 1;
  render();
};
$('btnRefresh').onclick = () => liveRefresh();
$('btnExport').onclick = exportCSV;
$('btnFavExport').onclick = exportFavs;
$('btnFavImport').onclick = importFavs;

hooks.onLangPick = lang => { state.lang = lang; $('lang').value = lang; state.page = 1; syncHash(); load(); };
hooks.onLangClear = () => { state.lang = ''; $('lang').value = ''; state.page = 1; syncHash(); load(); };
hooks.onFavChanged = render;

// 关闭或刷新页面时，如果收藏有改动还没导出，提醒用户先导出（浏览器只允许显示它自己的通用提示文字）
window.addEventListener('beforeunload', e => {
  if (favsUnsaved()) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- 启动 ----------
initDrawer();
readHash();
setRange(state.range);
document.querySelectorAll('#views .btn').forEach(b => b.classList.toggle('on', b.dataset.view === state.view));
$('lang').value = state.lang;
$('sort').value = state.sort;
markCat();
toggleRepoOnly();
syncHash();
load();

// PWA：仅在 http(s) 下注册（file:// 不支持 service worker）
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 注册失败不影响使用 */ });
}

})();
