// 后台引用自查：ADMIN_PAGE 里的 $('id') / getElementById('id') 引用是否都有对应元素。
// 目的：抓「面板重写把某个 id 吞了 → 打开后台某个 tab 就 undefined 报错」这类问题。
// 用法：node scripts/check-admin-refs.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('worker.js', 'utf8');
const start = src.indexOf('const ADMIN_PAGE = `');
if (start < 0) {
  console.error('找不到 ADMIN_PAGE');
  process.exit(1);
}
const end = src.indexOf('`;', start + 20);
const page = src.slice(start, end);

// 1) 页面里所有静态 id
const ids = new Set();
for (const m of page.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(m[1]);
// 模板插值里动态生成的 id（例如 AD_SLOTS 生成的 data-ad-slot 不算）
for (const m of page.matchAll(/\$\{[^}]*\}/g)) ids.add('__tpl__');

// 2) 脚本里引用的 id
const refs = new Map();
const isPlainId = (x) => /^[A-Za-z][\w-]*$/.test(x);
for (const m of page.matchAll(/\$\('([^']+)'\)/g)) {
  const id = m[1];
  if (!isPlainId(id)) continue;
  if (!refs.has(id)) refs.set(id, 0);
  refs.set(id, refs.get(id) + 1);
}
for (const m of page.matchAll(/getElementById\('([^']+)'\)/g)) {
  const id = m[1];
  if (!isPlainId(id)) continue;
  refs.set(id, (refs.get(id) || 0) + 1);
}
// 3) 脚本里动态创建的 id（innerHTML 里拼出来的）
const dyn = new Set();
for (const m of page.matchAll(/id=\\?["'`]?([A-Za-z][\w-]*)["'`]?\s*\$/g)) dyn.add(m[1]);

const missing = [];
for (const [id, n] of refs) {
  if (ids.has(id) || dyn.has(id)) continue;
  missing.push({ id, n });
}
missing.sort((a, b) => b.n - a.n);

console.log('静态 id ' + ids.size + ' 个，脚本引用 ' + refs.size + ' 个');
if (missing.length === 0) {
  console.log('✓ 所有 $(\'id\') 引用都能在 HTML 里找到');
} else {
  console.log('! 找不到对应元素的引用 ' + missing.length + ' 个：');
  for (const m of missing) console.log('  - ' + m.id + '  (被引用 ' + m.n + ' 次)');
  process.exitCode = 1;
}
