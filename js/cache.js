// 缓存 / 收藏 / Token / 趋势快照（ES Module）
export const CACHE_TTL = 2 * 60 * 60 * 1000;     // 2 小时内直接命中
export const STALE_TTL = 24 * 60 * 60 * 1000;    // 24 小时内可先显示再后台刷新
export const CACHE_PREFIX = 'ghrank:cache:';
const SNAP_PREFIX = 'ghrank:snap:';
const SNAP_MAX = 6;                              // 每个查询保留最近 6 份快照
const SNAP_GAP = 60 * 60 * 1000;                 // 1 小时内不重复记快照，也不和自己比
const TOKEN_KEY = 'ghrank:token';
const FAV_KEY = 'ghrank:favs';

function safeParse(s, fb) {
  try { return JSON.parse(s) ?? fb; } catch (e) { return fb; }
}

// ---------- 榜单缓存 ----------
export function readCache(key, maxAge) {
  const c = safeParse(localStorage.getItem(key), null);
  if (c && Date.now() - c.t < (maxAge || CACHE_TTL)) return c.repos;
  return null;
}

export function saveCache(key, repos) {
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
export function getFavs() { return new Set(safeParse(localStorage.getItem(FAV_KEY), [])); }
export function toggleFav(name) {
  const f = getFavs();
  f.has(name) ? f.delete(name) : f.add(name);
  localStorage.setItem(FAV_KEY, JSON.stringify([...f]));
  return f.has(name);
}

// ---------- Token ----------
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export function setToken(v) {
  if (v) localStorage.setItem(TOKEN_KEY, v);
  else localStorage.removeItem(TOKEN_KEY);
}

// ---------- 趋势快照：按查询存 [{t, repos:[{n,s}]}]，最新在前 ----------
export function readSnaps(q) { return safeParse(localStorage.getItem(SNAP_PREFIX + q), []); }

export function pushSnap(q, repos) {
  const list = readSnaps(q);
  const last = list[0];
  if (last && Date.now() - last.t < SNAP_GAP) return;
  list.unshift({ t: Date.now(), repos: repos.map(r => ({ n: r.name, s: r.stars })) });
  try { localStorage.setItem(SNAP_PREFIX + q, JSON.stringify(list.slice(0, SNAP_MAX))); }
  catch (e) { /* 存不下就算了，趋势是增强功能 */ }
}

// 是否已有至少 1 小时前的快照可对比
export function hasBaseSnap(q) {
  const cutoff = Date.now() - SNAP_GAP;
  return readSnaps(q).some(s => s.t <= cutoff);
}

// 和至少 1 小时前的快照对比：每个项目的星标增量和排名变化
export function diffSnap(q, repos) {
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
export function droppedSnap(q, repos) {
  const cutoff = Date.now() - SNAP_GAP;
  const old = readSnaps(q).find(s => s.t <= cutoff);
  if (!old) return [];
  const now = new Set(repos.map(r => r.name));
  return old.repos
    .map((r, i) => ({ name: r.n, stars: r.s, rank: i + 1 }))
    .filter(x => !now.has(x.name))
    .slice(0, 20);
}
