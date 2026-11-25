import fs from 'node:fs';
import { createRequire } from 'node:module';
const s=fs.readFileSync('worker.js','utf8').replace(/\r\n/g,'\n');
const checks = [
 '    <button type="button" class="nav" data-tab="articles">文章<span class="nav-badge" id="navArtCount" hidden>0</span></button>',
 "  var TABS = ['overview', 'layout', 'articles', 'nav', 'seo', 'links', 'ad', 'contact', 'beian', 'submit', 'keys', 'translate'];",
 "function askConfirm(title, note, fn) {",
 "    picked['layout-mode'] = lay.mode || 'auto';",
 "    layout: ['mode', 'side', 'users'],",
 "const icon = pickIcon(html, u);",
 "<section class=\"pane\" id=\"pane-articles\"",
];
for (const c of checks) console.log((s.split(c).length-1)+'  <= '+c.slice(0,60));
