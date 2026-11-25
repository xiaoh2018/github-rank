import fs from 'node:fs';
const w=fs.readFileSync('worker.js','utf8');
console.log('ASSET_V => '+(w.split('ASSET_V').length-1));
const i=w.indexOf('async function serveSite(');
console.log('\n--- serveSite\n'+w.slice(i,i+1200));
const s=fs.readFileSync('sw.js','utf8');
console.log('\n--- sw.js\n'+s.slice(0,2200));
