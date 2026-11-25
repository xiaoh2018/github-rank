// 用法：node scripts/bump-version.mjs v84
// 同时把 worker.js 的 ASSET_V 与 sw.js 的 CACHE 改到指定版本（必须显式传，避免默认值把版本写回旧号）。
import fs from 'node:fs';

const v = (process.argv[2] || '').trim();
if (!/^v\d+$/.test(v)) {
  console.error('用法：node scripts/bump-version.mjs v84（只接受 v 加数字）');
  process.exit(1);
}
const files = [
  ['worker.js', /const ASSET_V = 'v\d+';/, `const ASSET_V = '${v}';`],
  ['sw.js', /const CACHE = 'ghrank-shell-v\d+';/, `const CACHE = 'ghrank-shell-${v}';`],
];
for (const [file, re, to] of files) {
  const t = fs.readFileSync(file, 'utf8');
  if (!re.test(t)) {
    console.error('找不到版本号：' + file);
    process.exit(1);
  }
  fs.writeFileSync(file, t.replace(re, to), 'utf8');
}
console.log('version -> ' + v);
