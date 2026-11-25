import fs from 'node:fs';
const s=fs.readFileSync('worker.js','utf8').replace(/\r\n/g,'\n');
const i=s.indexOf('const SITE = {');
console.log(s.slice(i, i+700));
const j=s.indexOf("entry[0] === 'index.html'");
console.log('\nidx='+j+' count='+(s.split("entry[0] === 'index.html'").length-1));
const k=s.indexOf("pathname === '/index.html'");
console.log('serve index route idx='+k);
console.log(s.slice(Math.max(0,k-700), k+500));
