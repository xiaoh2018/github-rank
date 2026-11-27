// 安全响应头：CSP / nosniff / XFO / Referrer-Policy / Permissions-Policy / HSTS
// 用法：node scripts/check-headers.mjs

const BASE = (process.env.PROBE_BASE || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const isHttps = BASE.startsWith('https://');
let pass = 0, fail = 0;
const rows = [];
const push = (name, ok, info) => {
  rows.push((ok ? 'OK   ' : 'FAIL ') + name + (info === undefined ? '' : '  → ' + info));
  ok ? pass++ : fail++;
};

const head = async (p) => {
  const r = await fetch(BASE + p, { method: 'GET' });
  return r;
};

const home = await head('/');
const csp = home.headers.get('content-security-policy') || '';
push('首页有 CSP', !!csp, csp.slice(0, 60) + (csp.length > 60 ? '…' : ''));
push("CSP 含 default-src 'self'", /default-src 'self'/.test(csp), '');
push("CSP 含 object-src 'none'", /object-src 'none'/.test(csp), '');
push("CSP 含 base-uri 'self'", /base-uri 'self'/.test(csp), '');
push("CSP 含 frame-ancestors 'self'", /frame-ancestors 'self'/.test(csp), '');
push("CSP 含 form-action 'self'", /form-action 'self'/.test(csp), '');
push('CSP 放行 GitHub API（实时刷新要用）', /connect-src[^;]*api\.github\.com/.test(csp), '');
push('X-Content-Type-Options = nosniff', home.headers.get('x-content-type-options') === 'nosniff', String(home.headers.get('x-content-type-options')));
push('X-Frame-Options = SAMEORIGIN', (home.headers.get('x-frame-options') || '') === 'SAMEORIGIN', String(home.headers.get('x-frame-options')));
push('Referrer-Policy 存在', !!(home.headers.get('referrer-policy') || ''), String(home.headers.get('referrer-policy')));
push('Permissions-Policy 关了摄像头/麦克风/定位', /geolocation=\(\)/.test(home.headers.get('permissions-policy') || '') && /camera=\(\)/.test(home.headers.get('permissions-policy') || ''), String(home.headers.get('permissions-policy')).slice(0, 70));
push('没有泄露 x-powered-by', !home.headers.get('x-powered-by'), String(home.headers.get('x-powered-by')));

if (isHttps) {
  push('https 下有 HSTS', /max-age=31536000/.test(home.headers.get('strict-transport-security') || ''), String(home.headers.get('strict-transport-security')));
} else {
  push('http 下不加 HSTS（否则本地会被强制跳 https）', !home.headers.get('strict-transport-security'), String(home.headers.get('strict-transport-security')));
}

const api = await head('/api/site');
push('/api/* 也是 nosniff', api.headers.get('x-content-type-options') === 'nosniff', String(api.headers.get('x-content-type-options')));
push('/api/* 是 JSON', /application\/json/.test(api.headers.get('content-type') || ''), String(api.headers.get('content-type')));

const admin = await head('/admin');
push('/admin 有 CSP 与 XFO', !!(admin.headers.get('content-security-policy') && admin.headers.get('x-frame-options')), admin.status + '');

const js = await head('/js/bundle.js');
push('/js/*.js 有 nosniff', js.headers.get('x-content-type-options') === 'nosniff', js.status + '');

const sm = await head('/sitemap.xml');
push('/sitemap.xml 有 nosniff', sm.headers.get('x-content-type-options') === 'nosniff', sm.status + '');

const nf = await head('/this-path-does-not-exist-xyz');
push('404 页也带安全头', nf.status === 404 && nf.headers.get('x-content-type-options') === 'nosniff' && !!nf.headers.get('x-frame-options'), nf.status + ' ' + String(nf.headers.get('x-frame-options')));

console.log(rows.join('\n'));
console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL OK (' + pass + ')') + '  @' + BASE);
process.exit(fail ? 1 : 0);
