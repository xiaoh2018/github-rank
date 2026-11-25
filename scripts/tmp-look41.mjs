import fs from 'node:fs';
const s=fs.readFileSync('js/bundle.js','utf8').replace(/\r\n/g,'\n');
let i=s.indexOf('function setRange');console.log('--- setRange\n'+s.slice(i,i+700));
i=s.indexOf('async function load(');console.log('\n--- load()\n'+s.slice(i,i+2200));
i=s.indexOf('function staticRange');console.log('\n--- staticRange\n'+s.slice(i,i+700));
