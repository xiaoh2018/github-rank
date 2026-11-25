import fs from 'node:fs';
const t = fs.readFileSync('worker.js', 'utf8');
const i = t.indexOf('id="artCatEn"');
console.log('idx', i);
console.log(t.slice(i - 900, i + 500));
