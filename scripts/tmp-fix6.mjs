import fs from 'node:fs';
const p='scripts/patch-theme-a.mjs';
let s=fs.readFileSync(p,'utf8');
s=s.replace("['default-theme', `    layout: { mode: 'auto', side: 'right', users: 'auto' },`,\n`    layout: { mode: 'auto', side: 'right', users: 'auto' },\n    theme: { name: 'paper', allowUser: true },`],",
"['default-theme', `    layout: { mode: 'auto', side: 'right', users: 'auto', articleSide: 'right' },`,\n`    layout: { mode: 'auto', side: 'right', users: 'auto', articleSide: 'right' },\n    theme: { name: 'paper', allowUser: true },`],");
s=s.replace("  d.layout.mode = ['auto','single','double','triple'].indexOf(lo.mode) >= 0 ? lo.mode : 'auto';`.slice","  d.layout.mode = ['auto','single','double','triple'].indexOf(lo.mode) >= 0 ? lo.mode : 'auto';`");
fs.writeFileSync(p,s,'utf8');
console.log('patch script updated');
