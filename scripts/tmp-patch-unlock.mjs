import fs from 'node:fs';

// 1) worker.js：补 #artUnlockHint 卡片 + 回填
{
  const p = 'worker.js';
  const raw = fs.readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  let s = raw.replace(/\r\n/g, '\n');
  const ops = [];

  ops.push({
    label: 'artUnlockHint-card',
    find: `        <div class="hint">中文分类仍会保存在文章数据里，只是不进网址；打开这个开关后，列表和文章页上的分类标签显示成 slug 里的英文词。</div>
      </div>`,
    repl: `        <div class="hint">中文分类仍会保存在文章数据里，只是不进网址；打开这个开关后，列表和文章页上的分类标签显示成 slug 里的英文词。</div>
      </div>
      <div class="card">
        <div class="card-head"><b>加密文章提示语</b><span class="msg">读者点开加密文章时看到的一句说明</span></div>
        <textarea id="artUnlockHint" maxlength="300" placeholder="例如：本文是内部笔记，密码在群里发；需要全文请在页面底部联系我。"></textarea>
        <div class="hint">留空则使用默认文案「这篇文章需要密码才能阅读…」。单篇文章也可以在写作弹窗里单独填，优先用单篇的。</div>
      </div>`,
  });

  ops.push({
    label: 'artUnlockHint-fill',
    find: `      if ($('artCatEn')) $('artCatEn').checked = !!(s && s.article && s.article.catEn);`,
    repl: `      if ($('artCatEn')) $('artCatEn').checked = !!(s && s.article && s.article.catEn);
      if ($('artUnlockHint')) $('artUnlockHint').value = (s && s.article && s.article.unlockHint) || '';`,
  });

  for (const o of ops) {
    const n = s.split(o.find).length - 1;
    if (n !== 1) {
      console.log('FAIL ' + o.label + ' matched ' + n);
      process.exit(1);
    }
    s = s.replace(o.find, o.repl);
  }
  fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
  console.log('worker.js patched ' + ops.length);
}

// 2) check-admin-refs.mjs：跳过属性/类选择器，避免误报
{
  const p = 'scripts/check-admin-refs.mjs';
  let s = fs.readFileSync(p, 'utf8');
  if (!s.includes("const isPlainId")) {
    s = s.replace(
      `for (const m of page.matchAll(/\\$\\('([^']+)'\\)/g)) {
  const id = m[1];`,
      `const isPlainId = (x) => /^[A-Za-z][\\w-]*$/.test(x);
for (const m of page.matchAll(/\\$\\('([^']+)'\\)/g)) {
  const id = m[1];
  if (!isPlainId(id)) continue;`
    );
    s = s.replace(
      `for (const m of page.matchAll(/getElementById\\('([^']+)'\\)/g)) {
  const id = m[1];`,
      `for (const m of page.matchAll(/getElementById\\('([^']+)'\\)/g)) {
  const id = m[1];
  if (!isPlainId(id)) continue;`
    );
    fs.writeFileSync(p, s, 'utf8');
    console.log('check-admin-refs patched');
  }
}
