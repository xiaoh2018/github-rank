import fs from 'node:fs';
const p='scripts/patch-theme-a.mjs';
let s=fs.readFileSync(p,'utf8');
s=s.replace("  ['css-theme', `.lockrow{`, themeCss + `.lockrow{`],","  ['css-theme', `::-webkit-scrollbar-thumb{background:#d6d3cc;`, themeCss + `::-webkit-scrollbar-thumb{background:#d6d3cc;`],");
fs.writeFileSync(p,s,'utf8');
console.log('ok');
