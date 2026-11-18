// GitHub API：分段 + 分页扩量、用户榜、详情（README / Release / 贡献者）、活跃度（ES Module）
import { CACHE_PREFIX, readCache, saveCache, pushSnap, getToken } from './cache.js';
import { RANGES } from './config.js';

export const MIN_STARS = 50;
const PAGE_SIZE = 100;          // GitHub 单页上限
const PAGES_PER_SEG = 3;        // 每段最多翻 3 页（300 条）
const MAX_TOTAL = 500;          // 合并后最多保留 500 条

// 各时间范围的星标区间（互不重叠，由高到低）
const SEGMENTS = {
  week:  [{ lo: 500 }, { lo: 200, hi: 500 }, { lo: 50, hi: 200 }],
  month: [{ lo: 1000 }, { lo: 200, hi: 1000 }, { lo: 50, hi: 200 }],
  year:  [{ lo: 2000 }, { lo: 500, hi: 2000 }, { lo: 100, hi: 500 }, { lo: 50, hi: 100 }],
  all:   [{ lo: 20000 }, { lo: 5000, hi: 20000 }, { lo: 1000, hi: 5000 }, { lo: 200, hi: 1000 }]
};

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export function buildQuery(state) {
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
  const url = `https://api.github.com/search/${kind}?q=${encodeURIComponent(q)}` +
    `&sort=${sort}&order=desc&per_page=${PAGE_SIZE}&page=${page}`;
  const headers = { Accept: 'application/vnd.github+json' };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    res = await fetch(url, { headers, signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? '请求超时（GitHub 接口响应太慢），请重试或稍后再来。'
      : '网络请求失败，请检查网络连接后重试。');
  } finally { clearTimeout(timer); }
  if (res.status === 403 || res.status === 429) {
    throw new Error(token
      ? '已触发 GitHub 请求限制，当前 Token 的额度也已用完，请稍后再试。'
      : '已触发 GitHub 请求限制（未填 Token 时搜索每分钟只能 10 次），请稍后再试；也可以在「设置」中填写 Token。');
  }
  if (res.status === 422) throw new Error('查询条件无效，请换一个筛选条件。');
  if (!res.ok) throw new Error('请求失败（HTTP ' + res.status + '），请稍后重试。');
  const data = await res.json();
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

// 分段 + 分页拉取，合并去重。返回 {repos, partial}；partial=中途失败，只用了已拿到的数据（不缓存）
export async function loadRepos(state, bypassCache) {
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
  outer: for (const seg of segs) {
    for (let page = 1; page <= PAGES_PER_SEG; page++) {
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
export async function loadUsers(kind, bypassCache) {
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
  const headers = { Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json' };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('https://api.github.com' + path, { headers });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return raw ? res.text() : res.json();
}

export const fetchRepoDetail = name => gh('/repos/' + name);
export const fetchReadme = name => gh('/repos/' + name + '/readme', true);

// 没有 Release 时接口返回 404，这里返回 null 而不是报错
export async function fetchLatestRelease(name) {
  try { return await gh('/repos/' + name + '/releases/latest'); } catch (e) { return null; }
}

export async function fetchContributors(name) {
  try { return (await gh('/repos/' + name + '/contributors?per_page=8')) || []; } catch (e) { return []; }
}

// ---------- 活跃度评分（0-100） ----------
// 权重：最近 push 40% + 星标量 25% + Fork 20% + open issues 15%
export function activityScore(r) {
  const daysSincePush = Math.min(730, (Date.now() - new Date(r.pushed || r.updated)) / 86400000);
  const fresh = Math.max(0, 1 - daysSincePush / 365) * 40;
  const starS = Math.min(1, Math.log10(Math.max(1, r.stars)) / 5.5) * 25;
  const forkS = Math.min(1, Math.log10(Math.max(1, r.forks)) / 4.5) * 20;
  const issS = Math.min(1, Math.log10(Math.max(1, r.issues)) / 3) * 15;
  return Math.round(fresh + starS + forkS + issS);
}
