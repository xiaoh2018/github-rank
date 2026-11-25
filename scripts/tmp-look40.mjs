import fs from 'node:fs';
const s=fs.readFileSync('js/bundle.js','utf8').replace(/\r\n/g,'\n');
for (const k of ['function ensureRange','async function loadRepos','function render(','state.all','data-range','setRange']) console.log(k+' => '+(s.split(k).length-1));
const i=s.indexOf('async function loadRepos');
console.log('\n--- loadRepos\n'+s.slice(i, i+2600));
