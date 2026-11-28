// 定时自查不能只是「给你一段 YAML 自己贴」：仓库里必须有那件事本身。
// 这个门禁只读文件 + 读后台 HTML，不联网、不发请求。
import fs from 'node:fs';

const rows = [];
const push = (label, ok, detail) => rows.push({ label, ok: !!ok, detail });

const WF = '.github/workflows/index-check.yml';
const exists = fs.existsSync(WF);
push('仓库里有 .github/workflows/index-check.yml', exists, WF);
const wf = exists ? fs.readFileSync(WF, 'utf8') : '';

push('每天定时跑（cron: 0 1 * * *，即北京 09:00）', /cron:\s*["']?0 1 \* \* \*["']?/.test(wf), (wf.match(/cron:[^\n]*/) || [''])[0].trim());
push('也能手动触发（workflow_dispatch）', /workflow_dispatch:/.test(wf), '');
push('用的是仓库 secret INDEX_CRON_TOKEN', /secrets\.INDEX_CRON_TOKEN/.test(wf), '');
push('真的调用 /api/index-cron', /\/api\/index-cron/.test(wf), '');
push('没配 secret 时跳过（不是每跑必红）', /::warning::/.test(wf) && /has=0/.test(wf), '');
push('真跑的那步带条件（has == 1）', /if:\s*steps\.tok\.outputs\.has\s*==\s*'1'/.test(wf), '');
push('失败时给出可操作提示（HTTP 码 / 令牌被重新生成）', /::error::/.test(wf) && /403/.test(wf), '');
push('token 走 env 而不是拼进 URL 明文', /env:\s*\n\s*TOKEN:\s*\$\{\{\s*secrets\.INDEX_CRON_TOKEN\s*\}\}/.test(wf), '');

// 后台要指向这个文件，而不是让用户从零粘贴
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8123';
const html = await (await fetch(BASE + '/admin')).text();
push('后台提到这个文件（.github/workflows/index-check.yml）', /\.github\/workflows\/index-check\.yml/.test(html), 'len=' + html.length);
push('后台说清「配一个 secret 就行」', /INDEX_CRON_TOKEN/.test(html) && /Settings/.test(html), '');
push('后台保留了「自己另写一份」的参考片段', /workflow_dispatch:/.test(html) && /\/api\/index-cron/.test(html), '');

const failed = rows.filter((r) => !r.ok);
for (const r of rows) console.log((r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.detail ? '  → ' + r.detail : ''));
if (failed.length) {
  console.log('\n' + failed.length + ' FAILED of ' + rows.length);
  process.exit(1);
}
console.log('\nALL OK (' + rows.length + ')  @' + BASE);