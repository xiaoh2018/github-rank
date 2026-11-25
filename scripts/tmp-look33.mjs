import fs from 'node:fs';
const b=fs.readFileSync('js/bundle.js','utf8');
let i=b.indexOf('btnSettings');console.log('--- bundle btnSettings\n'+b.slice(Math.max(0,i-400),i+500));
const h=fs.readFileSync('index.html','utf8');
for (const k of ['id="setDlg"','settings','<dialog','id="aboutDialog"','id="setModal"']) console.log('html '+k+' => '+(h.split(k).length-1));
i=h.indexOf('<dialog');console.log('\n--- first dialog\n'+h.slice(i,i+600));
