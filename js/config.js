// 常量与分类规则（ES Module）
export const RANGES = {
  week: { days: 7 },
  month: { days: 30 },
  year: { days: 365 },
  all: { days: 0 }
};

export const LANGS = ['JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'C++', 'C', 'C#', 'PHP', 'Ruby', 'Swift', 'Kotlin', 'Dart', 'Shell'];

export const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Go: '#00ADD8', Rust: '#dea584',
  Java: '#b07219', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600', PHP: '#4F5D95',
  Ruby: '#701516', Swift: '#F05138', Kotlin: '#A97BFF', Dart: '#00B4AB', Shell: '#89e051'
};

// 分类在已拉取的项目里按 topics / 描述关键词过滤（GitHub 搜索不支持 OR 分组）
export const CATS = [
  { id: '', label: '全部' },
  { id: 'ai', label: 'AI / LLM', topics: ['ai', 'llm', 'machine-learning', 'deep-learning', 'gpt', 'agents', 'ai-agents', 'openai', 'claude', 'diffusion'], kw: ['ai', 'llm', 'gpt', 'neural', 'model'] },
  { id: 'tools', label: '工具 / 效率', topics: ['cli', 'tools', 'automation', 'productivity', 'utility'], kw: ['tool', 'cli', '自动化', '效率'] },
  { id: 'frontend', label: '前端 / Web', topics: ['frontend', 'react', 'vue', 'web', 'css', 'nextjs', 'typescript'], kw: ['web', '前端', 'react', 'vue'] },
  { id: 'devtools', label: '开发工具', topics: ['developer-tools', 'devtools', 'ide', 'editor', 'debugger'], kw: ['developer', 'ide', '编辑器'] },
  { id: 'security', label: '安全', topics: ['security', 'pentest', 'vulnerability', 'cve', 'privacy'], kw: ['security', '安全', '隐私'] },
  { id: 'data', label: '数据 / 后端', topics: ['database', 'sql', 'backend', 'api', 'server'], kw: ['database', '数据库', 'api', '后端'] },
  { id: 'game', label: '游戏', topics: ['game', 'gamedev', 'game-engine', 'games'], kw: ['game', '游戏'] },
  { id: 'learn', label: '学习资源', topics: ['awesome', 'tutorial', 'learning', 'interview', 'course'], kw: ['tutorial', '教程', '学习'] }
];

export function matchCat(r, cat) {
  if (!cat || !cat.topics) return true;
  const topics = new Set(r.topics || []);
  if (cat.topics.some(t => topics.has(t))) return true;
  const desc = (r.desc || '').toLowerCase();
  return cat.kw.some(k => desc.includes(k));
}
