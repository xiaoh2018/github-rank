import fs from 'node:fs';
const s=fs.readFileSync('sw.js','utf8');
const m=s.match(/ghrank-shell-v(\d+)/); const n='ghrank-shell-v'+(Number(m[1])+1);
fs.writeFileSync('sw.js', s.replace(m[0],n),'utf8');
console.log('sw '+m[0]+' -> '+n);
fs.appendFileSync('docs/操作手册.md', `

## 补充：前端资源版本化（2026-11-25）

前端「点了没反应 / 数据不刷新」多半不是数据坏了，而是浏览器抱着一周前的 \`js/bundle.js\`。现在 Worker 在输出 HTML 时会给 \`/js/*.js\` 自动加 \`?v=<ASSET_V>\`：

- 带 \`?v=\` 的响应是 \`max-age=31536000, immutable\`（一年，永不重验证），首屏更快；
- **改前端时要把 \`worker.js\` 里的 \`ASSET_V\` 加一**（例如 v48 → v49），否则老访客会继续用旧 JS；
- 未带版本的 shell 文件浏览器缓存从 7 天收到 5 分钟，防止再出现这种「代码更新了但页面没换」。
`, 'utf8');
