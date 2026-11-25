import fs from 'node:fs';
const s=fs.readFileSync('js/bundle.js','utf8').replace(/\r\n/g,'\n');
let i=s.indexOf("document.querySelectorAll('#ranges .btn')");console.log(s.slice(i,i+600));
for (const k of ['const RANGE_FILES','const SEGMENTS','const RANGES']) { const j=s.indexOf(k); console.log('\n--- '+k+'\n'+s.slice(j,j+420)); }
console.log('\n--- index ranges buttons');
const h=fs.readFileSync('index.html','utf8');
const m=h.match(/<div[^>]*id="ranges"[\s\S]{0,700}/);console.log(m?m[0]:'none');
console.log('\n--- data file keys');
const d=fs.readFileSync('data/repos-total.js','utf8').slice(0,160);console.log(d);
