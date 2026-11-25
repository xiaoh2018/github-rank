// 用法：node scripts/append-doc.mjs docs/tmp-section53.md
// 把 Markdown 片段追加到 docs/优化建议.md 末尾，然后删除片段文件。
import fs from 'node:fs';

const frag = process.argv[2];
if (!frag) {
  console.error('用法：node scripts/append-doc.mjs <片段文件>');
  process.exit(1);
}
const doc = 'docs/优化建议.md';
const sec = fs.readFileSync(frag, 'utf8');
const s = fs.readFileSync(doc, 'utf8');
fs.writeFileSync(doc, s.replace(/\s*$/, '\n') + '\n' + sec.trim() + '\n', 'utf8');
fs.unlinkSync(frag);
console.log('doc appended:', frag);
