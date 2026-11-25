import fs from 'node:fs';
const s=fs.readFileSync('index.html','utf8');
const i=s.indexOf('id="btnTheme"');
console.log('--- head-actions\n'+s.slice(Math.max(0,i-700), i+300));
const j=s.indexOf('<dialog id="settingsDlg"');
console.log('\n--- settings dialog start\n'+(j>=0? s.slice(j, j+1400) : 'NOT FOUND'));
for (const k of ['settingsDlg','id="setLang"','#btnLang','dialog id="aboutDlg']) console.log(k+' => '+(s.split(k).length-1));
