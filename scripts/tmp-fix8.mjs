import fs from 'node:fs';
const p='scripts/patch-theme-a.mjs';
let s=fs.readFileSync(p,'utf8');
s=s.replace("  ['check-theme', `  if (name === 'layout') {`,","  ['check-theme', `  if (section === 'layout') {`,");
s=s.replace("`  if (name === 'theme') {","`  if (section === 'theme') {");
fs.writeFileSync(p,s,'utf8');
console.log(s.includes("if (section === 'theme')") ? 'ok' : 'bad');
