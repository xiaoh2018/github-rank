import fs from 'node:fs';
const s=fs.readFileSync('worker.js','utf8').replace(/\r\n/g,'\n');
const i=s.indexOf('function defaultSite');
console.log(s.slice(i, i+900));
const j=s.indexOf('function normalizeSite');
console.log('\n--- normalize\n'+s.slice(j, j+900));
