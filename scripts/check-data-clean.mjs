// data 目录卫生门禁：任何会写数据的门禁跑完，data/*.json 必须与 git HEAD 完全一致。
// 用法：node scripts/check-data-clean.mjs（需要 dev-server 在跑）
// 背景：2026-11-27 截图里出现了一篇早就删掉的测试文章 —— 磁盘已还原，dev-server 内存里还是旧的三篇。
// 这条门禁把「还原」从纪律变成断言：跑一个会写数据的门禁 → 逐字节比对 → 顺带比对 dev-server 的内存视图。
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const base = process.env.BASE || 'http://127.0.0.1:8123';
let fails = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  [' + (detail == null ? '' : detail) + ']'));
  if (!cond) fails++;
};

const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
function snapshot() {
  const out = {};
  for (const name of fs.readdirSync(DATA).sort()) {
    const p = path.join(DATA, name);
    if (!fs.statSync(p).isFile()) continue;
    out[name] = digest(fs.readFileSync(p));
  }
  return out;
}
function diff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) if (a[k] !== b[k]) out.push(k + ' (' + (a[k] || '∅') + ' → ' + (b[k] || '∅') + ')');
  return out;
}

// 1) 跑之前：data 必须已经和 git HEAD 一致（否则后面无法判断是谁改的）
const dirtyBefore = spawnSync('git', ['status', '--porcelain', '--', 'data'], { cwd: ROOT, encoding: 'utf8' });
ok('跑之前 data/ 与 git HEAD 一致', (dirtyBefore.stdout || '').trim() === '', JSON.stringify((dirtyBefore.stdout || '').trim()));

const before = snapshot();
ok('data/ 里有可检查的 JSON 文件', Object.keys(before).length >= 3, JSON.stringify(Object.keys(before)));

// 2) 跑一个会写数据的门禁（它会新增/改分类/删除文章，然后自己还原）
const target = process.env.GATE || 'check-articles.mjs';
const child = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join('scripts', target)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (b) => (out += b));
  p.stderr.on('data', (b) => (out += b));
  const timer = setTimeout(() => p.kill('SIGKILL'), 240000);
  p.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
});
ok('被检查的门禁本身跑通：' + target, child.code === 0, 'exit ' + child.code + ' :: ' + child.out.split('\n').filter(Boolean).slice(-2).join(' / '));

// 3) 跑完：逐字节比对
const after = snapshot();
const changed = diff(before, after);
ok('门禁跑完后 data/ 逐字节还原', changed.length === 0, changed.join('; '));

const dirtyAfter = spawnSync('git', ['status', '--porcelain', '--', 'data'], { cwd: ROOT, encoding: 'utf8' });
ok('门禁跑完后 git 看不到 data/ 改动', (dirtyAfter.stdout || '').trim() === '', JSON.stringify((dirtyAfter.stdout || '').trim()));

// 4) dev-server 的内存视图也要和磁盘一致（缓存污染会让截图与线上证据撒谎）
let served = null;
try {
  const r = await fetch(base + '/data/articles.json?__clean=' + Date.now(), { cache: 'no-store' });
  served = await r.json();
} catch (e) {
  served = null;
}
const diskArts = JSON.parse(fs.readFileSync(path.join(DATA, 'articles.json'), 'utf8'));
const servedArts = Array.isArray(served) ? served : served && Array.isArray(served.articles) ? served.articles : null;
if (!servedArts) {
  ok('dev-server 在跑（否则内存一致性无法检查）', false, '取不到 /data/articles.json，先 npm run dev');
} else {
  const idsDisk = diskArts.map((a) => a.id).sort().join(',');
  const idsServed = servedArts.map((a) => a.id).sort().join(',');
  ok('dev-server 提供的文章与磁盘一致（无缓存残留）', idsDisk === idsServed, 'disk=' + idsDisk + ' served=' + idsServed);
}

// 5) 不许把测试数据留在磁盘上
const junk = [];
for (const name of fs.readdirSync(DATA)) {
  if (!name.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
  const arr = Array.isArray(j) ? j : j && Array.isArray(j.articles) ? j.articles : [];
  for (const it of arr) {
    const s = JSON.stringify(it);
    if (/e2e|layout test|测试文章|placeholder|asdf/i.test(s)) junk.push(name + ': ' + (it.title || it.name || it.id));
  }
}
ok('data/ 里没有测试数据残留', junk.length === 0, junk.slice(0, 4).join('; '));

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL OK');
process.exit(fails ? 1 : 0);
