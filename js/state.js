// 页面共享状态（ES Module 单例）
export const state = {
  view: 'repos',          // repos | devs | orgs
  range: 'week',
  lang: '',
  cat: '',
  sort: 'stars',          // stars | trend | activity | forks | updated
  q: '',
  page: 1,
  pageSize: 20,
  favOnly: false,
  repos: [],
  trend: {},              // name -> {dStars, dRank, isNew}
  dropped: [],            // 相对上次快照掉出榜的项目
  hasBase: false,         // 是否已经有至少 1 小时前的快照可对比
  users: []
};
