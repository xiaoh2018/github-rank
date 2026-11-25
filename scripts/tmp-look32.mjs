import fs from 'node:fs';
for (const f of ['index.html','js/bundle.js','articles.html']) {
  const s=fs.readFileSync(f,'utf8');
  console.log('\n===== '+f+' bytes='+s.length);
  for (const k of ['btnTheme','data-theme','localStorage','theme','btnSettings','dialog']) console.log('  '+k+' => '+(s.split(k).length-1));
}
const s=fs.readFileSync('js/bundle.js','utf8');
let i=s.indexOf('btnTheme');console.log('\n--- bundle btnTheme\n'+s.slice(Math.max(0,i-800),i+700));
