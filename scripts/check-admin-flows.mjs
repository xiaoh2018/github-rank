// 后台「交互流程」端到端门禁：不只是保存按钮，连弹窗里的新增/编辑/删除也要真跑一遍。
// 覆盖：友链（新增 → 编辑 → 删除）、文章分类（新增 → 删除）、导航（新增站点 → 删除）。
// 跑完把 data/*.json 还原。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8123';
const DATA = ['data/site.json', 'data/links.json', 'data/articles.json', 'data/qa.json', 'data/nav.json'];
const snapshot = new Map(DATA.map((f) => [f, fs.readFileSync(f, 'utf8')]));

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9500 + Math.floor(Math.random() * 150);
const dir = 'C:\\Windows\\Temp\\cdpflows' + Date.now();
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); target = l.find((t) => t.type === 'page'); } catch (e) {}
}
if (!target) { console.log('Chrome 起不来，跳过'); process.exit(0); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
const send = (m, p) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return '__ERR__' + (r.result.exceptionDetails.text || '');
  return r.result && r.result.result ? r.result.result.value : null;
};
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok }); console.log((ok ? 'OK    ' : 'FAIL  ') + name + (extra ? '  ' + extra : '')); };

const LINK_COUNT = "document.querySelectorAll('#linkBody [data-edit]').length";
const LAST_LINK_ROW = "Array.prototype.map.call(document.querySelectorAll('#linkBody [data-edit]'), function(b){return b.closest('tr');}).pop()";

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/admin' });
  await sleep(1600);
  await ev("document.getElementById('pw').value='dev'; document.getElementById('loginForm').requestSubmit(); 'ok'");
  await sleep(2000);

  // ---------- 友链：新增 ----------
  await ev("document.querySelector('.nav[data-tab=\"links\"]').click(); 'ok'");
  await sleep(900);
  const before = await ev(LINK_COUNT);
  await ev("document.getElementById('addLinkBtn').click(); 'ok'");
  await sleep(400);
  await ev("document.getElementById('addName').value='流程测试站'; document.getElementById('addUrl').value='https://flow.example.com'; document.getElementById('addDesc').value='门禁用'; 'ok'");
  await ev("document.getElementById('addSubmit').click(); 'ok'");
  await sleep(1800);
  const afterAdd = await ev(LINK_COUNT);
  const addErr = await ev("(document.getElementById('addErr')||{}).textContent || ''");
  check('友链新增', afterAdd === before + 1, `行数 ${before} → ${afterAdd}${addErr ? ' err=' + addErr : ''}`);

  // ---------- 友链：编辑 ----------
  await ev(`(function(){var r=${LAST_LINK_ROW}; if(!r) return 'no row'; r.querySelector('[data-edit]').click(); return 'ok';})()`);
  await sleep(500);
  const titleNow = await ev("(document.getElementById('addTitle')||{}).textContent || ''");
  await ev("document.getElementById('addDesc').value='改过的描述'; 'ok'");
  await ev("document.getElementById('addSubmit').click(); 'ok'");
  await sleep(1800);
  const descNow = await ev(`(function(){var r=${LAST_LINK_ROW}; return r ? r.textContent : '';})()`);
  check('友链编辑', /改过的描述/.test(String(descNow)), `弹窗标题「${titleNow}」`);

  // ---------- 友链：删除 ----------
  await ev(`(function(){var r=${LAST_LINK_ROW}; if(!r) return 'no row'; r.querySelector('[data-del]').click(); return 'ok';})()`);
  await sleep(600);
  await ev("document.getElementById('delSubmit').click(); 'ok'");
  await sleep(1800);
  const afterDel = await ev(LINK_COUNT);
  check('友链删除', afterDel === before, `行数 ${afterAdd} → ${afterDel}（原 ${before}）`);

  // ---------- 分类：新增 + 删除 ----------
  await ev("document.querySelector('.nav[data-tab=\"articles\"]').click(); 'ok'");
  await sleep(900);
  const catBefore = await ev("document.querySelectorAll('#catTbody tr[data-ci]').length");
  await ev("document.getElementById('catAdd').click(); 'ok'");
  await sleep(400);
  await ev(`(function(){
    var rows = document.querySelectorAll('#catTbody tr[data-ci]');
    var last = rows[rows.length - 1];
    if (!last) return 'no row';
    last.querySelector('[data-cf="key"]').value = 'flowtest';
    last.querySelector('[data-cf="name"]').value = '流程测试';
    return 'ok';
  })()`);
  await ev("document.querySelector('#pane-articles [data-save=\"article\"]').click(); 'ok'");
  await sleep(1800);
  const catAfterSave = await ev("document.querySelectorAll('#catTbody tr[data-ci]').length");
  const catErr = await ev("(document.getElementById('errBar')||{}).textContent || ''");
  check('分类新增并保存', catAfterSave === catBefore + 1, `${catBefore} → ${catAfterSave}${catErr ? ' err=' + catErr : ''}`);

  await ev(`(function(){
    var rows = document.querySelectorAll('#catTbody tr[data-ci]');
    var last = rows[rows.length - 1];
    var b = last && last.querySelector('[data-cdel]');
    if (b) b.click();
    return 'ok';
  })()`);
  await sleep(500);
  await ev("document.querySelector('#pane-articles [data-save=\"article\"]').click(); 'ok'");
  await sleep(1800);
  const catAfterDel = await ev("document.querySelectorAll('#catTbody tr[data-ci]').length");
  check('分类删除并保存', catAfterDel === catBefore, `${catAfterSave} → ${catAfterDel}`);

  // ---------- 导航：往第一个分组加一个站点再删掉 ----------
  await ev("document.querySelector('.nav[data-tab=\"nav\"]').click(); 'ok'");
  await sleep(1100);
  const NAV_COUNT = "document.querySelectorAll('#navAdmin tr[data-g]').length";
  const siteBefore = await ev(NAV_COUNT);
  const addBtn = await ev(`(function(){
    var b = document.querySelector('#navAdmin [data-gadd]');
    if (!b) return 'no gadd';
    var g = b.getAttribute('data-gadd');
    b.click();
    return g;
  })()`);
  if (addBtn === 'no gadd') {
    check('导航新增站点', false, '找不到「＋ 站点」按钮');
  } else {
    await sleep(500);
    const filled = await ev(`(function(){
      var rows = document.querySelectorAll('#navAdmin tr[data-g="' + ${JSON.stringify(addBtn)} + '"]');
      var last = rows[rows.length - 1];
      if (!last) return 'no row';
      // 注意：后台是用 input 事件把输入同步进 navState 的，程序化赋值必须手动派发 input，
      // 否则点保存时 navState 里还是旧数据（这一步曾让我误判「导航新增站点存不进去」）。
      var n = last.querySelector('[data-f="name"]');
      var u = last.querySelector('[data-f="url"]');
      if (!n || !u) return 'no inputs';
      n.value = '流程站';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      u.value = 'https://navflow.example.com';
      u.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await ev("document.querySelector('#pane-nav [data-save]').click(); 'ok'");
    await sleep(2000);
    const siteAfter = await ev(NAV_COUNT);
    const navErr = await ev("(document.getElementById('errBar')||{}).textContent || ''");
    check('导航新增站点', siteAfter === siteBefore + 1, `组 ${addBtn} 填行=${filled}，站点 ${siteBefore} → ${siteAfter}${navErr ? ' err=' + navErr : ''}`);

    await ev(`(function(){
      var rows = document.querySelectorAll('#navAdmin tr[data-g="' + ${JSON.stringify(addBtn)} + '"]');
      var last = rows[rows.length - 1];
      var b = last && last.querySelector('[data-idel]');
      if (b) b.click();
      return 'ok';
    })()`);
    await sleep(500);
    await ev("document.querySelector('#pane-nav [data-save]').click(); 'ok'");
    await sleep(2000);
    const siteFinal = await ev(NAV_COUNT);
    check('导航删除站点', siteFinal === siteBefore, `${siteAfter} → ${siteFinal}`);
  }
  // ---------- 文章：新建 → 编辑 → 删除（只碰自己建的那一条）----------
  const ART_TITLE = '__gate__流程文章';
  await ev("document.querySelector('.nav[data-tab=\"articles\"]').click(); 'ok'");
  await sleep(900);
  const ART_COUNT = "document.querySelectorAll('#artTbody [data-artedit]').length";
  const artBefore = await ev(ART_COUNT);

  await ev("document.getElementById('artNew').click(); 'ok'");
  await sleep(600);
  await ev(`(function(){
    document.getElementById('artTitleIn').value = ${JSON.stringify(ART_TITLE)};
    document.getElementById('artSummary').value = '门禁写的一条';
    document.getElementById('artBody').value = '正文第一段。';
    return 'ok';
  })()`);
  await ev("document.getElementById('artSubmit').click(); 'ok'");
  await sleep(2200);
  const artAfterAdd = await ev(ART_COUNT);
  const artErr = await ev("(document.getElementById('artErr')||{}).textContent || ''");
  check('文章新建', artAfterAdd === artBefore + 1, `${artBefore} → ${artAfterAdd}${artErr ? ' err=' + artErr : ''}`);

  // 按标题定位自己那条；找不到就说明保存没生效
  const ART_FIND = "(function(){var rows=document.querySelectorAll('#artTbody tr'); for(var i=0;i<rows.length;i++){ if((rows[i].textContent||'').indexOf(" + JSON.stringify(ART_TITLE) + ") >= 0) return rows[i]; } return null;})()";
  const foundRow = await ev(ART_FIND + " ? 'yes' : 'no'");
  check('新建的文章出现在列表里', foundRow === 'yes');

  await ev(`(function(){var r=${ART_FIND}; if(!r) return 'no row'; var b=r.querySelector('[data-artedit]'); if(b) b.click(); return 'ok';})()`);
  await sleep(700);
  const artDlgTitle = await ev("(document.getElementById('artTitle')||{}).textContent || ''");
  await ev("document.getElementById('artSummary').value='改过的摘要'; 'ok'");
  await ev("document.getElementById('artSubmit').click(); 'ok'");
  await sleep(2200);
  const artAfterEdit = await ev(ART_COUNT);
  const artRowText = await ev(`(function(){var r=${ART_FIND}; return r ? r.textContent : '';})()`);
  check('文章编辑', artAfterEdit === artBefore + 1 && /改过的摘要/.test(String(artRowText)), `弹窗标题「${artDlgTitle}」`);

  await ev(`(function(){var r=${ART_FIND}; if(!r) return 'no row'; var b=r.querySelector('[data-artdel]'); if(b) b.click(); return 'ok';})()`);
  await sleep(700);
  await ev("document.getElementById('delSubmit').click(); 'ok'");
  await sleep(2200);
  const artAfterDel = await ev(ART_COUNT);
  const artGone = await ev(ART_FIND + " ? 'still there' : 'gone'");
  check('文章删除', artAfterDel === artBefore && artGone === 'gone', `${artAfterEdit} → ${artAfterDel}（原 ${artBefore}）`);

  // ---------- 问答：新增一条 → 保存 → 删除 → 保存（按问题文本定位自己那条）----------
  const QA_Q = '__gate__流程测试问题？';
  await ev("document.querySelector('.nav[data-tab=\"qa\"]').click(); 'ok'");
  await sleep(900);
  const QA_COUNT = "document.querySelectorAll('#qaList .qa-row').length";
  const qaBefore = await ev(QA_COUNT);
  await ev("document.getElementById('qaNew').click(); 'ok'");
  await sleep(500);
  const qaFilled = await ev(`(function(){
    var rows = document.querySelectorAll('#qaList .qa-row');
    var last = rows[rows.length - 1];
    if (!last) return 'no row';
    var q = last.querySelector('.qa-q'); var a = last.querySelector('.qa-a'); var g = last.querySelector('.qa-tag');
    if (!q || !a) return 'no inputs';
    q.value = ${JSON.stringify(QA_Q)}; q.dispatchEvent(new Event('input', { bubbles: true }));
    a.value = '流程测试答案。'; a.dispatchEvent(new Event('input', { bubbles: true }));
    if (g) { g.value = '测试'; g.dispatchEvent(new Event('input', { bubbles: true })); }
    return 'ok';
  })()`);
  await ev("document.querySelector('#pane-qa [data-save=\"qa\"]').click(); 'ok'");
  await sleep(2200);
  const qaAfterAdd = await ev(QA_COUNT);
  const qaSaveMsg = await ev("(document.getElementById('qaSaveMsg')||{}).textContent || ''");
  check('问答新增并保存', qaAfterAdd === qaBefore + 1, `填行=${qaFilled}，${qaBefore} → ${qaAfterAdd} · ${qaSaveMsg}`);

  const QA_FIND = "(function(){var rows=document.querySelectorAll('#qaList .qa-row'); for(var i=0;i<rows.length;i++){ var q=rows[i].querySelector('.qa-q'); if(q && (q.value||'').indexOf(" + JSON.stringify(QA_Q) + ") >= 0) return rows[i]; } return null;})()";
  await ev(`(function(){var r=${QA_FIND}; if(!r) return 'no row'; var b=r.querySelector('[data-qadel]'); if(b) b.click(); return 'ok';})()`);
  await sleep(600);
  // 删除是「先确认再删」（§218）：只点删除不会移除，必须点确认框里的删除
  const qaDlgOpen = await ev("!!(document.getElementById('delDlg') && document.getElementById('delDlg').open)");
  await ev("var d=document.getElementById('delSubmit'); if (d) d.click(); 'ok'");
  await sleep(600);
  await ev("document.querySelector('#pane-qa [data-save=\"qa\"]').click(); 'ok'");
  await sleep(2200);
  const qaAfterDel = await ev(QA_COUNT);
  const qaGone = await ev(QA_FIND + " ? 'still there' : 'gone'");
  check('问答删除并保存', qaAfterDel === qaBefore && qaGone === 'gone', `${qaAfterAdd} → ${qaAfterDel}（确认框=${qaDlgOpen}）`);

  // ---------- 密钥显示/隐藏 ----------
  await ev("document.querySelector('.nav[data-tab=\"keys\"]').click(); 'ok'");
  await sleep(900);
  const pwType1 = await ev("(document.getElementById('rtBaiduToken')||{}).type || 'missing'");
  const eyeBtn = await ev("!!document.querySelector('[data-eye=\"rtBaiduToken\"]')");
  if (pwType1 === 'password' && eyeBtn) {
    await ev("document.querySelector('[data-eye=\"rtBaiduToken\"]').click(); 'ok'");
    await sleep(400);
    const pwType2 = await ev("document.getElementById('rtBaiduToken').type");
    await ev("document.querySelector('[data-eye=\"rtBaiduToken\"]').click(); 'ok'");
    await sleep(400);
    const pwType3 = await ev("document.getElementById('rtBaiduToken').type");
    check('密钥显示/隐藏切换', pwType2 === 'text' && pwType3 === 'password', `${pwType1} → ${pwType2} → ${pwType3}`);
  } else {
    check('密钥显示/隐藏切换', false, `type=${pwType1} eye=${eyeBtn}`);
  }

  // ---------- 命令面板 Ctrl+K ----------
  // 只能派发一次：这个快捷键是 toggle，派两次等于开了又关
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); 'ok'");
  await sleep(600);
  const cmdkOpen = await ev("JSON.stringify({open: !!document.getElementById('cmdk') && document.getElementById('cmdk').open === true, items: document.querySelectorAll('#ckList .ck-item').length})");
  const ck = JSON.parse(cmdkOpen);
  await ev("(function(){var i=document.getElementById('ckInput'); if(i){i.value='文章'; i.dispatchEvent(new Event('input',{bubbles:true}));} return 'ok';})()");
  await sleep(500);
  const cmdkFiltered = await ev("document.querySelectorAll('#ckList .ck-item').length");
  await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'ok'");
  await sleep(500);
  const cmdkClosed = await ev("(function(){var e=document.getElementById('cmdk'); return !e || e.open !== true;})()");
  check('命令面板 Ctrl+K', ck.open === true && ck.items > 0, `${ck.items} 项，搜「文章」后 ${cmdkFiltered} 项`);
  check('命令面板 Esc 关闭', cmdkClosed === true);

  // ---------- 广告位预览 ----------
  await ev("document.querySelector('.nav[data-tab=\"ad\"]').click(); 'ok'");
  await sleep(900);
  const hasPrevBtn = await ev("document.querySelectorAll('[data-adprev]').length");
  if (hasPrevBtn > 0) {
    // 空槽点预览只会 toast，所以在内存里先填一段（不保存），验证完再清掉
    const seeded = await ev("(function(){var b=document.querySelector('[data-ad-slot][data-ad-field=\"html\"]'); if(!b) return 'no box'; b.value='<b>预览测试</b>'; return 'ok';})()");
    await ev("document.querySelector('[data-adprev]').click(); 'ok'");
    await sleep(700);
    const prevOpen = await ev("(function(){var d=document.getElementById('adPrevDlg'); var body=document.getElementById('adPrevBody'); return JSON.stringify({open: !!d && d.open === true, len: body ? body.innerHTML.length : 0, text: body ? body.textContent.trim().slice(0,20) : ''});})()");
    const pv = JSON.parse(prevOpen);
    await ev("(function(){try{document.getElementById('adPrevDlg').close();}catch(e){} var b=document.querySelector('[data-ad-slot][data-ad-field=\"html\"]'); if(b) b.value=''; return 'ok';})()");
    await sleep(400);
    check('广告位预览弹窗', pv.open === true && pv.len > 0 && /预览测试/.test(String(pv.text)), `填槽=${seeded}，预览区 ${pv.len} 字符「${pv.text}」`);
  } else {
    check('广告位预览弹窗', false, '没有 data-adprev 按钮');
  }

} finally {
  try { await send('Browser.close'); } catch (e) {}
  proc.kill();
  for (const [f, text] of snapshot) fs.writeFileSync(f, text, 'utf8');
}

const bad = results.filter((r) => !r.ok);
console.log('');
if (bad.length) { console.log(bad.length + ' 个流程失败'); process.exit(1); }
console.log('全部交互流程通过（' + results.length + ' 项）');
