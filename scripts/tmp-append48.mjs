import fs from 'node:fs';
const doc = 'docs/优化建议.md';
const secPath = 'docs/tmp-section48.md';
const sec = fs.readFileSync(secPath, 'utf8');
const s = fs.readFileSync(doc, 'utf8');
fs.writeFileSync(doc, s.replace(/\s*$/, '\n') + '\n' + sec.trim() + '\n', 'utf8');
fs.unlinkSync(secPath);
console.log('doc appended');
