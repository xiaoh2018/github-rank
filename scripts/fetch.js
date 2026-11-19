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
// 简介翻译（MyMemory 免 Key 接口）：匿名每天 5000 字符；填了联系邮箱（TRANSLATE_EMAIL）后 50000 字符
const TRANSLATE_EMAIL = process.env.TRANSLATE_EMAIL || 'xiaoh2018@gmail.com';
const TRANSLATE_BUDGET = TRANSLATE_EMAIL ? 45000 : 4500; // 每次抓取最多翻译的字符数，留余量
const ZH_FILE = path.join(__dirname, '..', 'data', 'desc-zh.json');
const README_ZH_FILE = path.join(__dirname, '..', 'data', 'readme-zh.json');
const README_BUDGET = 15000;   // 每次抓取最多翻译的 README 字符数（和简介共用 MyMemory 每日额度，留余量）
const README_TOP = 40;         // 只预翻译星标最高的前 N 个仓库的 README
const MS_KEY = process.env.MS_TRANSLATOR_KEY || '';       // 可选：微软翻译 Key，MyMemory 额度用完时兜底
const MS_REGION = process.env.MS_TRANSLATOR_REGION || '';

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

function loadZhCache() {
  try { return JSON.parse(fs.readFileSync(ZH_FILE, 'utf8')); } catch (e) { return {}; }
}

async function translateOne(text) {
  const q = text.slice(0, 400);
  let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=en|zh-CN';
  if (TRANSLATE_EMAIL) url += '&de=' + encodeURIComponent(TRANSLATE_EMAIL);
  const res = await fetch(url, { headers: { 'User-Agent': 'ghrank-fetch' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const out = data.responseData && data.responseData.translatedText;
  if (data.responseStatus !== 200 || !out || /MYMEMORY WARNING|QUOTA/i.test(out)) {
    throw new Error('额度用完或翻译失败：' + (data.responseDetails || data.responseStatus));
  }
  return out;
}

// 只翻译还没有译文的简介；超出预算或出错就停止，没翻到的页面显示英文原文
async function translateDescs(repos) {
  const cache = loadZhCache();
  const todo = [...new Set(repos.map(r => r.desc).filter(d => d && !cache[d]))];
  let used = 0, done = 0;
  for (const d of todo) {
    if (used + d.length > TRANSLATE_BUDGET) break;
    try {
      cache[d] = await translateOne(d);
      used += d.length; done++;
      await sleep(300);
    } catch (e) {
      console.log('  简介翻译停止：' + e.message);
      break;
    }
  }
  console.log(`简介翻译：新增 ${done} 条，用了 ${used} 字符，剩余待翻译 ${todo.length - done} 条`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(ZH_FILE, JSON.stringify(cache, null, 1), 'utf8');
  return cache;
}

async function translateMS(text) {
  if (!MS_KEY) throw new Error('未配置微软翻译 Key');
  const headers = { 'Ocp-Apim-Subscription-Key': MS_KEY, 'Content-Type': 'application/json' };
  if (MS_REGION) headers['Ocp-Apim-Subscription-Region'] = MS_REGION;
  const res = await fetch('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans', {
    method: 'POST', headers, body: JSON.stringify([{ Text: text }]),
  });
  if (!res.ok) throw new Error('微软翻译 HTTP ' + res.status);
  const d = await res.json();
  const out = d && d[0] && d[0].translations && d[0].translations[0] && d[0].translations[0].text;
  if (!out) throw new Error('微软翻译返回为空');
  return out;
}

// 先 MyMemory，额度用完或出错再用微软（配置了 Key 时）
async function translateAny(text) {
  try { return await translateOne(text); } catch (e) {
    if (!MS_KEY) throw e;
    return translateMS(text);
  }
}

// 和 worker.js 的切分规则一致：代码块、表格、图片、HTML 原样保留，普通段落每段最多 300 字符
function splitMd(md) {
  const out = [];
  for (const b of md.replace(/\r/g, '').split(/\n\s*\n/)) {
    const t = b.trim();
    if (!t) continue;
    if (t.includes('```') || /^(\||<|!\[|\[!\[)/.test(t)) { out.push({ raw: true, text: t }); continue; }
    for (let i = 0; i < t.length; i += 300) out.push({ raw: false, text: t.slice(i, i + 300) });
  }
  return out;
}

// 批量预翻译 README（只翻前 README_TOP 个高星仓库，已有完整译文的跳过；额度用完立即停止）
async function translateReadmes(repos) {
  let map = {};
  try { map = JSON.parse(fs.readFileSync(README_ZH_FILE, 'utf8')); } catch (e) { map = {}; }
  const top = [...new Map(repos.map(r => [r.name, r])).values()]
    .sort((a, b) => b.stars - a.stars).slice(0, README_TOP);
  const hdr = { Accept: 'application/vnd.github.raw', 'User-Agent': 'ghrank-fetch' };
  if (TOKEN) hdr.Authorization = 'Bearer ' + TOKEN;
  let used = 0, stored = 0, stop = false;
  for (const r of top) {
    if (stop) break;
    if (map[r.name] && !map[r.name].partial) continue;
    if (used >= README_BUDGET) break;
    try {
      const res = await fetch('https://api.github.com/repos/' + r.name + '/readme', { headers: hdr });
      if (!res.ok) continue;
      const parts = splitMd((await res.text()).slice(0, 12000)).slice(0, 30);
      const out = [];
      let partial = false, okCount = 0;
      for (const p of parts) {
        if (p.raw) { out.push(p.text); continue; }
        if (stop || used + p.text.length > README_BUDGET) { out.push(p.text); partial = true; continue; }
        try {
          out.push(await translateAny(p.text));
          used += p.text.length; okCount++;
          await sleep(300);
        } catch (e) {
          out.push(p.text); partial = true; stop = true;
          console.log('  README 翻译停止：' + e.message);
        }
      }
      if (okCount > 0) {
        map[r.name] = { partial: partial, text: out.join('\n\n') };
        stored++;
      }
    } catch (e) {
      console.log('  README 读取失败（' + r.name + '）：' + e.message);
    }
  }
  console.log(`README 翻译：更新 ${stored} 个，用了 ${used} 字符`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(README_ZH_FILE, JSON.stringify(map, null, 1), 'utf8');
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

  const allRepos = Object.values(ranges).flatMap(x => x.repos);
  const zh = await translateDescs(allRepos);
  allRepos.forEach(r => { r.desc_zh = zh[r.desc] || ''; });
  await translateReadmes(allRepos);

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
