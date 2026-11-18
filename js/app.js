// 应用入口：状态、事件、视图切换、网址同步（ES Module）
import { state } from './state.js';
import { RANGES, CATS, LANGS, matchCat } from './config.js';
import {
  getToken, setToken, getFavs, readCache, CACHE_PREFIX, STALE_TTL,
  hasBaseSnap, diffSnap, droppedSnap
} from './cache.js';
import { buildQuery, loadRepos, loadUsers, activityScore } from './api.js';
import {
  $, el, hooks, renderItem, renderStats, renderDist, renderAuthors, renderChanges, initDrawer
} from './ui.js';

const SORTS = ['stars', 'forks', 'updated', 'trend', 'activity'];
const VIEWS = ['repos', 'devs', 'orgs'];
let reqId = 0;

// ---------- 主题 ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('ghrank:theme', t);
}
applyTheme(localStorage.getItem('ghrank:theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('btnTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

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
}
$('btnSettings').onclick = () => { $('settings').hidden = !$('settings').hidden; refreshTokenHint(); };
$('btnSaveToken').onclick = () => {
  const v = $('token').value.trim();
  if (!v) return;
  setToken(v); $('token').value = ''; refreshTokenHint();
};
$('btnClearToken').onclick = () => { setToken(''); $('token').value = ''; refreshTokenHint(); };

// ---------- 网址状态（可分享）：range/lang/cat/sort/view ----------
function syncHash() {
  history.replaceState(null, '', '#' + [state.range, state.lang || '-', state.cat || '-', state.sort, state.view].join('/'));
}
function readHash() {
  const p = (location.hash || '').slice(1).split('/');
  if (p.length >= 4) {
    if (RANGES[p[0]]) state.range = p[0];
    state.lang = p[1] === '-' ? '' : p[1];
    state.cat = CATS.some(c => c.id === p[2]) ? p[2] : '';
    if (SORTS.includes(p[3])) state.sort = p[3];
  }
  if (VIEWS.includes(p[4])) state.view = p[4];
}

// ---------- 数据：筛选 + 排序 ----------
function visibleRepos() {
  const q = state.q.trim().toLowerCase();
  const favs = getFavs();
  let list = state.repos.filter(r => !q || (r.name + ' ' + r.desc).toLowerCase().includes(q));
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
  $('list').replaceChildren(...Array.from({ length: 5 }, () => el('li', 'skel')));
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
  $('list').replaceChildren(...list.slice(start, start + size)
    .map((r, i) => renderItem(r, start + i + 1, maxStars, state.trend)));

  renderStats(list);
  renderDist(list);
  renderAuthors(list);
  renderChanges(state.repos, state.trend, state.dropped);

  if (!list.length) setStatus(state.repos.length ? '没有符合条件的项目。' : '该条件下暂无项目。');
  else if (state.sort === 'trend' && !state.hasBase) {
    setStatus('增量需要和至少 1 小时前的一次记录对比，隔一段时间再来就能看到。');
  } else setStatus('');

  $('pager').hidden = list.length <= size;
  $('pageInfo').textContent = `第 ${state.page} / ${pages} 页，共 ${list.length} 个`;
  $('prev').disabled = state.page <= 1;
  $('next').disabled = state.page >= pages;
}

function renderUsers() {
  const kindLabel = state.view === 'orgs' ? '组织' : '开发者';
  $('list').replaceChildren(...state.users.map((u, i) => {
    const li = el('li', 'item user-item');
    li.append(el('div', 'rank', String(i + 1).padStart(2, '0')));
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = u.avatar; img.alt = ''; img.width = 40; img.height = 40; img.loading = 'lazy';
    const body = el('div');
    const a = el('a', 'name', u.login);
    a.href = u.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    body.append(a, el('p', 'desc', kindLabel + ' · 按粉丝数从高到低'));
    li.append(img, body);
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

function render() {
  toggleRepoOnly();
  if (state.view === 'repos') renderRepos(); else renderUsers();
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
    render();
    if (partial) setStatus('部分数据加载失败，已显示能拿到的项目。');
  } catch (e) {
    if (id !== reqId) return;
    state.repos = []; state.trend = {}; state.dropped = []; state.hasBase = false;
    showError(e, () => load(bypassCache));
  }
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
$('btnRefresh').onclick = () => load(true);
$('btnExport').onclick = exportCSV;

hooks.onLangPick = lang => { state.lang = lang; $('lang').value = lang; state.page = 1; syncHash(); load(); };
hooks.onLangClear = () => { state.lang = ''; $('lang').value = ''; state.page = 1; syncHash(); load(); };
hooks.onFavChanged = render;

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
