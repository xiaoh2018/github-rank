import fs from 'node:fs';
const doc = 'docs/优化建议.md';
const sec = fs.readFileSync('docs/tmp-section42.md', 'utf8');
const s = fs.readFileSync(doc, 'utf8');
fs.writeFileSync(doc, s.replace(/\s*$/, '\n') + '\n' + sec.trim() + '\n', 'utf8');
fs.unlinkSync('docs/tmp-section42.md');
console.log('doc appended');

for (const [file, from, to] of [
  ['worker.js', "const ASSET_V = 'v70';", "const ASSET_V = 'v71';"],
  ['sw.js', "const CACHE = 'ghrank-shell-v70';", "const CACHE = 'ghrank-shell-v71';"],
]) {
  const t = fs.readFileSync(file, 'utf8');
  if (t.split(from).length - 1 !== 1) { console.error('bump miss ' + file + ' have=' + (t.match(/v7\d/g) || []).join(',')); process.exit(1); }
  fs.writeFileSync(file, t.replace(from, to), 'utf8');
  console.log('bumped ' + file);
}
