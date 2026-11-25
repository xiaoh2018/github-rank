import fs from 'node:fs';
const s=fs.readFileSync('worker.js','utf8').replace(/\r\n/g,'\n');
const i=s.indexOf("section === 'layout'");
console.log(s.slice(Math.max(0,i-120), i+700));
