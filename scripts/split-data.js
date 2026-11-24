// 把旧的合并文件 data/repos.js（window.__GHRANK_DATA__）拆成
// data/repos-meta.js + data/repos-<range>.js。
//
// 用途：
//   1) 首次迁移：把仓库里已有的旧数据立刻拆好，避免「页面已改成按需加载、但新文件还没生成」的空窗期；
//   2) 应急修复：Action 出问题、只有旧文件时，本地跑一次即可恢复。
// 平时不需要跑：Action 里的 scripts/fetch.js 会直接写新格式。
//
// 用法：node scripts/split-data.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEGACY = path.join(DATA_DIR, 'repos.js');

function toJs(v, indent) {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '[\n' + v.map((x) => indent + '  ' + toJs(x, indent + '  ')).join(',\n') + '\n' + indent + ']';
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return '{\n' + keys.map((k) => `${indent}  ${k}: ${toJs(v[k], indent + '  ')}`).join(',\n') + '\n' + indent + '}';
  }
  return JSON.stringify(v);
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function main() {
  if (!fs.existsSync(LEGACY)) {
    console.error('找不到 data/repos.js，无需拆分');
    process.exitCode = 1;
    return;
  }
  const text = fs.readFileSync(LEGACY, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(text, sandbox, { timeout: 10000 });
  const data = sandbox.window.__GHRANK_DATA__;
  if (!data || !data.ranges) {
    console.error('data/repos.js 里没有 __GHRANK_DATA__.ranges，格式不认识');
    process.exitCode = 1;
    return;
  }

  const generatedAt = data.generatedAt || new Date().toISOString();
  const names = Object.keys(data.ranges);
  const counts = {};
  names.forEach((n) => {
    counts[n] = ((data.ranges[n] && data.ranges[n].repos) || []).length;
  });

  writeAtomic(
    path.join(DATA_DIR, 'repos-meta.js'),
    `window.__GHRANK_META__ = {\n` +
      `  generatedAt: ${JSON.stringify(generatedAt)},\n` +
      `  counts: ${JSON.stringify(counts)},\n` +
      `  users: ${toJs(data.users || {}, '  ')}\n` +
      `};\n`
  );

  names.forEach((name) => {
    const repos = (data.ranges[name] && data.ranges[name].repos) || [];
    writeAtomic(
      path.join(DATA_DIR, 'repos-' + name + '.js'),
      `window.__GHRANK_RANGES__ = window.__GHRANK_RANGES__ || {};\n` +
        `window.__GHRANK_RANGES__[${JSON.stringify(name)}] = {\n` +
        `  range: ${JSON.stringify(name)},\n` +
        `  repos: ${toJs(repos, '  ')}\n` +
        `};\n`
    );
  });

  const size = (f) => (fs.statSync(path.join(DATA_DIR, f)).size / 1024).toFixed(1) + 'KB';
  console.log(`已拆分（generatedAt ${generatedAt}）`);
  console.log('  repos-meta.js  ' + size('repos-meta.js'));
  names.forEach((n) => console.log('  repos-' + n + '.js  ' + size('repos-' + n + '.js') + '  ' + counts[n] + ' 条'));
}

main();
