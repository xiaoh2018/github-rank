import fs from 'node:fs';
const p='scripts/patch-theme-a.mjs';
let s=fs.readFileSync(p,'utf8');
const oldOp = s.slice(s.indexOf("  ['normalize-theme'"), s.indexOf("  ['check-theme'"));
const newOp = `  ['normalize-theme', \`  const lo = o && typeof o.layout === 'object' && o.layout ? o.layout : {};\`,
\`  const lo = o && typeof o.layout === 'object' && o.layout ? o.layout : {};
  const th = o && typeof o.theme === 'object' && o.theme ? o.theme : {};
  d.theme = {
    name: THEMES.indexOf(String(th.name || '')) >= 0 ? String(th.name) : 'paper',
    allowUser: th.allowUser !== false
  };\`],

`;
s = s.replace(oldOp, newOp);
fs.writeFileSync(p,s,'utf8');
console.log('op replaced');
