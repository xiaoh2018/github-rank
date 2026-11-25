import fs from 'node:fs';
const s=fs.readFileSync('worker.js','utf8').replace(/\r\n/g,'\n');
for (const k of ["layout-mode","FIELDS","pickIcon","articleHero","theme"]) {
  const n=s.split(k).length-1; console.log(k+' => '+n);
}
let i=s.indexOf('layout-mode');console.log('\n'+s.slice(Math.max(0,i-300),i+200));
i=s.indexOf('var FIELDS');console.log('\n--- FIELDS\n'+s.slice(i,i+700));
i=s.indexOf('pickIcon(');console.log('\n--- pickIcon use\n'+s.slice(Math.max(0,i-300),i+400));
