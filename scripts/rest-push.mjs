import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = 'xiaoh2018/github-rank';
const API = 'https://api.github.com';

function git(args, opts = {}) {
  return execFileSync('git', args, { maxBuffer: 512 * 1024 * 1024, ...opts });
}
function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.startsWith('password='));
  if (!line) throw new Error('no token');
  return line.slice('password='.length).trim();
}
const TOKEN = token();
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: 'Bearer ' + TOKEN,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'ghrank-rest-push',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(method + ' ' + path + ' -> ' + res.status + ' ' + text.slice(0, 200));
  return json;
}

const commit = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const parent = git(['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
const message = git(['log', '-1', '--format=%B', 'HEAD'], { encoding: 'utf8' });
const meta = git(['log', '-1', '--format=%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI', 'HEAD'], { encoding: 'utf8' }).trim().split('\x1f');
const [an, ae, ad, cn, ce, cd] = meta;

const ref = await api('GET', `/repos/${REPO}/git/ref/heads/main`);
const remoteHead = ref.object.sha;
console.log('local', commit.slice(0, 7), 'remote', remoteHead.slice(0, 7));
if (remoteHead === commit) { console.log('already up to date'); process.exit(0); }

const remoteCommit = await api('GET', `/repos/${REPO}/git/commits/${remoteHead}`);
const baseTree = remoteCommit.tree.sha;

const diff = git(['-c', 'core.quotepath=false', 'diff-tree', '-r', '--no-commit-id', '--name-status', '-M', commit], { encoding: 'utf8' });
const entries = [];
for (const line of diff.split('\n')) {
  if (!line.trim()) continue;
  const parts = line.split('\t');
  const status = parts[0][0];
  const path = parts[1];
  if (status === 'D') { entries.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
  const buf = git(['show', `${commit}:${path}`], { maxBuffer: 512 * 1024 * 1024 });
  const blob = await api('POST', `/repos/${REPO}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
  entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  console.log('blob', path, blob.sha.slice(0, 7));
}
const tree = await api('POST', `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree: entries });
console.log('tree', tree.sha.slice(0, 7));
const newCommit = await api('POST', `/repos/${REPO}/git/commits`, {
  message,
  tree: tree.sha,
  parents: [remoteHead],
  author: { name: an, email: ae, date: ad },
  committer: { name: cn, email: ce, date: cd },
});
console.log('commit', newCommit.sha.slice(0, 7));
await api('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: newCommit.sha, force: false });
console.log('PUSHED', newCommit.sha);
