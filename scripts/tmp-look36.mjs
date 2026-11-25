import fs from 'node:fs';
const s=fs.readFileSync('worker.js','utf8').replace(/\r\n/g,'\n');
const i=s.indexOf('function checkSection');
console.log(s.slice(i, i+700));
