import fs from 'node:fs';
const doc='docs/优化建议.md'; const p=process.argv[2];
const sec=fs.readFileSync(p,'utf8'); const s=fs.readFileSync(doc,'utf8');
fs.writeFileSync(doc, s.replace(/\s*$/,'\n')+'\n'+sec.trim()+'\n','utf8'); fs.unlinkSync(p); console.log('appended', p);
