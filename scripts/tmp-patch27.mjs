import fs from 'node:fs';

const file = 'worker.js';
let raw = fs.readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n');

const css =
  '/* 导航表格：固定列宽、单行省略、按钮显式 */\n' +
  '#navAdmin table{table-layout:fixed;width:100%}\n' +
  '#navAdmin td:nth-child(1){width:17%}\n' +
  '#navAdmin td:nth-child(2){width:27%}\n' +
  '#navAdmin td:nth-child(3){width:22%}\n' +
  '#navAdmin td:nth-child(4){width:22%}\n' +
  '#navAdmin td:nth-child(5){width:12%;white-space:nowrap}\n' +
  '#navAdmin td{padding:6px;vertical-align:middle}\n' +
  '#navAdmin td input{width:100%;min-width:0;text-overflow:ellipsis}\n' +
  '#navAdmin td input:focus{text-overflow:clip}\n' +
  '#navAdmin button[data-ifetch]{white-space:nowrap;font-size:12px;padding:3px 9px;border:1px solid var(--line);background:#fff;color:#4f46e5;font-weight:600;border-radius:8px;cursor:pointer}\n' +
  '#navAdmin button[data-ifetch]:hover{border-color:#4f46e5;background:#eef2ff}\n' +
  '.toolbar #navFilter{flex:1 1 320px;min-width:0;max-width:none}\n' +
  '.toolbar .note{margin-left:auto}\n';

const anchor = '\n</style>\n</head>';
const n = src.split(anchor).length - 1;
if (n !== 1) throw new Error('style anchor matched ' + n);
src = src.replace(anchor, '\n' + css + '</style>\n</head>');

fs.writeFileSync(file, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('nav css patched');
