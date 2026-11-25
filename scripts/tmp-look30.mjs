import fs from 'node:fs';
const s=fs.readFileSync('index.html','utf8');
for (const k of ['btnTheme','data-theme','prefers-color-scheme','function renderNav','icw','function applyTheme',':root{','--accent']) console.log(k+' => '+(s.split(k).length-1));
let i=s.indexOf(':root{');console.log('\n--- :root\n'+s.slice(i,i+900));
i=s.indexOf('function renderNav');console.log('\n--- renderNav\n'+s.slice(i,i+1500));
