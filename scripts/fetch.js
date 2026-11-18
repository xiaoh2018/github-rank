#!/usr/bin/env node
'use strict';
// 抓取 GitHub 榜单，写入 data/repos.js（供页面用 <script src> 加载）。
// 只用 Node 20 内置 fetch，无依赖。任何一步失败：非零退出，不写入 data/repos.js。

const fs = require('fs');
const path = require('path');

const MIN_STARS = 50;
const PAGE_SIZE = 100;      // GitHub 单页上限
const PAGES_PER_SEG = 3;    // 每段最多翻 3 页
const MAX_KEEP = 500;       // 每个 range 最多保留条数
const MAX_RETRY = 3;        // 403/429 最多重试次数
const TOKEN = process.env.GITHUB_TOKEN || '';
const INTERVAL_MS = TOKEN ? 2200 : 6500; // 未登录每分钟 10 次；有 token 每分钟 30 次

const OUT_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(OUT_DIR, 'repos.js');
const TMP_FILE = OUT_FILE + '.tmp';

// 星标分段（互不重叠，由高到低）。hi 缺省表示 '>lo'
const RANGES = {
  week:  { days: 7,   segs: [{ lo: 500 }, { lo: 200, hi: 500 }, { lo: 50, hi: 200 }] },
  month: { days: 30,  segs: [{ lo: 1000 }, { lo: 200, hi: 1000 }, { lo: 50, hi: 200 }] },
  year:  { days: 365, segs: [{ lo: 2000 }, { lo: 500, hi: 2000 }, { lo: 100, hi: 500 }, { lo: 50, hi: 100 }] },
  all:   { days: 0,   segs: [{ lo: 20000 }, { lo: 5000, hi: 20000 }, { lo: 1000, hi: 5000 }, { lo: 200, hi: 1000 }] },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function dateStr(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function segQuery(base, seg) {
  const stars = seg.hi ? `stars:${seg.lo}..${seg.hi}` : `stars:>${seg.lo}`;
  return base.replace('stars:>' + MIN_STARS, stars);
}

function trimRepo(r) {
  return {
    name: r.full_name,
    url: r.html_url,
    desc: r.description || '',
    lang: r.language || '',
    stars: r.stargazers_count,
    forks: r.forks_count,
    issues: r.open_issues_count,
    updated: r.updated_at,
    pushed: r.pushed_at,
    created: r.created_at,
    license: (r.license && r.license.spdx_id) || '',
    topics: (r.topics || []).slice(0, 5),
  };
}

// 全局节流：两次 search 请求之间至少间隔 INTERVAL_MS
let lastAt = 0;
async function throttle() {
  const wait = lastAt + INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

// 计算 403/429 后的等待毫秒数：优先 retry-after，其次 x-ratelimit-reset
function retryWaitMs(res) {
  const ra = res.headers.get('retry-after');
  if (ra && !isNaN(Number(ra))) return Number(ra) * 1000 + 1000;
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (reset) return Math.max(reset * 1000 - Date.now(), 0) + 1000;
  return 60000;
}

async function ghSearch(kind, q, params) {
  const url = `https://api.github.com/search/${kind}?q=${encodeURIComponent(q)}&${params}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ghrank-fetch',
  };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();

    if ((res.status === 403 || res.status === 429) && attempt < MAX_RETRY) {
      const wait = retryWaitMs(res);
      console.log(`  HTTP ${res.status} 被限速，等待 ${Math.ceil(wait / 1000)}s 后重试（第 ${attempt + 1}/${MAX_RETRY} 次）`);
      await sleep(wait);
      continue;
    }
    const body = await res.text().catch(() => '');
    throw new Error(`${kind} 请求失败 HTTP ${res.status}（查询：${q}）：${body.slice(0, 200)}`);
  }
}

async function fetchSegment(base, seg, rangeName) {
  const q = segQuery(base, seg);
  const items = [];
  for (let page = 1; page <= PAGES_PER_SEG; page++) {
    const data = await ghSearch('repositories', q,
      `sort=stars&order=desc&per_page=${PAGE_SIZE}&page=${page}`);
    const got = data.items || [];
    items.push(...got);
    console.log(`  [${rangeName}] ${q} 第 ${page} 页取到 ${got.length} 条，段内累计 ${items.length}`);
    if (got.length < PAGE_SIZE) break; // 没取满 100 条，不再翻页
  }
  return items;
}

async function fetchRange(name, cfg) {
  const base = 'stars:>' + MIN_STARS + (cfg.days ? ' created:>' + dateStr(cfg.days) : '');
  console.log(`[range ${name}] 基础查询：${base}`);
  const map = new Map();
  for (const seg of cfg.segs) {
    const items = await fetchSegment(base, seg, name);
    for (const r of items) if (!map.has(r.full_name)) map.set(r.full_name, r);
    console.log(`[range ${name}] 去重后累计 ${map.size} 条`);
  }
  const repos = [...map.values()]
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, MAX_KEEP)
    .map(trimRepo);
  console.log(`[range ${name}] 完成，保留 ${repos.length} 条`);
  return { repos };
}

async function fetchUsers(type) {
  const q = `type:${type} followers:>1000`;
  console.log(`[users ${type}] 查询：${q}`);
  const data = await ghSearch('users', q, 'sort=followers&order=desc&per_page=50&page=1');
  const list = (data.items || []).slice(0, 50).map(u => ({
    login: u.login,
    url: u.html_url,
    avatar: u.avatar_url,
  }));
  console.log(`[users ${type}] 完成，${list.length} 条`);
  return list;
}

// 序列化为 JS 对象字面量（键不加引号，值用 JSON 字符串形式，合法 JS）
function toJs(v, indent) {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '[\n' + v.map(x => indent + '  ' + toJs(x, indent + '  ')).join(',\n') + '\n' + indent + ']';
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return '{\n' + keys.map(k => `${indent}  ${k}: ${toJs(v[k], indent + '  ')}`).join(',\n') + '\n' + indent + '}';
  }
  return JSON.stringify(v);
}

async function main() {
  console.log(`GitHub Token：${TOKEN ? '已设置（请求间隔 2200ms）' : '未设置（请求间隔 6500ms）'}`);
  const ranges = {};
  for (const name of Object.keys(RANGES)) {
    ranges[name] = await fetchRange(name, RANGES[name]);
  }
  const users = {
    devs: await fetchUsers('user'),
    orgs: await fetchUsers('org'),
  };

  const generatedAt = new Date().toISOString();
  const text =
    `window.__GHRANK_DATA__ = {\n` +
    `  generatedAt: ${JSON.stringify(generatedAt)},\n` +
    `  ranges: ${toJs(ranges, '  ')},\n` +
    `  users: ${toJs(users, '  ')}\n` +
    `};\n`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(TMP_FILE, text, 'utf8');
  fs.renameSync(TMP_FILE, OUT_FILE);
  console.log(`已写入 ${path.relative(process.cwd(), OUT_FILE)}（generatedAt ${generatedAt}）`);
}

main().catch(err => {
  console.error('抓取失败，未写入 data/repos.js，保留旧文件：', err && err.message ? err.message : err);
  process.exitCode = 1;
});
