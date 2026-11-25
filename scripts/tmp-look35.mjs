import fs from 'node:fs';
const s=fs.readFileSync('worker.js','utf8').replace(/\r\n/g,'\n');
const i=s.indexOf('const lo =');
console.log(s.slice(Math.max(0,i-300), i+900));
