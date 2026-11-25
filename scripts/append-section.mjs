// 用法：node scripts/append-section.mjs docs/tmp-section42.md
// 把写好的 markdown 片段追加到 docs/优化建议.md 末尾，然后删掉片段文件。
// 版本号请单独用 node scripts/bump-version.mjs v108（以前这里顺手写死过 v70→v71，造成误报）。
import fs from 'node:fs';

const path = process.argv[2];
if (!path || !fs.existsSync(path)) {
  console.error('用法：node scripts/append-section.mjs docs/tmp-sectionNN.md');
  process.exit(1);
}
const doc = 'docs/优化建议.md';
const sec = fs.readFileSync(path, 'utf8').trim();
const s = fs.readFileSync(doc, 'utf8');
fs.writeFileSync(doc, s.replace(/\s*$/, '\n') + '\n' + sec + '\n', 'utf8');
fs.unlinkSync(path);
console.log('doc appended (' + sec.length + ' 字符)');
