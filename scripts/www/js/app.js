/* =====================================================================
 * app.js —— 应用主逻辑：哈希路由、视图渲染、刷题交互
 *
 * 路由：
 *   #/home                 首页（考点卡片列表，按复习优先级排序）
 *   #/card/<考点名称>       考点卡片详情
 *   #/quiz                 刷题页（内容由当前 session 决定）
 *   #/mixed                综合刷题（所有题目随机）
 *   #/wrong                错题本（错题 + 统计；可切疑难标记）
 *   #/marked               疑难标记（错题本页直接切到疑难标签）
 *   #/import               批量导入（题目/卡片/JSON备份/考点管理）
 *   #/reading…             阅读理解（独立书架 → 单元 → 挖空文章，见 reading.js）
 * =================================================================== */

(function () {
  'use strict';

  const APP_VERSION = 'v6.2（2026-10-01）';

  const appEl = document.getElementById('app');
  const wrongBadge = document.getElementById('wrongBadge');
  const toastEl = document.getElementById('toast');
  let toastTimer = null;

  /**
   * 当前刷题会话
   * item: { q, perm, displayAnswer, chosen, correct, ms, uncertain }
   */
  let session = null;

  /** 错题本页标签：wrong / marked */
  let wrongPageTab = 'wrong';

  /** 书架页当前展开的书籍 id（null = 全部折叠） */
  let shelfExpanded = null;

  /** 导入页状态（bookId/chapterId 为题目与卡片导入的归属，'' 表示未分类） */
  const importState = {
    tab: 'question', text: '', preview: null, message: '', quickText: '',
    bookId: '', chapterId: ''
  };

  /* ================= 通用工具 ================= */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1900);
  }

  /* ---------- 选项语法卡片小浮层（导入预览 / 刷题页共用，按名称精确查找） ---------- */
  let cardPopEl = null;
  function closeCardPop() {
    if (cardPopEl) { cardPopEl.remove(); cardPopEl = null; }
  }
  /** 按卡片名精确打开小浮层；找不到卡只提示不报错。样式复用文章精读 .hl-pop */
  function openCardPop(name, x, y) {
    closeCardPop();
    const card = name ? Store.getCardByName(name) : null;
    if (!card) { toast('题库暂无此语法点卡片'); return; }
    cardPopEl = document.createElement('div');
    cardPopEl.className = 'hl-pop';
    cardPopEl.innerHTML =
      '<div class="hp-name">' + esc(card.name) + '</div>' +
      (card.category ? '<div class="hp-cat">' + esc(card.category) + '</div>' : '') +
      '<div class="hp-sum">' + esc(card.summary || '（这张卡片还没有摘要）') + '</div>' +
      '<a class="hp-link" href="#/card/' + encodeURIComponent(card.name) + '">查看完整卡片 ›</a>';
    document.body.appendChild(cardPopEl);
    const w = cardPopEl.offsetWidth, ht = cardPopEl.offsetHeight;
    let left = Math.min(Math.max(8, (x || window.innerWidth / 2) - w / 2),
      window.innerWidth - w - 8);
    let top = (y == null ? 120 : y) - ht - 12;
    if (top < 8) top = (y == null ? 120 : y) + 16;
    cardPopEl.style.left = left + 'px';
    cardPopEl.style.top = top + 'px';
  }
  /* 点击浮层外部关闭（点击打开浮层的那一下不在此处理） */
  document.addEventListener('click', function (e) {
    if (!cardPopEl) return;
    if (e.target.closest &&
      (e.target.closest('.hl-pop') ||
        e.target.closest('[data-action="preview-card"]') ||
        e.target.closest('[data-action="quiz-opt-card"]'))) return;
    closeCardPop();
  });

  function setHTML(html) {
    appEl.innerHTML = html;
    window.scrollTo(0, 0);
  }

  function fmtDuration(ms) {
    if (ms == null) return '—';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + ' 秒';
    const m = Math.floor(s / 60);
    return m + ' 分 ' + Math.round(s % 60) + ' 秒';
  }

  /** 剪贴板复制（带 execCommand 降级，兼容非安全上下文） */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-99px;left:-99px;opacity:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { }
      ta.remove();
      ok ? resolve() : reject(new Error('复制失败'));
    });
  }

  /** 触发浏览器下载 */
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ================= 优先级与复习提醒 ================= */

  function daysSince(ts) {
    if (!ts) return null;
    return (Date.now() - ts) / 86400000;
  }

  /** 复习优先级：错误率为主，久未复习加权 */
  function priorityOf(card) {
    const m = Store.getPointMetaOf(card.name);
    const rate = m.attempts ? m.wrongs / m.attempts : 0;
    const d = daysSince(m.lastPractice);
    const stale = d == null ? 0 : Math.min(d, 14) * 0.6;
    return rate * 10 + stale + (d == null ? 0.05 : 0);
  }

  /** 艾宾浩斯提醒：>1 / >3 / >7 天 */
  function dueBadgeOf(card) {
    const m = Store.getPointMetaOf(card.name);
    const d = daysSince(m.lastPractice);
    if (d == null) return '';
    if (d >= 7) return '<span class="badge due-7">7天+未复习</span>';
    if (d >= 3) return '<span class="badge due-3">3天未复习</span>';
    if (d >= 1) return '<span class="badge due-1">该复习了</span>';
    return '';
  }

  /* ================= 会话构建 ================= */

  function makeItems(qs) {
    return qs.map(q => {
      const perm = shuffle(['A', 'B', 'C', 'D']);
      return {
        q,
        perm,
        displayAnswer: perm.indexOf(q.answer),
        chosen: null,
        correct: false,
        ms: null,
        uncertain: false
      };
    });
  }

  /** 学习/训练模式偏好（学习模式随时可点选项查卡；训练模式作答后才可查） */
  function getLearnMode() {
    try { return localStorage.getItem('jp_learn_mode') === 'train' ? 'train' : 'learn'; }
    catch (e) { return 'learn'; }
  }
  function setLearnModePref(mode) {
    try { localStorage.setItem('jp_learn_mode', mode); } catch (e) { }
  }

  function startSession(mode, title, qs, pointName, articleId, sourceBookId) {
    if (!qs.length) {
      toast(mode === 'marked' ? '疑难队列是空的' : '没有可用的题目');
      return;
    }
    session = {
      mode, title, pointName: pointName || '', articleId: articleId || '',
      sourceBookId: sourceBookId || '',
      items: makeItems(shuffle(qs)),
      index: 0,
      feedback: 'instant',   // instant | exam
      learnMode: getLearnMode(), // learn（随时查选项卡） | train（作答后才能查）
      finished: false,
      reviewing: false,
      qStart: Date.now()
    };
    if (location.hash !== '#/quiz') location.hash = '#/quiz';
    else renderQuiz();
  }

  /**
   * 按来源（书）过滤题目。
   * bookId：''/undefined=全部不过滤；'none'=只看未分类；其他=指定书 id
   */
  function filterBySource(list, bookId) {
    if (!bookId || bookId === 'all') return list;
    if (bookId === 'none') return list.filter(q => !q.bookId);
    return list.filter(q => (q.bookId || '') === bookId);
  }

  function startPoint(name, bookId) {
    const all = Store.getQuestions().filter(q => q.point === name);
    const qs = filterBySource(all, bookId);
    const label = sourceFilterLabel(bookId);
    startSession('point', label ? name + '（' + label + '）' : name,
      qs, name, '', bookId || '');
  }

  /** 综合练习随机：只练已归入语法练习书章节的题目（不碰未分类题） */
  function startMixed() {
    const qs = Store.getQuestions().filter(q => !q.reading && q.bookId);
    if (!qs.length) {
      toast('还没有练习书题目，先到「批量导入」导入语法书题目');
      location.hash = '#/import';
      return;
    }
    startSession('mixed', '综合练习 · 随机', qs);
  }

  function startWrongPractice(bookId) {
    const label = sourceFilterLabel(bookId);
    const qs = filterBySource(Store.getWrongQuestions(), bookId);
    startSession('wrong', label ? '错题重练（' + label + '）' : '错题重练',
      qs, '', '', bookId || '');
    if (!Store.getWrongQuestions().length) location.hash = '#/wrong';
  }

  function startMarkedPractice(bookId) {
    const label = sourceFilterLabel(bookId);
    const qs = filterBySource(Store.getMarkedQuestions(), bookId);
    startSession('marked', label ? '疑难重练（' + label + '）' : '疑难重练',
      qs, '', '', bookId || '');
    if (!Store.getMarkedQuestions().length) location.hash = '#/marked';
  }

  /** 相似题专练：同一考点的其他题目（最多 8 道） */
  function startSimilar(point, excludeId) {
    const qs = Store.getQuestions()
      .filter(q => q.point === point && q.id !== excludeId)
      .slice(0, 8);
    if (!qs.length) {
      toast('该考点暂无其他相似题目');
      return;
    }
    startSession('similar', '相似题 · ' + point, qs, point);
  }

  function restartSession() {
    if (!session) return location.hash = '#/home';
    const src = session.sourceBookId || '';
    ({
      point: () => startPoint(session.pointName, src),
      mixed: startMixed,
      wrong: () => startWrongPractice(src),
      marked: () => startMarkedPractice(src),
      similar: () => startSimilar(session.pointName, ''),
      article: () => startSession('article', session.title,
        session.items.map(it => it.q), '', session.articleId),
      chapter: () => startChapter(session.bookId || '', session.chapterId || '')
    })[session.mode]();
  }

  /* ================= 答题处理 ================= */

  function answerCurrent(displayIdx) {
    if (!session || session.finished) return;
    const s = session;
    const it = s.items[s.index];
    if (it.chosen !== null) return;

    it.chosen = displayIdx;
    it.correct = displayIdx === it.displayAnswer;
    it.ms = Date.now() - s.qStart;

    const qid = it.q.id;
    if (it.uncertain) Store.addMarked(qid);
    if (!it.correct) {
      Store.addWrong(qid);
    } else {
      if (s.mode === 'wrong') Store.removeWrong(qid);
      if (s.mode === 'marked' && !it.uncertain) Store.removeMarked(qid);
    }
    renderQuiz();
  }

  function toggleUncertain() {
    if (!session || session.finished) return;
    const it = session.items[session.index];
    if (it.chosen !== null) return;
    it.uncertain = !it.uncertain;
    renderQuiz();
  }

  function setFeedback(mode) {
    if (!session || session.finished) return;
    if (session.items.some(it => it.chosen !== null)) {
      toast('已开始作答，模式无法切换');
      return;
    }
    session.feedback = mode;
    renderQuiz();
  }

  function nextQuestion() {
    if (!session) return;
    if (session.index < session.items.length - 1) {
      session.index++;
      session.qStart = Date.now();
      renderQuiz();
    } else {
      finishSession();
    }
  }

  function finishSession() {
    const s = session;
    s.finished = true;
    // 汇总并落盘
    const agg = {};
    s.items.forEach(it => {
      const n = it.q.point;
      if (!agg[n]) agg[n] = { attempts: 0, wrongs: 0, timeMs: 0 };
      agg[n].attempts++;
      if (!it.correct) agg[n].wrongs++;
      agg[n].timeMs += it.ms || 0;
    });
    Store.recordPractice(agg);
    if (s.mode === 'point') Store.markCompleted(s.pointName);
    renderQuiz();
  }

  /* ================= 视图：首页 ================= */

  /* ================= 首页：薄弱点面板 ================= */

  /** 错满 3 次的考点自动亮出，按错误次数倒序取前 5 */
  function weakPanelHTML() {
    const meta = Store.getPointMeta();
    const weak = Object.keys(meta)
      .filter(name => meta[name].wrongs >= 3)
      .sort((a, b) => meta[b].wrongs - meta[a].wrongs)
      .slice(0, 5);
    if (!weak.length) return '';

    const rows = weak.map(name =>
      '<div class="weak-row">' +
      '<div class="wr-info"><div class="wr-name">' + esc(name) + '</div>' +
      '<div class="wr-sub">已错 ' + meta[name].wrongs + ' 次 · 答题 ' + meta[name].attempts + ' 次</div></div>' +
      '<button class="btn-mini wr-btn" data-action="start-point" data-name="' + esc(name) + '">去刷题</button>' +
      '</div>'
    ).join('');

    return '<div class="section-title weak-title">薄弱点 <span class="count">错满 3 次自动亮出</span></div>' +
      '<div class="weak-panel">' + rows + '</div>';
  }

  function renderHome() {
    const cards = Store.getCards().slice();
    const completed = Store.getCompleted();
    const doneCount = cards.filter(c => completed[c.name]).length;
    const wrongCount = Store.wrongCount();
    const markedCount = Store.markedCount();
    const allQuestions = Store.getQuestions();

    cards.sort((a, b) => priorityOf(b) - priorityOf(a) || a.name.localeCompare(b.name, 'zh'));

    const listHTML = cards.length ? cards.map(c => {
      const done = !!completed[c.name];
      const qc = allQuestions.filter(q => q.point === c.name).length;
      return '<a class="point-card" href="#/card/' + encodeURIComponent(c.name) + '">' +
        '<div class="pc-top">' +
        '<span class="pc-name">' + esc(c.name) + '</span>' +
        '<span class="badge ' + (done ? 'done' : 'todo') + '">' +
        (done ? '✓ 已完成' : '未完成') + '</span>' +
        '</div>' +
        '<div class="pc-summary">' + esc(c.summary) + '</div>' +
        '<div class="pc-meta">' +
        '<span class="badge cat">' + esc(c.category) + '</span>' +
        '<span class="badge todo">' + qc + ' 题</span>' +
        dueBadgeOf(c) +
        '</div>' +
        '</a>';
    }).join('') :
      '<div class="empty"><span class="e-ico">📭</span>' +
      '<div class="e-txt">还没有考点卡片，去导入吧</div>' +
      '<a class="btn btn-primary" href="#/import">去导入</a></div>';

    setHTML(
      '<header class="page-head">' +
      '<h1>日语语法刷题</h1>' +
      '<div class="sub">错得多、久没看的考点自动排前面</div>' +
      '</header>' +

      '<div class="stats">' +
      '<div class="stat-box"><div class="num">' + cards.length + '</div>' +
      '<div class="lbl">考点</div></div>' +
      '<div class="stat-box"><div class="num green">' + doneCount + '</div>' +
      '<div class="lbl">已完成</div></div>' +
      '<div class="stat-box"><div class="num red">' + wrongCount + '</div>' +
      '<div class="lbl">错题</div></div>' +
      '<div class="stat-box"><div class="num pink">' + markedCount + '</div>' +
      '<div class="lbl">疑难</div></div>' +
      '</div>' +

      '<div class="quick-grid">' +
      '<a class="quick-card mixed" href="#/mixed">' +
      '<span class="q-title"><i class="q-dot"></i>综合练习</span>' +
      '<span class="q-desc">按书籍章节练语法书题目 · 点选项看卡片</span></a>' +
      '<a class="quick-card wrong" href="#/wrong">' +
      '<span class="q-title"><i class="q-dot"></i>错题本</span>' +
      '<span class="q-desc">' + wrongCount + ' 道错题待巩固</span></a>' +
      '<a class="quick-card marked" href="#/marked">' +
      '<span class="q-title"><i class="q-dot"></i>疑难标记</span>' +
      '<span class="q-desc">' + markedCount + ' 道蒙对/不确定</span></a>' +
      '<a class="quick-card shelf" href="#/books">' +
      '<span class="q-title"><i class="q-dot"></i>书架</span>' +
      '<span class="q-desc">书籍 · 章节分层浏览</span></a>' +
      '<a class="quick-card reading" href="#/articles">' +
      '<span class="q-title"><i class="q-dot"></i>文章精读</span>' +
      '<span class="q-desc">高亮精读 · AI 出题</span></a>' +
      '<a class="quick-card rc" href="#/reading">' +
      '<span class="q-title"><i class="q-dot"></i>阅读理解</span>' +
      '<span class="q-desc">完形填空 · 一键精读</span></a>' +
      '<a class="quick-card games" href="#/games">' +
      '<span class="q-title"><i class="q-dot"></i>训练场</span>' +
      '<span class="q-desc">Boss 战 · 句子拆弹</span></a>' +
      '<a class="quick-card import" href="#/import">' +
      '<span class="q-title"><i class="q-dot"></i>批量导入</span>' +
      '<span class="q-desc">导入 / 备份 / 管理</span></a>' +
      '</div>' +

      weakPanelHTML() +

      '<div class="section-title">考点列表 <span class="count">按复习优先级排序</span></div>' +
      listHTML
    );
  }

  /* ================= 视图：考点卡片详情 ================= */

  /** 当前打开的卡片名（弹窗回调需要） */
  let currentCardName = '';
  /** 卡片详情页当前选中的来源筛选（'' 全部 / 'none' 未分类 / 书 id） */
  let cardSourceFilter = '';
  /** 新增题目弹窗状态：tab = manual | paste；text 为粘贴原文；parsed 为解析结果 */
  const addQState = { tab: 'manual', text: '', parsed: [] };

  function renderCard(name) {
    currentCardName = name;
    addQState.tab = 'manual';
    addQState.text = '';
    addQState.parsed = [];
    closeModal();

    const card = Store.getCardByName(name);
    if (!card) {
      setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
        '<div class="e-txt">未找到该考点</div>' +
        '<a class="btn btn-primary back-link" href="#/home">‹ 返回</a></div>');
      return;
    }
    const sources = Array.isArray(card.sources) && card.sources.length
      ? card.sources
      : [{
        bookId: '', chapterId: '', summary: card.summary, lecture: card.lecture,
        emphasis: card.emphasis || '', examples: card.examples || []
      }];

    /* 当前来源筛选已不可用（题目被删/移走）时回退全部 */
    const allQuestions = Store.getQuestions().filter(q => q.point === name);
    const validTokens = [''];
    allQuestions.forEach(q => {
      const t = q.bookId || 'none';
      if (validTokens.indexOf(t) === -1) validTokens.push(t);
    });
    if (validTokens.indexOf(cardSourceFilter) === -1) cardSourceFilter = '';
    const questions = filterBySource(allQuestions, cardSourceFilter);
    const qCount = questions.length;
    const done = Store.isCompleted(name);

    /* 来源归属徽章（按 sources 去重） */
    const scopeHTML = Store.cardScopes(card).map(sc => {
      if (!sc.bookId) return '<span class="scope-badge muted">🗂 未分类</span>';
      return '<a class="scope-badge" href="#/chapter/' + scopeToRoute(sc.bookId) + '/' +
        scopeToRoute(sc.chapterId || '') + '">🗂 ' + esc(scopeText(sc.bookId, sc.chapterId)) + '</a>';
    }).join('');

    /* 多来源折叠段 */
    const sourcesHTML = sources.map((s, i) => cardSourceSectionHTML(s, i, sources.length)).join('');

    /* 来源筛选 + 刷题 */
    const pillsHTML = sourcePillsHTML(allQuestions, 'card-src', cardSourceFilter,
      ' data-name="' + esc(name) + '"');
    const filterLabel = sourceFilterLabel(cardSourceFilter);
    const startBtnLabel = qCount
      ? '开始刷题（' + qCount + '题' + (filterLabel ? ' · ' + filterLabel : '') + '）'
      : '暂无题目';

    const qListHTML = qCount
      ? '<div class="section-title">题目列表 <span class="count">共 ' + qCount +
      ' 题 · 点击题目可展开详情</span></div>' +
      questions.map(cardQuestionItemHTML).join('')
      : '<div class="empty"><span class="e-ico">📝</span>' +
      '<div class="e-txt">这个考点' + (filterLabel ? '在「' + filterLabel + '」中' : '下') +
      '还没有题目，点底部按钮新增</div></div>';

    setHTML(
      '<a class="back-link" href="#/home">‹ 返回</a>' +
      '<div class="detail-card">' +
      '<div class="dc-head"><h2>' + esc(card.name) + '</h2>' +
      '<details class="dc-more"><summary aria-label="更多操作">⋯</summary>' +
      '<div class="dcm-menu">' +
      '<button data-action="card-edit">✎ 编辑卡片</button>' +
      '<button data-action="src-add">＋ 添加来源</button>' +
      '<button class="danger" data-action="card-del">删除卡片</button>' +
      '</div></details></div>' +
      '<div class="tags">' +
      '<span class="badge cat">' + esc(card.category) + '</span>' +
      '<span class="badge ' + (done ? 'done' : 'todo') + '">' +
      (done ? '✓ 已完成' : '未完成') + '</span>' +
      '<span class="badge todo">' + allQuestions.length + ' 题</span>' +
      '<span class="badge src-count">📚 ' + sources.length + ' 个来源</span>' +
      dueBadgeOf(card) +
      '</div>' +
      '<div class="dc-scopes">' + scopeHTML + '</div>' +
      sourcesHTML +
      '</div>' +
      pillsHTML +
      '<button class="btn btn-primary" data-action="card-start"' +
      (qCount ? '' : ' disabled') + '>' + esc(startBtnLabel) + '</button>' +
      qListHTML +
      '<div class="btn-row card-manage-bar">' +
      '<button class="btn btn-primary" data-action="q-add">＋ 新增题目</button>' +
      '<button class="btn btn-ghost" data-action="batch-open">批量管理</button>' +
      '</div>'
    );
  }

  /** 卡片详情页中的单个来源折叠段 */
  function cardSourceSectionHTML(s, idx, total) {
    const title = s.bookId
      ? '📖 ' + scopeText(s.bookId, s.chapterId)
      : '📖 未分类来源';
    const examplesHTML = (s.examples && s.examples.length)
      ? s.examples.map(ex =>
        '<div class="example-item"><div class="ex-jp">' + esc(ex.jp) +
        '</div><div class="ex-cn">' + esc(ex.cn) + '</div></div>').join('')
      : '';
    return '<details class="src-item"' + (idx === 0 ? ' open' : '') + '>' +
      '<summary>' +
      '<div class="si-head">' +
      '<span class="si-title">' + esc(title) + '</span>' +
      (idx === 0 ? '<span class="badge done">主来源</span>' : '') +
      '<span class="si-caret">›</span>' +
      '</div>' +
      (s.emphasis ? '<div class="si-emphasis">侧重点：' + esc(s.emphasis) + '</div>' : '') +
      '</summary>' +
      '<div class="si-body">' +
      '<div class="detail-block"><div class="db-title">📌 摘要</div>' +
      '<div class="db-body">' + (esc(s.summary) || '<span class="db-empty">（无摘要）</span>') + '</div></div>' +
      '<div class="detail-block"><div class="db-title">📖 讲解</div>' +
      '<div class="db-body">' + (esc(s.lecture) || '<span class="db-empty">（无讲解）</span>') + '</div></div>' +
      (examplesHTML
        ? '<div class="detail-block"><div class="db-title">💬 例句</div>' + examplesHTML + '</div>'
        : '') +
      (s.emphasis
        ? '<div class="detail-block"><div class="db-title">🎯 本书侧重点</div>' +
        '<div class="db-body">' + esc(s.emphasis) + '</div></div>'
        : '') +
      '<div class="si-btns">' +
      '<button class="btn-mini" data-action="src-edit" data-sid="' + esc(s.id) + '">编辑此来源</button>' +
      (total > 1
        ? '<button class="btn-mini danger" data-action="src-del" data-sid="' +
        esc(s.id) + '">删除此来源</button>'
        : '<span class="fmt-hint" style="margin:0">至少保留一个来源</span>') +
      '</div></div></details>';
  }

  /** 卡片详情页中的单道题（折叠时只露题干，不剧透答案；展开后显示选项/正解/解析） */
  function cardQuestionItemHTML(q) {
    const o = q.options || {};
    const optionsHTML = ['A', 'B', 'C', 'D'].map(k => {
      const isAns = q.answer === k;
      return '<div class="cq-opt' + (isAns ? ' correct' : '') + '">' +
        '<span class="cq-key">' + k + '</span><span>' + esc(o[k] || '') +
        '</span>' + (isAns ? '<span class="cq-ans-tag">正解</span>' : '') + '</div>';
    }).join('');
    return '<details class="cq-item">' +
      '<summary>' +
      '<div class="cq-top">' +
      '<span class="badge diff-' + (q.difficulty || '中') + '">' + esc(q.difficulty || '中') + '</span>' +
      '<span class="badge cat">' + esc(q.type || '单选题') + '</span>' +
      '<span class="badge todo cq-cat">' + esc(q.category || '') + '</span>' +
      sourceBadgeHTML(q.bookId, q.chapterId) +
      '</div>' +
      '<div class="cq-stem">' + esc(q.stem) + '</div>' +
      '<span class="cq-toggle"><span class="ct-closed">展开看选项与解析 ▸</span>' +
      '<span class="ct-open">收起 ▴</span></span>' +
      '</summary>' +
      '<div class="cq-body">' + optionsHTML +
      (q.explanation
        ? '<div class="cq-exp"><div class="cq-exp-title">解析</div>' +
        '<div class="cq-exp-body">' + esc(q.explanation) + '</div></div>'
        : '') +
      '<div class="cq-btns">' +
      '<button class="btn-mini" data-action="q-edit" data-id="' + esc(q.id) + '">编辑</button>' +
      '<button class="btn-mini" data-action="q-move" data-id="' + esc(q.id) + '">移动</button>' +
      '<button class="btn-mini danger" data-action="q-del" data-id="' + esc(q.id) + '">删除</button>' +
      '</div></div></details>';
  }

  /* ---------- 弹窗基础 ---------- */

  let modalEl = null;

  function openModal(title, bodyHTML, footHTML) {
    closeModal();
    modalEl = document.createElement('div');
    modalEl.className = 'modal-mask';
    modalEl.innerHTML =
      '<div class="modal-panel" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><span>' + esc(title) + '</span>' +
      '<button class="modal-x" data-action="modal-close" aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' + bodyHTML + '</div>' +
      (footHTML ? '<div class="modal-foot">' + footHTML + '</div>' : '') +
      '</div>';
    document.body.appendChild(modalEl);
  }

  function closeModal() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
  }

  function modalVal(id) {
    const el = modalEl && modalEl.querySelector('#' + id);
    return el ? el.value : '';
  }

  /** 全部已有考点名（卡片名 + 题目中出现过的 point），供输入联想 */
  function pointDatalistHTML(listId) {
    const set = new Set();
    Store.getCards().forEach(c => c.name && set.add(c.name));
    Store.getQuestions().forEach(q => q.point && set.add(q.point));
    const names = Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
    return '<datalist id="' + listId + '">' +
      names.map(n => '<option value="' + esc(n) + '"></option>').join('') +
      '</datalist>';
  }

  /** 取消/保存按钮 */
  function modalFoot(saveAction, saveLabel, saveAttrs, danger) {
    return '<button class="btn btn-ghost" data-action="modal-close">取消</button>' +
      '<button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') +
      '" data-action="' + saveAction + '"' + (saveAttrs || '') + '>' +
      esc(saveLabel) + '</button>';
  }

  /* ---------- 弹窗：编辑卡片 ---------- */

  function openCardEdit() {
    const card = Store.getCardByName(currentCardName);
    if (!card) return;
    const exText = (card.examples || [])
      .map(e => (e.jp && e.cn) ? (e.jp + ' / ' + e.cn) : (e.jp || '')).join('\n');
    const body =
      '<div class="fmt-hint" style="margin-bottom:10px">此处编辑的是<b>主来源（第一个来源）</b>的内容；' +
      '其他书的讲解请用卡片页的「＋ 来源 / 编辑此来源」单独管理。</div>' +
      '<div class="fld"><label>考点名称</label>' +
      '<input id="cf-name" type="text" value="' + esc(card.name) + '"></div>' +
      '<div class="fld"><label>门类</label>' +
      '<input id="cf-category" type="text" value="' + esc(card.category || '') + '"></div>' +
      '<div class="fld"><label>摘要</label>' +
      '<textarea id="cf-summary" rows="2">' + esc(card.summary || '') + '</textarea></div>' +
      '<div class="fld"><label>讲解</label>' +
      '<textarea id="cf-lecture" rows="5">' + esc(card.lecture || '') + '</textarea></div>' +
      '<div class="fld"><label>侧重点（本书特别强调、与其他书不同之处，可留空）</label>' +
      '<textarea id="cf-emphasis" rows="2">' + esc(card.emphasis || '') + '</textarea></div>' +
      '<div class="fld"><label>例句（每行一句，格式：日文 / 中文）</label>' +
      '<textarea id="cf-examples" rows="4">' + esc(exText) + '</textarea></div>';
    openModal('编辑考点卡片（主来源）', body,
      modalFoot('card-save', '保存', ' data-name="' + esc(card.name) + '"'));
  }

  function saveCardEdit(oldName) {
    const newName = modalVal('cf-name').trim();
    if (!newName) { toast('考点名称不能为空'); return; }
    const examples = modalVal('cf-examples').split(/\r?\n/)
      .map(line => Parser.splitExample(line))
      .filter(ex => ex.jp);
    const patch = {
      name: newName,
      category: modalVal('cf-category').trim() || '自定义',
      summary: modalVal('cf-summary').trim(),
      lecture: modalVal('cf-lecture').trim(),
      emphasis: modalVal('cf-emphasis').trim(),
      examples: examples
    };
    const r = Store.updateCard(oldName, patch);
    if (r && r.error === 'dup') { toast('已存在同名考点，请换个名称'); return; }
    if (r && r.error === 'invalid') { toast('考点名称不能为空'); return; }
    closeModal();
    toast('卡片已保存');
    if (newName !== oldName) {
      currentCardName = newName;
      location.hash = '#/card/' + encodeURIComponent(newName);
    } else {
      renderCard(newName);
    }
  }

  /* ---------- 弹窗：新增 / 编辑来源 ---------- */

  /** 书/章下拉（供来源弹窗与题目表单共用） */
  function sourcePickerHTML(selectIdBook, selectIdChapter, bookId, chapterId) {
    const books = Store.getBooks();
    const book = bookId ? Store.getBookById(bookId) : null;
    const chapters = book && Array.isArray(book.chapters) ? book.chapters : [];
    const bookOpts = '<option value="">未分类（不归入任何书）</option>' +
      books.map(b => '<option value="' + esc(b.id) + '"' +
        (b.id === bookId ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('');
    const chapterOpts = '<option value="">未分章节</option>' +
      chapters.map(c => '<option value="' + esc(c.id) + '"' +
        (c.id === chapterId ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
    return '<div class="fld-row">' +
      '<div class="fld"><label>来源书籍</label>' +
      '<select id="' + selectIdBook + '" class="src-book-select">' + bookOpts + '</select></div>' +
      '<div class="fld"><label>来源章节</label>' +
      '<select id="' + selectIdChapter + '" class="src-chapter-select"' +
      (book ? '' : ' disabled') + '>' + chapterOpts + '</select></div>' +
      '</div>';
  }

  /** 书下拉变化时重建章节下拉（通过 select 的 id 找到配对的章节下拉） */
  function refreshChapterSelect(bookSel) {
    const chSel = modalEl && modalEl.querySelector('.src-chapter-select');
    if (!bookSel || !chSel) return;
    const book = Store.getBookById(bookSel.value);
    const chapters = book && Array.isArray(book.chapters) ? book.chapters : [];
    const prev = chSel.value;
    chSel.innerHTML = '<option value="">未分章节</option>' +
      chapters.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('');
    chSel.disabled = !book;
    if (chapters.some(c => c.id === prev)) chSel.value = prev;
  }

  function sourceFormFields(s) {
    const exText = (s.examples || [])
      .map(e => (e.jp && e.cn) ? (e.jp + ' / ' + e.cn) : (e.jp || '')).join('\n');
    return sourcePickerHTML('sf-book', 'sf-chapter', s.bookId || '', s.chapterId || '') +
      '<div class="fld"><label>摘要</label>' +
      '<textarea id="sf-summary" rows="2">' + esc(s.summary || '') + '</textarea></div>' +
      '<div class="fld"><label>讲解</label>' +
      '<textarea id="sf-lecture" rows="5">' + esc(s.lecture || '') + '</textarea></div>' +
      '<div class="fld"><label>侧重点（本书特别强调之处，可留空）</label>' +
      '<textarea id="sf-emphasis" rows="2">' + esc(s.emphasis || '') + '</textarea></div>' +
      '<div class="fld"><label>例句（每行一句，格式：日文 / 中文）</label>' +
      '<textarea id="sf-examples" rows="4">' + esc(exText) + '</textarea></div>';
  }

  function readSourceForm() {
    const bookSel = modalEl && modalEl.querySelector('#sf-book');
    const chSel = modalEl && modalEl.querySelector('#sf-chapter');
    const examples = modalVal('sf-examples').split(/\r?\n/)
      .map(line => Parser.splitExample(line))
      .filter(ex => ex.jp);
    return {
      bookId: bookSel ? bookSel.value : '',
      chapterId: chSel ? chSel.value : '',
      summary: modalVal('sf-summary').trim(),
      lecture: modalVal('sf-lecture').trim(),
      emphasis: modalVal('sf-emphasis').trim(),
      examples: examples
    };
  }

  function openSourceEdit(sid) {
    const card = Store.getCardByName(currentCardName);
    if (!card) return;
    const isAdd = !sid;
    const s = isAdd
      ? { bookId: '', chapterId: '', summary: '', lecture: '', emphasis: '', examples: [] }
      : (card.sources || []).find(x => x.id === sid);
    if (!s) { toast('来源不存在或已被删除'); return; }
    const body = sourceFormFields(s) +
      (isAdd ? '<div class="fmt-hint">新来源的讲解/例句独立保存，不会覆盖任何已有来源。</div>' : '');
    openModal(isAdd ? '为「' + card.name + '」新增来源' : '编辑来源',
      body,
      modalFoot('src-save', isAdd ? '追加来源' : '保存',
        ' data-sid="' + esc(sid || '') + '"'));
  }

  function saveSourceEdit(sid) {
    const data = readSourceForm();
    const r = sid
      ? Store.updateCardSource(currentCardName, sid, data)
      : Store.addCardSource(currentCardName, data);
    if (r && r.error === 'dup') {
      toast('这本书/章节的来源已存在，请直接编辑那条来源');
      return;
    }
    if (!r) { toast('保存失败：卡片或来源不存在'); return; }
    closeModal();
    toast(sid ? '来源已保存' : '已追加新来源');
    renderCard(currentCardName);
  }

  function deleteSourceById(sid) {
    const card = Store.getCardByName(currentCardName);
    if (!card) return;
    const sources = card.sources || [];
    const s = sources.find(x => x.id === sid);
    if (!s) return;
    /* 删除前展示全部来源与删除后的影响范围 */
    const allLines = sources.map((x, i) =>
      (x.id === sid ? '［将删除］' : '　　　　') +
      (i + 1) + '. ' + scopeText(x.bookId, x.chapterId)).join('\n');
    const restN = sources.length - 1;
    let msg = '「' + currentCardName + '」共有 ' + sources.length + ' 个来源：\n' + allLines;
    if (restN <= 0) {
      msg += '\n\n这是最后一个来源，不能单独删除。\n' +
        '若要连同主考点一起删除，请使用卡片底部的「删除卡片」。';
      alert(msg);
      return;
    }
    msg += '\n\n本次只删除「' + scopeText(s.bookId, s.chapterId) +
      '」这条来源（其讲解、例句一并移除），\n删除后还剩 ' + restN +
      ' 个来源，主考点与其他来源不受影响。\n\n确定删除？';
    if (!confirm(msg)) return;
    const r = Store.deleteCardSource(currentCardName, sid);
    if (r && r.error === 'last') { toast('至少保留一个来源'); return; }
    toast('来源已删除，剩余 ' + restN + ' 个来源');
    renderCard(currentCardName);
  }

  /* ---------- 弹窗：删除卡片（选择是否连带删题） ---------- */

  function openCardDelete() {
    const name = currentCardName;
    const n = Store.getQuestions().filter(q => q.point === name).length;
    const body =
      '<div class="modal-ico">⚠️</div>' +
      '<div class="modal-confirm-text">确定删除考点「' + esc(name) + '」？此操作不可恢复。</div>' +
      '<div class="modal-confirm-sub">该考点下共有 <b>' + n + '</b> 道题目。<br>' +
      '选择「连题一起删」会同时清理这些题目的错题与疑难记录；考点彻底消失后，' +
      '完成状态与练习统计也会一并清理。</div>';
    const foot =
      '<button class="btn btn-ghost" data-action="modal-close">取消</button>' +
      '<button class="btn-mini btn-outline-danger" data-action="card-del-keep"' +
      ' data-name="' + esc(name) + '">只删卡片，保留题目</button>' +
      '<button class="btn btn-danger" data-action="card-del-all"' +
      ' data-name="' + esc(name) + '">连题一起删（' + n + '题）</button>';
    openModal('删除考点卡片', body, foot);
  }

  function doDeleteCard(name, withQuestions) {
    const r = Store.deleteCard(name, { deleteQuestions: withQuestions });
    closeModal();
    toast(withQuestions
      ? '已删除卡片及 ' + r.questions + ' 道题目'
      : '卡片已删除，题目已保留');
    location.hash = '#/home';
  }

  /* ---------- 弹窗：题目表单（新增 / 编辑共用） ---------- */

  function questionFormHTML(q, pointReadonly) {
    const o = q.options || {};
    const pointField = pointReadonly
      ? '<div class="fld-static">📌 ' + esc(q.point || currentCardName) + '</div>'
      : '<input id="qf-point" type="text" list="pointList" value="' +
      esc(q.point || '') + '" placeholder="考点名称">' + pointDatalistHTML('pointList');
    const opts = (sel, vals) => vals.map(v =>
      '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + v + '</option>').join('');
    return '<div class="fld"><label>考点名称</label>' + pointField + '</div>' +
      sourcePickerHTML('qf-book', 'qf-chapter', q.bookId || '', q.chapterId || '') +
      '<div class="fld-row">' +
      '<div class="fld"><label>门类</label><input id="qf-category" type="text" value="' +
      esc(q.category || '') + '"></div>' +
      '<div class="fld"><label>题型</label><input id="qf-type" type="text" value="' +
      esc(q.type || '单选题') + '"></div>' +
      '<div class="fld"><label>难度</label><select id="qf-difficulty">' +
      opts(q.difficulty || '中', ['易', '中', '难']) + '</select></div>' +
      '<div class="fld"><label>答案</label><select id="qf-answer">' +
      opts(q.answer || 'A', ['A', 'B', 'C', 'D']) + '</select></div>' +
      '</div>' +
      '<div class="fld"><label>题干</label>' +
      '<textarea id="qf-stem" rows="3">' + esc(q.stem || '') + '</textarea></div>' +
      ['A', 'B', 'C', 'D'].map(k =>
        '<div class="fld"><label>选项 ' + k + '</label>' +
        '<input id="qf-opt-' + k + '" type="text" value="' + esc(o[k] || '') + '"></div>'
      ).join('') +
      '<div class="fld"><label>解析</label>' +
      '<textarea id="qf-explanation" rows="3">' + esc(q.explanation || '') + '</textarea></div>';
  }

  function readQuestionForm() {
    const bookSel = modalEl && modalEl.querySelector('#qf-book');
    const chSel = modalEl && modalEl.querySelector('#qf-chapter');
    return {
      point: modalVal('qf-point').trim(),
      category: modalVal('qf-category').trim() || '自定义',
      type: modalVal('qf-type').trim() || '单选题',
      difficulty: modalVal('qf-difficulty'),
      answer: modalVal('qf-answer'),
      bookId: bookSel ? bookSel.value : '',
      chapterId: chSel ? chSel.value : '',
      stem: modalVal('qf-stem').trim(),
      options: {
        A: modalVal('qf-opt-A').trim(),
        B: modalVal('qf-opt-B').trim(),
        C: modalVal('qf-opt-C').trim(),
        D: modalVal('qf-opt-D').trim()
      },
      explanation: modalVal('qf-explanation').trim()
    };
  }

  /** 校验表单公共必填，返回 true/false（不通过会 toast） */
  function validateQuestionForm(data, pointWritable) {
    if (pointWritable && !data.point) { toast('考点名称不能为空'); return false; }
    if (!data.stem) { toast('题干不能为空'); return false; }
    if (!data.options.A || !data.options.B || !data.options.C || !data.options.D) {
      toast('请补全四个选项'); return false;
    }
    return true;
  }

  function openQuestionEdit(id) {
    const q = Store.getQuestionById(id);
    if (!q) { toast('题目不存在或已被删除'); return; }
    openModal('编辑题目', questionFormHTML(q, false),
      modalFoot('q-save', '保存', ' data-id="' + esc(id) + '"'));
  }

  function saveQuestion(id) {
    const data = readQuestionForm();
    if (!validateQuestionForm(data, true)) return;
    const old = Store.getQuestionById(id);
    if (!old) { closeModal(); toast('题目不存在或已被删除'); renderCard(currentCardName); return; }
    Store.updateQuestion(id, data);
    /* 题目改了归属书章时，确保对应卡片挂有该来源 */
    if (data.bookId) Store.ensureCardSource(data.point, data.bookId, data.chapterId);
    closeModal();
    if (data.point === currentCardName) {
      toast('题目已保存');
      renderCard(currentCardName);
    } else if (Store.getCardByName(data.point)) {
      toast('题目已保存并随考点跳转');
      location.hash = '#/card/' + encodeURIComponent(data.point);
    } else {
      toast('题目已保存到「' + data.point + '」');
      renderCard(currentCardName);
    }
  }

  function deleteQuestionById(id) {
    const q = Store.getQuestionById(id);
    if (!q) return;
    if (!confirm('确定删除这道题？\n错题本与疑难标记中的相关记录会一并清理，此操作不可恢复。')) return;
    Store.deleteQuestion(id);
    toast('题目已删除');
    renderCard(currentCardName);
  }

  /* ---------- 弹窗：移动单题 ---------- */

  function openQuestionMove(id) {
    const q = Store.getQuestionById(id);
    if (!q) { toast('题目不存在或已被删除'); return; }
    const body =
      '<div class="fld"><label>移动到哪个考点？</label>' +
      '<input id="mv-point" type="text" list="pointList" placeholder="选择已有考点，或直接输入新考点名">' +
      pointDatalistHTML('pointList') +
      '<div class="fmt-hint">当前考点：' + esc(q.point) +
      '。移动后错题与疑难记录随题保留；目标考点有卡片时门类会自动跟随。</div></div>';
    openModal('移动题目', body,
      modalFoot('q-move-save', '移动', ' data-id="' + esc(id) + '"'));
    const input = modalEl && modalEl.querySelector('#mv-point');
    if (input) input.focus();
  }

  function saveQuestionMove(id) {
    const target = modalVal('mv-point').trim();
    if (!target) { toast('请填写目标考点名称'); return; }
    const q = Store.getQuestionById(id);
    if (!q) { closeModal(); toast('题目不存在或已被删除'); renderCard(currentCardName); return; }
    if (target === q.point) { toast('题目本来就在「' + target + '」下'); return; }
    const r = Store.moveQuestion(id, target);
    if (!r) { toast('移动失败，请检查考点名称'); return; }
    closeModal();
    toast('已移动到「' + target + '」');
    renderCard(currentCardName);
  }

  /* ---------- 弹窗：新增题目（手动 / 粘贴） ---------- */

  function openAddQuestion() {
    addQState.tab = 'manual';
    addQState.text = '';
    addQState.parsed = [];
    renderAddQuestionModal();
  }

  function renderAddQuestionModal() {
    const card = Store.getCardByName(currentCardName);
    const tabs =
      '<div class="import-tabs">' +
      '<button class="import-tab' + (addQState.tab === 'manual' ? ' active' : '') +
      '" data-action="q-add-tab" data-tab="manual">手动录入</button>' +
      '<button class="import-tab' + (addQState.tab === 'paste' ? ' active' : '') +
      '" data-action="q-add-tab" data-tab="paste">粘贴导入</button>' +
      '</div>';

    let body, foot;
    if (addQState.tab === 'manual') {
      const base = {
        point: currentCardName, category: card ? (card.category || '') : '',
        type: '单选题', difficulty: '中', answer: 'A', options: {},
        bookId: card ? (card.bookId || '') : '',
        chapterId: card ? (card.chapterId || '') : ''
      };
      body = tabs + questionFormHTML(base, true);
      foot = modalFoot('q-add-save', '保存题目');
    } else {
      body = tabs +
        '<div class="import-card"><label>粘贴题目文本（格式与「批量导入」相同，每题之间空一行）</label>' +
        '<textarea id="qf-paste" rows="7" placeholder="【门类】...&#10;【考点名称】...&#10;【题干】...&#10;【选项A】...&#10;【答案】B&#10;【解析】...&#10;【难度】中"></textarea></div>' +
        '<div class="import-card">' +
        sourcePickerHTML('qf-book', 'qf-chapter',
          card ? (card.bookId || '') : '', card ? (card.chapterId || '') : '') +
        '<div class="fmt-hint">题目会归属到所选书籍章节；若本卡片还没有该来源，将自动追加。</div></div>' +
        renderPastePreviewHTML();
      foot = '<button class="btn btn-ghost" data-action="modal-close">取消</button>' +
        '<button class="btn-mini" data-action="q-add-parse">解析预览</button>' +
        '<button class="btn btn-primary" data-action="q-add-import">导入勾选题目</button>';
    }
    openModal('新增题目（考点：' + currentCardName + '）', body, foot);
  }

  function renderPastePreviewHTML() {
    const list = addQState.parsed;
    if (!list.length) {
      return '<div class="fmt-hint">粘贴后点「解析预览」，勾选要导入的题目。' +
        '无论原文写的考点是什么，导入后都会归入当前考点「' +
        esc(currentCardName) + '」。</div>';
    }
    const rows = list.map((r, i) =>
      '<label class="paste-row' + (r.valid ? '' : ' invalid') + '">' +
      '<input type="checkbox" class="paste-chk" data-idx="' + i + '"' +
      (r.valid ? ' checked' : ' disabled') + '>' +
      '<div><div class="paste-stem">#' + r.index + ' ' + esc(r.data.stem || '（无题干）') + '</div>' +
      (r.valid
        ? '<div class="paste-sub">' + esc(r.data.category || '无门类') + ' · 原文考点：' +
        esc(r.data.point || '无') + ' · 答案 ' + esc(r.data.answer) + ' · ' +
        esc(r.data.difficulty) + '</div>'
        : '<div class="paste-err">' + esc(r.errors.join('；')) + '</div>') +
      '</div></label>').join('');
    const validN = list.filter(r => r.valid).length;
    return '<div class="paste-preview"><div class="fmt-hint">共解析出 ' + list.length +
      ' 题，其中有效 ' + validN + ' 题</div>' + rows + '</div>';
  }

  function switchAddQTab(tab) {
    if (addQState.tab === 'paste') {
      const ta = modalEl && modalEl.querySelector('#qf-paste');
      if (ta) addQState.text = ta.value;
    }
    addQState.tab = tab;
    renderAddQuestionModal();
    if (tab === 'paste') {
      const ta = modalEl && modalEl.querySelector('#qf-paste');
      if (ta) { ta.value = addQState.text; ta.focus(); }
    }
  }

  function parsePasteQuestions() {
    const ta = modalEl && modalEl.querySelector('#qf-paste');
    const text = ta ? ta.value : '';
    if (!text.trim()) { toast('请先粘贴题目文本'); return; }
    addQState.text = text;
    addQState.parsed = Parser.parseQuestionsText(text);
    renderAddQuestionModal();
    const n = addQState.parsed.filter(r => r.valid).length;
    toast(n ? ('解析出 ' + n + ' 道有效题目') : '没有解析出有效题目，请检查格式');
  }

  function saveNewQuestion() {
    const data = readQuestionForm();
    data.point = currentCardName;
    if (!validateQuestionForm(data, false)) return;
    const r = Store.addQuestionToPoint(currentCardName, data);
    if (r.error === 'dup') { toast('该考点下已有题干完全相同的题目'); return; }
    if (r.error) { toast('题目信息不完整，未保存'); return; }
    closeModal();
    toast('已新增题目');
    renderCard(currentCardName);
  }

  function importPasteQuestions() {
    let list = addQState.parsed;
    if (!list.length) {
      const ta = modalEl && modalEl.querySelector('#qf-paste');
      const text = ta ? ta.value : '';
      if (!text.trim()) { toast('请先粘贴题目文本'); return; }
      addQState.text = text;
      list = Parser.parseQuestionsText(text);
      addQState.parsed = list;
    }
    const picked = [];
    if (modalEl) {
      modalEl.querySelectorAll('.paste-chk:checked').forEach(cb => {
        const r = list[Number(cb.dataset.idx)];
        if (r && r.valid) picked.push(r.data);
      });
    }
    if (!picked.length) { toast('请勾选至少一道有效题目'); return; }
    const bookEl = modalEl && modalEl.querySelector('#qf-book');
    const chEl = modalEl && modalEl.querySelector('#qf-chapter');
    const bookId = bookEl ? (bookEl.value || '') : '';
    const chapterId = chEl ? (chEl.value || '') : '';
    let added = 0, dup = 0;
    picked.forEach(d => {
      const r = Store.addQuestionToPoint(currentCardName, {
        category: d.category, type: d.type, stem: d.stem,
        options: d.options, answer: d.answer,
        explanation: d.explanation, difficulty: d.difficulty,
        bookId: bookId, chapterId: chapterId
      });
      if (r.error === 'dup') dup++;
      else if (!r.error) added++;
    });
    closeModal();
    toast('已导入 ' + added + ' 题' + (dup ? '，同来源重复跳过 ' + dup + ' 题' : '') +
      (added && bookId ? '，卡片已挂上来「' + scopeText(bookId, chapterId) + '」的来源' : ''));
    renderCard(currentCardName);
  }

  /* ---------- 弹窗：批量管理 ---------- */

  function openBatch() {
    const questions = Store.getQuestions().filter(q => q.point === currentCardName);
    if (!questions.length) { toast('当前考点下没有题目'); return; }
    const rows = questions.map(q =>
      '<label class="batch-row">' +
      '<input type="checkbox" class="batch-chk" data-id="' + esc(q.id) + '" checked>' +
      '<div><div class="batch-stem">' + esc(q.stem) + '</div>' +
      '<div class="batch-sub"><span class="badge diff-' + (q.difficulty || '中') + '">' +
      esc(q.difficulty || '中') + '</span>' + esc(q.type || '单选题') +
      ' · 答案 ' + esc(q.answer || '?') + '</div></div></label>').join('');
    const body =
      '<div class="batch-toolbar">' +
      '<label class="batch-all"><input type="checkbox" id="batch-all" checked> 全选</label>' +
      '<span class="batch-count" id="batch-count"></span></div>' +
      '<div class="batch-list">' + rows + '</div>' +
      '<div class="batch-move-wrap"><label>移动选中题目到</label>' +
      '<div class="batch-move"><input id="batch-target" type="text" list="pointList"' +
      ' placeholder="选择或输入目标考点">' + pointDatalistHTML('pointList') +
      '<button class="btn-mini" data-action="batch-move">移动选中</button></div></div>';
    const foot =
      '<button class="btn btn-ghost" data-action="modal-close">关闭</button>' +
      '<button class="btn-mini btn-outline-danger" data-action="batch-delall">删除全部</button>' +
      '<button class="btn-mini" data-action="batch-keep">只保留选中</button>' +
      '<button class="btn-mini danger" data-action="batch-del">删除选中</button>';
    openModal('批量管理（' + questions.length + ' 题）', body, foot);
    updateBatchCount();
  }

  function checkedBatchIds() {
    if (!modalEl) return [];
    return Array.from(modalEl.querySelectorAll('.batch-chk:checked')).map(cb => cb.dataset.id);
  }

  function updateBatchCount() {
    if (!modalEl) return;
    const total = modalEl.querySelectorAll('.batch-chk').length;
    const n = modalEl.querySelectorAll('.batch-chk:checked').length;
    const el = modalEl.querySelector('#batch-count');
    if (el) el.textContent = '已选 ' + n + ' / ' + total + ' 题';
  }

  function batchDelete() {
    const ids = checkedBatchIds();
    if (!ids.length) { toast('请先勾选要删除的题目'); return; }
    if (!confirm('确定删除选中的 ' + ids.length + ' 道题？\n错题与疑难记录会一并清理，不可恢复。')) return;
    const n = Store.deleteQuestionsByIds(ids);
    closeModal();
    toast('已删除 ' + n + ' 道题');
    renderCard(currentCardName);
  }

  function batchKeep() {
    const ids = checkedBatchIds();
    const total = Store.getQuestions().filter(q => q.point === currentCardName).length;
    if (!ids.length) { toast('请先勾选要保留的题目'); return; }
    if (!confirm('只保留选中的 ' + ids.length + ' 道题，本考点其余 ' +
      (total - ids.length) + ' 道题将被删除，确定？')) return;
    const n = Store.keepOnlyQuestions(currentCardName, ids);
    closeModal();
    toast('已保留选中题目，删除其余 ' + n + ' 道');
    renderCard(currentCardName);
  }

  function batchDeleteAll() {
    const total = Store.getQuestions().filter(q => q.point === currentCardName).length;
    if (!total) { toast('当前考点下没有题目'); return; }
    if (!confirm('确定删除该考点下全部 ' + total + ' 道题？\n错题与疑难记录会一并清理，不可恢复。')) return;
    const n = Store.deleteQuestionsByPoint(currentCardName);
    closeModal();
    toast('已删除全部 ' + n + ' 道题');
    renderCard(currentCardName);
  }

  function batchMove() {
    if (!modalEl) return;
    const target = modalVal('batch-target').trim();
    if (!target) { toast('请填写目标考点名称'); return; }
    const ids = checkedBatchIds();
    if (!ids.length) { toast('请先勾选要移动的题目'); return; }
    const n = Store.moveQuestions(ids, target);
    if (n) {
      /* 按被移动题目的书章归属给目标考点卡片补来源 */
      const moved = Store.getQuestions().filter(q => ids.indexOf(q.id) !== -1);
      Store.ensureCardSourcesForQuestions(moved);
    }
    closeModal();
    toast(n ? ('已移动 ' + n + ' 道题到「' + target + '」') : '没有题目被移动');
    renderCard(currentCardName);
  }

  /* ================= 视图：刷题 ================= */

  function renderQuiz() {
    if (!session) { location.hash = '#/home'; return; }
    if (session.finished) {
      if (session.reviewing) return renderReviewQuestion();
      return renderFinish();
    }

    const s = session;
    const it = s.items[s.index];
    const q = it.q;
    const answered = it.chosen !== null;
    const answeredCount = s.items.filter(x => x.chosen !== null).length;
    const percent = Math.round(answeredCount / s.items.length * 100);
    const modeLocked = s.items.some(x => x.chosen !== null);

    /* 选项（展示顺序按 perm）；右侧 📇 打开该选项绑定的语法点卡片。
       学习模式随时可看；训练模式作答后才可看。无绑定卡片的选项不显示图标。 */
    const optionsHTML = it.perm.map((origKey, i) => {
      let cls = 'option';
      if (answered) {
        if (s.feedback === 'instant') {
          if (i === it.displayAnswer) cls += ' correct';
          else if (i === it.chosen) cls += ' wrong';
          else cls += ' muted';
        } else {
          if (i === it.chosen) cls += ' picked';
        }
        cls += ' locked';
      }
      const cardName = ((q.optionCards && q.optionCards[origKey]) || '').trim();
      const peekLocked = s.learnMode !== 'learn' && !answered;
      const cardIco = cardName
        ? '<span class="opt-card' + (peekLocked ? ' locked' : '') + '"' +
          ' data-action="quiz-opt-card" data-orig="' + origKey + '" title="' +
          (peekLocked ? '训练模式：作答后才能查看该语法点卡片' : '查看该选项对应的语法点卡片') +
          '">' + (peekLocked ? '🔒' : '📇') + '</span>'
        : '';
      return '<button class="' + cls + '" data-action="quiz-option"' +
        (answered ? '' : ' data-idx="' + i + '"') + '>' +
        '<span class="opt-key">' + String.fromCharCode(65 + i) + '</span>' +
        '<span class="opt-text">' + esc(q.options[origKey]) + '</span>' + cardIco + '</button>';
    }).join('');

    /* 查卡模式提示 */
    const peekHint = '<div class="opt-peek-hint">' +
      (s.learnMode === 'learn'
        ? '📖 学习模式：点选项右侧 📇 可先看语法卡片，点选项文字直接作答'
        : '🎯 训练模式：先自己作答，答完后选项右侧出现 📇 可查看语法卡片') +
      '</div>';

    /* 不确定标记 */
    let uncertainHTML;
    if (!answered) {
      uncertainHTML = '<button class="btn-mini uncertain-btn' +
        (it.uncertain ? ' active' : '') + '" data-action="mark-uncertain">' +
        (it.uncertain ? '🚩 已标记不确定' : '🚩 我不确定') + '</button>';
    } else {
      uncertainHTML = it.uncertain
        ? '<span class="badge marked-on">🚩 已标记：答对也进疑难队列</span>' : '';
    }

    /* 底部反馈区 */
    let bottomHTML = '';
    if (answered) {
      if (s.feedback === 'instant') {
        const chosenLetter = String.fromCharCode(65 + it.chosen);
        const answerLetter = String.fromCharCode(65 + it.displayAnswer);
        const chosenOrig = it.perm[it.chosen];
        const answerOrig = it.perm[it.displayAnswer];
        bottomHTML =
          '<div class="explain">' +
          '<div class="ex-result ' + (it.correct ? 'right' : 'bad') + '">' +
          (it.correct ? '✓ 回答正确' : '✗ 回答错误') + '</div>' +
          '<div class="ex-answer">正确答案：' + answerLetter + '．' + esc(q.options[answerOrig]) +
          (it.correct ? '' : '　你的选择：' + chosenLetter + '．' + esc(q.options[chosenOrig])) + '</div>' +
          '<div class="ex-answer">⏱ 本题用时：' + fmtDuration(it.ms) + '</div>' +
          (q.explanation ? '<div class="ex-body">' + esc(q.explanation) + '</div>' : '') +
          '</div>' +
          '<button class="btn btn-primary" data-action="quiz-next">' +
          (s.index === s.items.length - 1 ? '查看结果' : '下一题') + '</button>';
      } else {
        bottomHTML =
          '<div class="picked-tip">已选择 ' +
          String.fromCharCode(65 + it.chosen) +
          '（考试模式：结果将在全部完成后公布）</div>' +
          '<button class="btn btn-primary" data-action="quiz-next">' +
          (s.index === s.items.length - 1 ? '交卷并查看结果' : '下一题') + '</button>';
      }
    }

    setHTML(
      '<a class="back-link" href="#/home">‹ 返回</a>' +

      '<div class="mode-switch quiz-modes">' +
      '<span class="ms-pill fb' + (modeLocked ? ' locked' : '') +
      (s.feedback === 'instant' ? ' active' : '') +
      '" data-action="set-feedback" data-mode="instant">即时反馈</span>' +
      '<span class="ms-pill fb' + (modeLocked ? ' locked' : '') +
      (s.feedback === 'exam' ? ' active' : '') +
      '" data-action="set-feedback" data-mode="exam">统一解析</span>' +
      '<i class="ms-sep"></i>' +
      '<span class="ms-pill' + (s.learnMode === 'learn' ? ' active' : '') +
      '" data-action="set-learn" data-mode="learn">学习模式</span>' +
      '<span class="ms-pill' + (s.learnMode === 'train' ? ' active' : '') +
      '" data-action="set-learn" data-mode="train">训练模式</span>' +
      '</div>' +

      '<div class="quiz-progress-bar"><i style="width:' + percent + '%"></i></div>' +
      '<div class="quiz-progress-txt">' +
      '<span>' + esc(s.mode === 'point' || s.mode === 'similar' ? '语法练习' : s.title) + '</span>' +
      '<span>' + (s.index + 1) + ' / ' + s.items.length + '</span>' +
      '</div>' +

      '<div class="q-panel">' +
      '<div class="q-tags">' +
      '<span class="badge cat">' + esc(q.category) + '</span>' +
      '<span class="badge diff-' + q.difficulty + '">' + esc(q.difficulty) + '</span>' +
      sourceBadgeHTML(q.bookId, q.chapterId) +
      '</div>' +
      '<div class="q-stem">' + esc(q.stem) + '</div>' +
      optionsHTML +
      peekHint +
      '<div class="uncertain-row">' + uncertainHTML + '</div>' +
      '</div>' +
      bottomHTML
    );
  }

  /* ---------- 考试模式：逐题回顾 ---------- */

  function renderReviewQuestion() {
    const s = session;
    const it = s.items[s.index];
    const q = it.q;
    const chosenOrig = it.chosen === null ? '' : it.perm[it.chosen];
    const answerOrig = it.perm[it.displayAnswer];
    const chosenLetter = it.chosen === null ? '' : String.fromCharCode(65 + it.chosen);
    const answerLetter = String.fromCharCode(65 + it.displayAnswer);

    const optionsHTML = it.perm.map((origKey, i) => {
      let cls = 'option locked';
      if (i === it.displayAnswer) cls += ' correct';
      else if (i === it.chosen) cls += ' wrong';
      else cls += ' muted';
      const cardName = ((q.optionCards && q.optionCards[origKey]) || '').trim();
      const cardIco = cardName
        ? '<span class="opt-card" data-action="quiz-opt-card" data-orig="' + origKey +
          '" title="查看该选项对应的语法点卡片">📇</span>' : '';
      return '<div class="' + cls + '">' +
        '<span class="opt-key">' + String.fromCharCode(65 + i) + '</span>' +
        '<span class="opt-text">' + esc(q.options[origKey]) + '</span>' + cardIco + '</div>';
    }).join('');

    setHTML(
      '<div class="quiz-progress-txt"><span>解析回顾</span>' +
      '<span>' + (s.index + 1) + ' / ' + s.items.length + '</span></div>' +
      '<div class="q-panel">' +
      '<div class="q-tags">' +
      '<span class="badge cat">' + esc(q.category) + '</span>' +
      '<span class="badge diff-' + q.difficulty + '">' + esc(q.difficulty) + '</span>' +
      sourceBadgeHTML(q.bookId, q.chapterId) +
      (it.uncertain ? '<span class="badge marked-on">🚩 不确定</span>' : '') +
      '</div>' +
      '<div class="q-stem">' + esc(q.stem) + '</div>' +
      optionsHTML +
      '</div>' +
      '<div class="explain">' +
      '<div class="ex-result ' + (it.correct ? 'right' : 'bad') + '">' +
      (it.correct ? '✓ 回答正确' : '✗ 回答错误') + '</div>' +
      '<div class="ex-answer">正确答案：' + answerLetter + '．' + esc(q.options[answerOrig]) +
      (it.chosen === null ? '' : '　你的选择：' + chosenLetter + '．' + esc(q.options[chosenOrig])) + '</div>' +
      '<div class="ex-answer">⏱ 本题用时：' + fmtDuration(it.ms) + '</div>' +
      (q.explanation ? '<div class="ex-body">' + esc(q.explanation) + '</div>' : '') +
      '</div>' +
      '<div class="btn-row">' +
      (s.index > 0
        ? '<button class="btn btn-ghost" data-action="review-prev">上一题</button>' : '') +
      (s.index < s.items.length - 1
        ? '<button class="btn btn-primary" data-action="review-next">下一题</button>'
        : '<button class="btn btn-primary" data-action="review-back">‹ 返回</button>') +
      '</div>'
    );
  }

  /* ================= 视图：完成页 ================= */

  function renderFinish() {
    const s = session;
    const correct = s.items.filter(it => it.correct).length;
    const wrong = s.items.length - correct;
    const totalMs = s.items.reduce((sum, it) => sum + (it.ms || 0), 0);
    const avgMs = s.items.length ? totalMs / s.items.length : 0;

    const meta = {
      point: { ico: '🎉', h2: '本考点完成！', sub: '考点「' + s.pointName + '」的题目已全部答完' },
      mixed: { ico: '🎊', h2: '综合练习完成！', sub: '所有题目已作答完毕' },
      wrong: { ico: '💪', h2: '错题重练完成！', sub: '答对的错题已自动移出错题本' },
      marked: { ico: '🚩', h2: '疑难重练完成！', sub: '答对且未再标记的题已移出疑难队列' },
      article: { ico: '📖', h2: '本文练习完成！', sub: '答错的题已自动收入错题本' },
      similar: { ico: '🔁', h2: '相似题完成！', sub: '同一考点的相似题已练完，答错的照常进错题本' },
      chapter: { ico: '📚', h2: '本章练习完成！', sub: '本章节的题目已全部答完' }
    }[s.mode];

    const contextBtn = s.mode === 'point'
      ? '<a class="btn btn-ghost back-link" href="#/card/' + encodeURIComponent(s.pointName) + '">‹ 返回</a>'
      : s.mode === 'wrong'
        ? '<a class="btn btn-ghost back-link" href="#/wrong">‹ 返回</a>'
        : s.mode === 'marked'
          ? '<a class="btn btn-ghost back-link" href="#/marked">‹ 返回</a>'
          : s.mode === 'article'
            ? '<a class="btn btn-ghost back-link" href="#/article/' + encodeURIComponent(s.articleId) + '">‹ 返回</a>'
            : s.mode === 'similar'
              ? '<a class="btn btn-ghost back-link" href="#/wrong">‹ 返回</a>'
              : s.mode === 'chapter'
                ? '<a class="btn btn-ghost back-link" href="#/chapter/' +
                scopeToRoute(s.bookId || '') + '/' + scopeToRoute(s.chapterId || '') +
                '">‹ 返回</a>'
                : '<a class="btn btn-ghost back-link" href="#/home">‹ 返回</a>';

    setHTML(
      '<div class="finish-card">' +
      '<div class="f-ico">' + meta.ico + '</div>' +
      '<h2>' + meta.h2 + '</h2>' +
      '<div class="f-sub">' + esc(meta.sub) + '</div>' +
      '<div class="f-score"><span class="s-num">' + correct + '</span>' +
      '<span class="s-den">/ ' + s.items.length + '</span></div>' +
      '<div class="f-detail">' +
      '<div class="row"><span>答对</span><span>' + correct + ' 题</span></div>' +
      '<div class="row"><span>答错</span><span>' + wrong + ' 题</span></div>' +
      '<div class="row"><span>总用时</span><span>' + fmtDuration(totalMs) + '</span></div>' +
      '<div class="row"><span>平均每题</span><span>' + fmtDuration(avgMs) + '</span></div>' +
      (s.mode === 'wrong'
        ? '<div class="row"><span>错题本剩余</span><span>' + Store.wrongCount() + ' 题</span></div>'
        : '') +
      '</div>' +
      '<div class="btn-row">' +
      (s.feedback === 'exam'
        ? '<button class="btn btn-primary" data-action="review-start">查看解析</button>' : '') +
      '<button class="btn ' + (s.feedback === 'exam' ? 'ghost' : 'primary') +
      '" data-action="quiz-restart">再练一次</button>' +
      '</div>' +
      '</div>' +
      '<div class="btn-row">' + contextBtn +
      '<a class="btn btn-ghost" href="#/home">首页</a></div>'
    );
  }

  /* ================= 视图：错题本（错题 + 疑难） ================= */

  /** 分组计数，按次数降序 */
  function countGroups(items, keyFn) {
    const m = {};
    items.forEach(x => {
      const k = keyFn(x);
      if (k) m[k] = (m[k] || 0) + 1;
    });
    return Object.keys(m).map(k => ({ name: k, count: m[k] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  }

  function renderWrongPage() {
    const wrongs = Store.getWrongQuestions();
    const markeds = Store.getMarkedQuestions();

    /* ---- 错题统计（仅错题标签展示） ---- */
    let statsHTML = '';
    if (wrongPageTab === 'wrong') {
      const byPoint = countGroups(wrongs, q => q.point);
      const byType = countGroups(wrongs, q => q.type);

      const hintHTML = byPoint.length
        ? '<div class="weak-hint">薄弱点：你在「' + esc(byPoint[0].name) +
        '」上错得最多（' + byPoint[0].count + ' 次），建议优先复习。</div>' +
        '<button class="btn btn-primary" data-action="weak-practice" data-name="' +
        esc(byPoint[0].name) + '">🚀 专项刷题：' + esc(byPoint[0].name) + '</button>'
        : '<div class="weak-hint quiet">暂无错题，保持住！</div>';

      const rows = groups => groups.map(g =>
        '<div class="sg-row"><span>' + esc(g.name) + '</span>' +
        '<em>' + g.count + ' 次</em></div>').join('');

      statsHTML =
        hintHTML +
        (byPoint.length
          ? '<div class="stat-groups"><div class="sg-title">按考点</div>' +
          rows(byPoint) + '</div>' : '') +
        (byType.length
          ? '<div class="stat-groups"><div class="sg-title">按题型</div>' +
          rows(byType) + '</div>' : '');
    }

    /* ---- 列表 ---- */
    let listHTML, actionBtn;
    if (wrongPageTab === 'wrong') {
      const pills = sourcePillsHTML(wrongs, 'wrong-src', '');
      actionBtn = wrongs.length
        ? (pills ? '<div class="wrong-src-bar"><div class="fmt-hint" style="margin:0 0 8px">' +
          '可按来源挑错题重练，错题统计仍按考点汇总：</div>' + pills + '</div>' : '') +
        '<button class="btn btn-primary" data-action="wrong-practice" style="margin-bottom:14px">' +
        '错题重练（' + wrongs.length + '题 · 全部来源）</button>' : '';
      listHTML = wrongs.length ? wrongs.map(q =>
        '<div class="wrong-item">' +
        '<div class="wi-top"><div class="wi-tags">' +
        '<span class="badge cat">' + esc(q.category) + '</span>' +
        '<span class="badge todo">' + esc(q.point) + '</span>' +
        '<span class="badge diff-' + q.difficulty + '">' + esc(q.difficulty) + '</span>' +
        '</div><div class="wi-acts">' +
        '<button class="icon-btn" data-action="similar-q" data-point="' +
        esc(q.point) + '" data-id="' + esc(q.id) + '" title="相似题">🔁</button>' +
        '<button class="icon-btn danger" data-action="remove-wrong" data-id="' +
        esc(q.id) + '" title="移出错题本">✕</button></div></div>' +
        '<div class="wi-scope">' + sourceBadgeHTML(q.bookId, q.chapterId) + '</div>' +
        '<div class="wi-stem">' + esc(q.stem) + '</div>' +
        '<div class="wi-ans">正确答案：' + esc(q.answer + '．' + q.options[q.answer]) + '</div>' +
        '</div>').join('') :
        '<div class="empty"><span class="e-ico">📕</span>' +
        '<div class="e-txt">错题本还是空的<br>刷题答错的题会自动收录到这里</div></div>';
    } else {
      const pills = sourcePillsHTML(markeds, 'marked-src', '');
      actionBtn = markeds.length
        ? (pills ? '<div class="wrong-src-bar"><div class="fmt-hint" style="margin:0 0 8px">' +
          '可按来源挑疑难题重练：</div>' + pills + '</div>' : '') +
        '<button class="btn btn-primary" data-action="marked-practice" style="margin-bottom:14px">' +
        '疑难重练（' + markeds.length + '题 · 全部来源）</button>' : '';
      listHTML = markeds.length ? markeds.map(q =>
        '<div class="wrong-item">' +
        '<div class="wi-top"><div class="wi-tags">' +
        '<span class="badge cat">' + esc(q.category) + '</span>' +
        '<span class="badge todo">' + esc(q.point) + '</span>' +
        '<span class="badge diff-' + q.difficulty + '">' + esc(q.difficulty) + '</span>' +
        '</div><div class="wi-acts">' +
        '<button class="icon-btn danger" data-action="remove-marked" data-id="' +
        esc(q.id) + '" title="移出疑难队列">✕</button></div></div>' +
        '<div class="wi-scope">' + sourceBadgeHTML(q.bookId, q.chapterId) + '</div>' +
        '<div class="wi-stem">' + esc(q.stem) + '</div>' +
        '<div class="wi-ans">正确答案：' + esc(q.answer + '．' + q.options[q.answer]) + '</div>' +
        '</div>').join('') :
        '<div class="empty"><span class="e-ico">🚩</span>' +
        '<div class="e-txt">疑难队列是空的<br>做题时点"我不确定"，即使答对也会进这里</div></div>';
    }

    setHTML(
      '<header class="page-head"><h1>' +
      (wrongPageTab === 'wrong' ? '错题本' : '疑难标记') + '</h1>' +
      '<div class="sub">' + (wrongPageTab === 'wrong'
        ? '错题统计按考点汇总 · 支持按来源筛选重练' : '蒙对/不确定的题，往往才是真漏洞') + '</div></header>' +

      '<div class="import-tabs">' +
      '<div class="import-tab' + (wrongPageTab === 'wrong' ? ' active' : '') +
      '" data-action="wrongpage-tab" data-tab="wrong">错题 (' + wrongs.length + ')</div>' +
      '<div class="import-tab' + (wrongPageTab === 'marked' ? ' active' : '') +
      '" data-action="wrongpage-tab" data-tab="marked">疑难 (' + markeds.length + ')</div>' +
      '</div>' +

      statsHTML + actionBtn + listHTML
    );
  }

  /* ================= 视图：批量导入 ================= */

  const FMT_QUESTION =
    '每道题用空行分隔，每行一个字段，例如：\n' +
    '【门类】N4文法\n【考点名称】～ている\n【题型】单选题\n【题干】今、父は新聞を（　）。\n' +
    '【选项A】読みます\n【选项B】読んでいます\n【选项C】読みました\n【选项D】読もう\n' +
    '【选项B卡片】～ている\n' +
    '【答案】B\n【解析】「今」表示正在进行，用ている。\n【难度】易\n\n' +
    '【选项X卡片】可写可不写：只给有对应语法点的选项填（示例只给 B 填了，其余整行省略），' +
    '内容是卡片全名，做题时点选项即可弹卡；' +
    '不填时系统会在导入时自动按选项文本宽松匹配（あげく 能匹配 ～あげく（に）），' +
    '匹配不到就留空，不报错，也不影响做题。\n' +
    '📌 推荐流程：先在上方选好「归属书籍 / 章节」，点「复制格式模板」，' +
    '复制出的提示词已带上【书籍】【章节】，AI 生成的每道题都会原样带这两行；' +
    '粘贴回来解析后自动归位到对应章节，无需手改。文本里也可以直接写【书籍】【章节】，' +
    '书或章节不存在时会自动新建；都没写则归入上方选中的归属。';

  const FMT_CARD =
    '每张卡片用空行分隔，可写多条【例句】，日文与中文用 / 分隔；' +
    '【侧重点】可选，写这本书特别强调、与其他书不同的点：\n' +
    '【考点名称】～ている\n【门类】N4文法\n【摘要】表示正在进行的动作或持续的状态。\n' +
    '【讲解】Vて+いる。主要用法：①正在进行 ②结果状态 ③习惯反复。\n' +
    '【侧重点】N4 侧重结果状态用法，注意与～てある的区别。\n' +
    '【例句】父は今、新聞を読んでいます。/ 爸爸正在看报纸。\n' +
    '【例句】田中さんは東京に住んでいます。/ 田中先生住在东京。\n' +
    '同名卡片不会覆盖：不同书各写一份讲解，导入后作为独立来源分别保留。';

  /** 给 AI 的题目生成模板；已选好书籍+章节时把归属两行带进每道题的格式 */
  function questionPromptText() {
    normalizeImportScope();
    const book = importState.bookId ? Store.getBookById(importState.bookId) : null;
    const chapter = book && importState.chapterId
      ? (book.chapters || []).find(c => c.id === importState.chapterId) : null;
    const scopeHead = book && chapter
      ? '每道题的开头必须原样照抄下面两行归属字段（一字不改），确保生成的题目自动归入该书该章：\n' +
        '【书籍】' + book.name + '\n【章节】' + chapter.name + '\n\n'
      : '';
    return '请按以下格式生成日语语法单选题，每道题之间用一个空行分隔，' +
      '每行一个字段，字段名必须用【】包裹，不要输出格式以外的内容：\n\n' +
      scopeHead +
      '【门类】（如 N5文法 / N4文法 / N3文法/ N2文法/ N1文法）\n' +
      '【考点名称】（语法点名称）\n' +
      '【题型】单选题\n' +
      '【题干】（日语句子，需要选择的位置用（　）标出）\n' +
      '【选项A】（日文选项）\n【选项B】（日文选项）\n' +
      '【选项C】（日文选项）\n【选项D】（日文选项）\n' +
      '【选项A卡片】（可选：A选项对应的语法点卡片全名，如 ～あげく（に）；不确定就整行省略）\n' +
      '【选项B卡片】（可选，同上）\n【选项C卡片】（可选）\n【选项D卡片】（可选）\n' +
      '【答案】（只能是 A / B / C / D 中的一个字母）\n' +
      '【解析】（中文，解析需要详细，说明正确选项为什么对、其他选项为什么不合适,① 正确选项的语法含义和接续方式）,② 正确选项在句中的具体作用（为什么符合句意）,③ 逐一说明其他三个选项为什么不适合（各自含义、接续、语境差异）,④ 如果涉及近义语法，要补充对比辨析,⑤ 必要时给出一个额外的正确例句\n' +
      '【难度】（易 / 中 / 难）\n\n' +
      '要求：四个选项必须有迷惑性、考察同一语法点；题干自然地道、符合日语语法；\n' +
      '四个选项本身尽量都是语法点形式，并在【选项X卡片】里写出它对应的语法点全名' +
      '（带～和括号，如选项写「あげく」、卡片写「～あげく（に）」），' +
      '用户点选项即可查看该语法点卡片；纯词形变化等没有对应卡片的选项，该行省略即可；\n' +
      '一次生成 100 道题，考点不要重复。';
  }

  /** 给 AI 的卡片生成提示词（一键复制用） */
  const TEMPLATE_FOR_CARD =
    '请按以下格式生成日语语法考点卡片，每张卡片之间用一个空行分隔，' +
    '每行一个字段，字段名必须用【】包裹，不要输出格式以外的内容：\n\n' +
    '【考点名称】（语法点名称，接续用～表示，如 ～ている、～わけだ；' +
    '变体用・分隔，如 ～べき・～べからず；可选部分用（），如 ～際（は））\n' +
    '【门类】（如 N5文法 / N4文法 / N3文法 / N2文法 / N1文法 / 自定义语法，不填也行）\n' +
    '【摘要】（一句话概括这个语法的意思和用法）\n' +
    '【讲解】（接续方式 + 主要用法 + 注意事项，可写多条）\n' +
    '【侧重点】（可选：这本书特别强调、或与其他级别/教材不同的重点）\n' +
    '【例句】（日语句子 / 中文翻译，可写多条，每条单独一行【例句】）\n\n' +
    '要求：考点名称必须带～接续符号（决定能否被文章精读识别）；' +
    '摘要简洁；讲解讲清接续和用法区别；例句地道且带翻译。\n' +
    '同一语法点在不同书里讲解可以不一样：同名卡片会作为不同来源各自保留，不会覆盖。\n' +
    '一次生成 20 张卡片，考点之间不要重复。';

  /* ---------- 导入归属：书籍 / 章节选择 ---------- */

  /** 校正 importState 中可能已被删除的归属 */
  function normalizeImportScope() {
    if (!importState.bookId) { importState.bookId = ''; importState.chapterId = ''; return; }
    const book = Store.getBookById(importState.bookId);
    if (!book) { importState.bookId = ''; importState.chapterId = ''; return; }
    if (importState.chapterId &&
      !(book.chapters || []).some(c => c.id === importState.chapterId)) {
      importState.chapterId = '';
    }
  }

  /** 归属的可读名称：未分类 / 《书名》／章节名（未分章节） */
  function scopeText(bookId, chapterId) {
    if (!bookId) return '未分类';
    const book = Store.getBookById(bookId);
    if (!book) return '未分类';
    let txt = '《' + book.name + '》';
    if (chapterId) {
      const ch = (book.chapters || []).find(c => c.id === chapterId);
      if (ch) txt += ' ／ ' + ch.name;
    } else {
      txt += ' ／ 未分章节';
    }
    return txt;
  }

  /** 按名称忽略大小写/空白找已有书籍 */
  function findBookByName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    return Store.getBooks().find(b => b.name.trim().toLowerCase() === n) || null;
  }

  /** 按名称在书下找已有章节 */
  function findChapterByName(book, name) {
    const n = String(name || '').trim().toLowerCase();
    if (!book || !n) return null;
    return (book.chapters || []).find(c => c.name.trim().toLowerCase() === n) || null;
  }

  /**
   * 解析一条预览题目的最终归属：
   *  - 文本里写了【书籍】→ 匹配已有书（同名忽略大小写），匹配不到标记 autoBook 自动新建
   *  - 文本写了【章节】→ 在该书下匹配，匹配不到 autoCh 自动新建
   *  - 文本没写归属 → 回退到导入页顶部选中的归属
   * 返回 { book, chapter, autoBook, autoCh, bookName, chapterName }
   */
  function resolveImportScope(data) {
    const name = String(data.book || '').trim();
    const chName = String(data.chapter || '').trim();
    let book = name ? findBookByName(name) : null;
    let chapter = null;
    let autoBook = false, autoCh = false;
    if (name) {
      if (!book) {
        /* 书都不存在：章节必然要随新书一起新建 */
        autoBook = true;
        if (chName) autoCh = true;
      } else if (chName) {
        chapter = findChapterByName(book, chName);
        if (!chapter) autoCh = true;
      }
    } else {
      /* 文本未声明归属：跟随页面选中的书章 */
      normalizeImportScope();
      if (importState.bookId) {
        book = Store.getBookById(importState.bookId);
        if (book && importState.chapterId) {
          chapter = (book.chapters || []).find(c => c.id === importState.chapterId) || null;
        }
      }
    }
    return {
      book, chapter, autoBook, autoCh,
      bookName: name, chapterName: chName
    };
  }

  /** 归属预览文案：已匹配 / 将自动新建 / 未分类 */
  function scopePreviewText(s) {
    if (!s.book && !s.autoBook) return '未分类';
    const bn = s.book ? s.book.name : s.bookName;
    const cn = s.chapter ? s.chapter.name : s.chapterName;
    let txt = '《' + bn + '》' + (s.autoBook ? '（自动新建）' : '');
    txt += ' ／ ';
    if (cn) txt += cn + (s.autoCh ? '（自动新建）' : '');
    else if (s.book) txt += '未分章节';
    return txt;
  }

  /** 解析后归属分组 key（同书同章同新建标记合并计数） */
  function scopeGroupKey(s) {
    return (s.book ? s.book.id : 'new:' + s.bookName) + '|' +
      (s.chapter ? s.chapter.id : 'new:' + s.chapterName) + '|' +
      (s.autoBook ? 1 : 0) + '|' + (s.autoCh ? 1 : 0);
  }

  /* ---------- 选项 → 语法卡片：导入时匹配一次，之后只精确查找 ---------- */

  /** 去掉装饰（～〜、括号及括号内容、空白、间隔号），得到用于宽松匹配的核心形 */
  function cardCoreName(s) {
    return String(s == null ? '' : s).trim()
      .replace(/[〜～]/g, '')
      .replace(/[（(\[【{][^（）()\[\]【】{}]*[）)\]】}]/g, '')
      .replace(/[\s　・·]/g, '');
  }

  /**
   * 用选项文本宽松匹配卡片名（全局搜，不限书；只在导入那一刻执行一次）：
   * 精确相等 → 去装饰后相等 → 核心互相包含（核心 ≥2 字，避免「を」之类误配）；
   * 都不中返回 ''。
   */
  function matchCardName(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return '';
    const cards = Store.getCards();
    let hit = cards.find(c => c.name === t);
    if (hit) return hit.name;
    const tc = cardCoreName(t);
    if (!tc) return '';
    hit = cards.find(c => cardCoreName(c.name) === tc);
    if (hit) return hit.name;
    if (tc.length >= 2) {
      hit = cards.find(c => {
        const cc = cardCoreName(c.name);
        return cc && (cc.indexOf(tc) >= 0 || tc.indexOf(cc) >= 0);
      });
      if (hit) return hit.name;
    }
    return '';
  }

  /**
   * 定死一道题四个选项的卡片名（只存名称指针，不复制卡片内容）：
   * 文本写了【选项X卡片】→ 原样采用（即使当前无卡也保留，将来补卡后自动生效）；
   * 没写 → 用选项文本宽松匹配一次；不中留空。
   */
  function resolveOptionCards(data) {
    const out = {};
    ['A', 'B', 'C', 'D'].forEach(L => {
      const given = String((data.optionCards && data.optionCards[L]) || '').trim();
      out[L] = given || matchCardName((data.options || {})[L]);
    });
    return out;
  }

  /* ================= 多来源展示工具 ================= */

  /** 书名（找不到书返回空串） */
  function bookNameOf(bookId) {
    if (!bookId) return '';
    const b = Store.getBookById(bookId);
    return b ? b.name : '';
  }

  /** 来源筛选 token 的显示名：'' 全部 / 'none' 未分类 / 其他为书名 */
  function sourceFilterLabel(token) {
    if (!token) return '';
    if (token === 'none') return '未分类';
    return bookNameOf(token) || '未知来源';
  }

  /** 题目/来源的小徽章 HTML（未分类显示灰色；找不到书也降级显示） */
  function sourceBadgeHTML(bookId, chapterId) {
    if (!bookId) return '<span class="badge src none">📚 未分类</span>';
    const book = Store.getBookById(bookId);
    if (!book) return '<span class="badge src none">📚 未分类</span>';
    let txt = '📚 ' + book.name;
    if (chapterId) {
      const ch = (book.chapters || []).find(c => c.id === chapterId);
      if (ch) txt += '·' + ch.name;
    }
    return '<span class="badge src" title="来源：' + esc(scopeText(bookId, chapterId)) + '">' +
      esc(txt) + '</span>';
  }

  /**
   * 来源筛选 pills。
   * @param {Array} list 题目数组（按 q.bookId 聚合）
   * @param {string} action 点击 pill 的 data-action
   * @param {string} active 当前选中 token
   * @param {string} extraAttrs 额外属性（如 data-name）
   */
  function sourcePillsHTML(list, action, active, extraAttrs) {
    const map = new Map();
    let hasNone = false;
    list.forEach(q => {
      if (q.bookId) {
        if (!map.has(q.bookId)) map.set(q.bookId, bookNameOf(q.bookId) || '未知书籍');
      } else hasNone = true;
    });
    if (map.size + (hasNone ? 1 : 0) <= 1) return '';
    const activeTok = active || '';
    const pill = (tok, label) =>
      '<span class="src-pill' + (activeTok === tok ? ' active' : '') +
      '" data-action="' + action + '" data-book="' + esc(tok) + '"' +
      (extraAttrs || '') + '>' + esc(label) + '</span>';
    let html = '<div class="src-pills"><span class="sp-label">来源：</span>' +
      pill('', '全部');
    Array.from(map.keys()).sort((a, b) => map.get(a).localeCompare(map.get(b), 'zh'))
      .forEach(id => { html += pill(id, map.get(id)); });
    if (hasNone) html += pill('none', '未分类');
    html += '</div>';
    return html;
  }

  /** 归属选择卡片：两下拉 + 新建按钮，只做分类、不影响导入文本格式 */
  function renderOwnerPicker() {
    const books = Store.getBooks();
    const book = importState.bookId ? Store.getBookById(importState.bookId) : null;
    const chapters = book && Array.isArray(book.chapters) ? book.chapters : [];

    const bookOpts = '<option value="">未分类（不归入任何书）</option>' +
      books.map(b => '<option value="' + esc(b.id) + '"' +
        (b.id === importState.bookId ? ' selected' : '') + '>' + esc(b.name) + '</option>')
        .join('');

    const chapterOpts = '<option value="">未分章节</option>' +
      chapters.map(c => '<option value="' + esc(c.id) + '"' +
        (c.id === importState.chapterId ? ' selected' : '') + '>' + esc(c.name) + '</option>')
        .join('');

    return '<div class="import-card owner-card">' +
      '<label>🗂 归属书籍 / 章节（先选归属，再复制模板，AI 生成的题目自动归位）</label>' +
      '<div class="owner-row">' +
      '<select id="ownerBook" class="owner-select">' + bookOpts + '</select>' +
      '<select id="ownerChapter" class="owner-select"' + (book ? '' : ' disabled') + '>' +
      chapterOpts + '</select>' +
      '</div>' +
      '<div class="owner-actions">' +
      '<button type="button" class="btn-mini" data-action="owner-new-book">＋ 新建书籍</button>' +
      '<button type="button" class="btn-mini" data-action="owner-new-chapter"' +
      (book ? '' : ' disabled') + '>＋ 新建章节</button>' +
      '<span class="owner-target">当前归属：' +
      esc(scopeText(importState.bookId, importState.chapterId)) + '</span>' +
      '</div></div>';
  }

  function renderImport() {
    const tab = importState.tab;
    normalizeImportScope();
    const tabs = [
      ['question', '导入题目'],
      ['card', '导入卡片'],
      ['json', 'JSON备份'],
      ['manage', '考点管理']
    ];

    const tabBar = '<div class="import-tabs four">' +
      tabs.map(t =>
        '<div class="import-tab' + (tab === t[0] ? ' active' : '') +
        '" data-action="import-tab" data-tab="' + t[0] + '">' + t[1] + '</div>'
      ).join('') + '</div>';

    let bodyHTML = '';

    if (tab === 'question' || tab === 'card') {
      const isQ = tab === 'question';
      /* 题目/卡片各自的 AI 提示词按钮 */
      const promptBtn = isQ
        ? '<button class="btn btn-ghost copy-tpl-btn" data-action="copy-template">' +
        '📋 复制格式模板（发给其他 AI 生成题目）</button>'
        : '<button class="btn btn-ghost copy-tpl-btn" data-action="copy-card-prompt">' +
        '📋 复制格式模板（发给其他 AI 生成卡片）</button>';
      /* 卡片格式提示：补充 JSON 数组与门类可选说明 */
      const fmtHint = isQ ? FMT_QUESTION : (FMT_CARD +
        '\n\n💡 也支持直接粘贴 JSON 数组：[{"name":"～ている","category":"N4文法","summary":"…","lecture":"…","examples":[{"jp":"…","cn":"…"}]}]。' +
        '\n门类可省略（默认归入「自定义语法」）；只有【考点名称】也能导入，用于快速扩充文章精读的识别范围。');

      let quickBox = '';
      if (!isQ) {
        quickBox =
          '<div class="import-card" style="margin-top:14px">' +
          '<label>⚡ 快速录入（每行一个语法点名称，一键批量导入最简卡片）</label>' +
          '<textarea id="quickText" placeholder="～について\n～によって\n～に対して\n～において\n…" style="min-height:120px">' +
          esc(importState.quickText) + '</textarea>' +
          '<div class="fmt-hint">每行写一个考点名称（建议带～接续符号，如 ～について）；' +
          '导入后门类默认为「自定义语法」，摘要/讲解为空，可在首页考点卡片里补充。' +
          '同名卡片会被自动跳过。</div>' +
          '<button class="btn btn-primary" data-action="quick-import" style="margin-top:8px">快速导入</button>' +
          '</div>';
      }

      bodyHTML =
        renderOwnerPicker() +
        promptBtn +
        '<div class="import-card">' +
        '<label>' + (isQ ? '题目文本' : '考点卡片文本') + '</label>' +
        '<textarea id="importText" placeholder="在此粘贴文本…">' +
        esc(importState.text) + '</textarea>' +
        '<div class="fmt-hint">' + fmtHint + '</div>' +
        '</div>' +
        '<button class="btn btn-primary" data-action="import-parse" style="margin-bottom:12px">解析并预览</button>' +
        (importState.preview ? renderPreview(importState.preview, tab) : '') +
        quickBox;
    }

    if (tab === 'json') bodyHTML = renderJSONTab();
    if (tab === 'manage') bodyHTML = renderManageTab();

    setHTML(
      '<header class="page-head"><h1>批量导入</h1>' +
      '<div class="sub">粘贴文本 / JSON 备份 / 按考点管理</div></header>' +
      (importState.message
        ? '<div class="import-success">' + esc(importState.message) + '</div>' : '') +
      tabBar + bodyHTML
    );
  }

  function renderPreview(preview, tab) {
    const valid = preview.filter(p => p.valid);
    const invalid = preview.filter(p => !p.valid);

    /* 题目：按最终归属分组，顶部一眼确认「导入到哪本书的哪个章节、各多少题」 */
    let scopeSummary = '';
    let multiScope = false;
    if (tab === 'question' && valid.length) {
      const groups = new Map();
      valid.forEach(p => {
        const s = p._scope || resolveImportScope(p.data);
        const k = scopeGroupKey(s);
        if (!groups.has(k)) groups.set(k, { s, n: 0 });
        groups.get(k).n++;
      });
      multiScope = groups.size > 1;
      const rows = Array.from(groups.values()).map(g =>
        '<div class="ps-scope-row">📚 ' + esc(scopePreviewText(g.s)) +
        '<em>' + g.n + ' 题</em></div>').join('');
      scopeSummary = '<div class="preview-scopes"><div class="ps-title">📌 本次导入到：</div>' +
        rows + '</div>';
    }

    const optionChipsHTML = (p) => {
      const d = p.data;
      const oc = p._optionCards || {};
      return '<div class="pi-opts">' + ['A', 'B', 'C', 'D'].map(L => {
        const cn = oc[L] || '';
        return '<div class="pi-opt-chip' + (cn ? ' has-card' : ' no-card') + '"' +
          ' data-action="preview-card" data-card="' + esc(cn) + '" title="' +
          (cn ? '点按查看语法点卡片：' + cn : '题库暂无此语法点卡片（可正常导入）') + '">' +
          '<b>' + L + '</b><span class="poc-text">' + esc(d.options[L]) + '</span>' +
          (cn ? '<i class="poc-tag">📇 ' + esc(cn) + '</i>' : '<i class="poc-tag none">暂无卡</i>') +
          '</div>';
      }).join('') + '</div>';
    };

    const itemHTML = tab === 'question'
      ? preview.map(p => {
        const d = p.data;
        const scopeLine = (p.valid && multiScope && p._scope)
          ? '<div class="pi-scope">🗂 将导入到：' + esc(scopePreviewText(p._scope)) + '</div>'
          : '';
        return '<div class="preview-item' + (p.valid ? '' : ' invalid') + '">' +
          '<div class="pi-title">第' + p.index + '块 · ' + esc(d.point || '(无考点)') + '</div>' +
          scopeLine +
          '<div class="pi-line">' + esc(d.stem || '(无题干)') + '</div>' +
          optionChipsHTML(p) +
          '<div class="pi-ans">答案：' + (d.answer || '?') + '　难度：' + esc(d.difficulty) + '</div>' +
          (p.valid ? '' : '<div class="pi-err">⚠ ' + p.errors.join('；') + '</div>') +
          '</div>';
      }).join('')
      : preview.map(p => {
        const d = p.data;
        /* 判断是否已有同名卡片（将被更新而非新增） */
        const exists = d.name && Store.getCards().some(c => c.name === d.name);
        return '<div class="preview-item' + (p.valid ? '' : ' invalid') + '">' +
          '<div class="pi-title">第' + p.index + '块 · ' + esc(d.name || '(无名称)') +
          (p.valid
            ? (exists
              ? '<span style="color:#c98a2a;font-weight:normal;font-size:12px;margin-left:6px">⚠ 已存在：同书章更新该来源，不同书追加新来源（不覆盖原讲解）</span>'
              : '<span style="color:#22a06b;font-weight:normal;font-size:12px;margin-left:6px">✓ 新增</span>')
            : '') + '</div>' +
          '<div class="pi-line">门类：' + esc(d.category || '(无门类)') + '</div>' +
          '<div class="pi-line">摘要：' + esc(d.summary) + '</div>' +
          '<div class="pi-opt">例句 ' + d.examples.length + ' 条' +
          (d.examples.length ? '：' + esc(d.examples[0].jp) : '') + '</div>' +
          (p.valid ? '' : '<div class="pi-err">⚠ ' + p.errors.join('；') + '</div>') +
          '</div>';
      }).join('');

    return '<div class="preview-summary">共解析出 ' + preview.length + ' 条：有效 ' +
      valid.length + ' 条' + (invalid.length ? '，无效 ' + invalid.length + ' 条' : '') + '</div>' +
      scopeSummary +
      itemHTML +
      (valid.length
        ? '<button class="btn btn-primary" data-action="import-confirm">确认导入 ' +
        valid.length + ' 条有效数据</button>'
        : '<button class="btn btn-primary" disabled>没有可导入的有效数据</button>');
  }

  function doParse() {
    const textEl = document.getElementById('importText');
    importState.text = textEl ? textEl.value : '';
    importState.message = '';
    if (!importState.text.trim()) { toast('请先粘贴文本'); return; }

    if (importState.tab === 'card') {
      /* 卡片导入支持直接粘贴 JSON 数组 */
      const trimmed = importState.text.trim();
      if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') {
        try {
          const arr = JSON.parse(trimmed);
          const list = Array.isArray(arr) ? arr : [arr];
          importState.preview = list.map((it, i) => {
            const errors = [];
            const name = it && (it.name || it.point || it.考点名称);
            if (!name) errors.push('缺少 name 字段');
            const examples = (it && Array.isArray(it.examples))
              ? it.examples.map(e => ({
                jp: (e && (e.jp || e.japanese || e.日文)) || '',
                cn: (e && (e.cn || e.chinese || e.中文)) || ''
              })).filter(e => e.jp)
              : [];
            return {
              index: i + 1,
              valid: errors.length === 0,
              errors,
              data: {
                name: name || '',
                category: (it && (it.category || it.门类)) || '自定义语法',
                summary: (it && (it.summary || it.摘要)) || '',
                lecture: (it && (it.lecture || it.讲解)) || '',
                emphasis: (it && (it.emphasis || it.侧重点 || it.重点)) || '',
                examples: examples
              }
            };
          });
          renderImport();
          return;
        } catch (e) {
          /* JSON 解析失败，回退到文本格式解析 */
        }
      }
    }

    const parsed = importState.tab === 'question'
      ? Parser.parseQuestionsText(importState.text)
      : Parser.parseCardsText(importState.text);
    /* 题目：按文本中的【书籍】【章节】（或页面选中归属）解析每道题的落位；
       同时把每个选项对应的语法卡片名定死（显式指定优先，否则宽松匹配一次） */
    if (importState.tab === 'question') {
      parsed.forEach(p => {
        if (!p.valid) return;
        p._scope = resolveImportScope(p.data);
        p._optionCards = resolveOptionCards(p.data);
      });
    }
    importState.preview = parsed;
    renderImport();
  }

  /** 快速录入：每行一个语法点名称 → 最简卡片 */
  function doQuickImport() {
    const el = document.getElementById('quickText');
    importState.quickText = el ? el.value : '';
    const lines = importState.quickText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) { toast('请先输入语法点名称'); return; }
    const existing = new Set(Store.getCards().map(c => c.name));
    const bookId = importState.bookId || '';
    const chapterId = bookId ? (importState.chapterId || '') : '';
    const items = [];
    let skipped = 0;
    lines.forEach(name => {
      if (existing.has(name)) { skipped++; return; }
      existing.add(name);
      items.push({
        id: Store.uid('c'),
        name: name,
        category: '自定义语法',
        summary: '',
        lecture: '',
        examples: [],
        bookId,
        chapterId
      });
    });
    if (!items.length) {
      importState.message = '全部 ' + skipped + ' 个语法点已存在，无需重复导入';
    } else {
      const r = Store.importCards(items);
      importState.message = '快速导入成功：新增卡片 ' + r.added + ' 张' +
        (skipped ? '，跳过已存在 ' + skipped + ' 个' : '') +
        '（归属：' + scopeText(bookId, chapterId) +
        '）。可在首页考点列表里补充讲解，文章精读已能识别这些语法点。';
    }
    importState.quickText = '';
    renderImport();
  }

  function doConfirmImport() {
    const tab = importState.tab;
    const valid = importState.preview.filter(p => p.valid);
    const bookId = importState.bookId || '';
    const chapterId = bookId ? (importState.chapterId || '') : '';

    if (tab === 'question') {
      /* 第一遍：把每题的归属落成真实 bookId/chapterId（文本写了但库里没有的自动新建） */
      const madeBooks = new Map(), madeChapters = new Map();
      const materialize = s => {
        let book = s.book;
        if (!book && s.autoBook && s.bookName) {
          const key = s.bookName.trim().toLowerCase();
          if (!madeBooks.has(key)) madeBooks.set(key, Store.addBook(s.bookName.trim()));
          book = madeBooks.get(key) || findBookByName(s.bookName);
        }
        if (!book) return { bookId: '', chapterId: '' };
        let chapterId = s.chapter ? s.chapter.id : '';
        if (!chapterId && s.autoCh && s.chapterName) {
          const key = book.id + '|' + s.chapterName.trim().toLowerCase();
          if (!madeChapters.has(key)) {
            madeChapters.set(key, Store.addChapter(book.id, s.chapterName.trim()));
          }
          const ch = madeChapters.get(key) || findChapterByName(book, s.chapterName);
          chapterId = ch ? ch.id : '';
        }
        return { bookId: book.id, chapterId };
      };

      /* 去重口径：主考点 + 来源书章 + 题干；同一章节的同题干题跳过，不同书各自保留 */
      const dupSet = new Set(
        Store.getQuestions().map(q =>
          Store.questionDedupKey(q.point, q.stem, q.bookId, q.chapterId))
      );
      const fresh = [];
      let dup = 0;
      valid.forEach(p => {
        const target = materialize(p._scope || resolveImportScope(p.data));
        const key = Store.questionDedupKey(p.data.point, p.data.stem,
          target.bookId, target.chapterId);
        if (dupSet.has(key)) { dup++; return; }
        dupSet.add(key);
        /* 归属字段不写进题目记录；optionCards 用解析时定死的名称指针（只存名） */
        const { book: _b, chapter: _c, ...qdata } = p.data;
        fresh.push({
          ...qdata,
          id: Store.uid('q'),
          bookId: target.bookId,
          chapterId: target.chapterId,
          optionCards: p._optionCards || resolveOptionCards(p.data)
        });
      });

      /* 逐条入库：addQuestionToPoint 会自动给对应卡片追加当前书章来源。
         先记录入库前各考点在各自书章是否已有卡片/来源，用于结果统计。 */
      const beforeState = new Map();
      fresh.forEach(data => {
        if (!data.bookId) return;
        const key = data.point + '|' + data.bookId + '|' + data.chapterId;
        if (beforeState.has(key)) return;
        const c = Store.getCardByName(data.point);
        beforeState.set(key, c
          ? { card: true, has: Store.cardHasScope(c, data.bookId, data.chapterId) }
          : { card: false, has: false });
      });
      let attached = 0;
      const attachedKeys = new Set();
      const noCardKeys = new Set();
      fresh.forEach(data => {
        const r = Store.addQuestionToPoint(data.point, data);
        if (r && r.id && data.bookId) {
          const key = data.point + '|' + data.bookId + '|' + data.chapterId;
          const b = beforeState.get(key);
          if (b && !b.card) noCardKeys.add(key);
          else if (b && b.card && !b.has && !attachedKeys.has(key)) {
            attached++; attachedKeys.add(key);
          }
        }
      });

      /* 归属汇总：实际落到哪些书章各多少题 */
      const groups = new Map();
      fresh.forEach(data => {
        const k = data.bookId + '|' + data.chapterId;
        groups.set(k, (groups.get(k) || 0) + 1);
      });
      const scopeLines = Array.from(groups.entries()).map(([k, n]) => {
        const [bid, cid] = k.split('|');
        return scopeText(bid, cid) + '（' + n + ' 题）';
      }).join('、');

      importState.message = '导入成功：新增 ' + fresh.length + ' 题' +
        (dup ? '，同章节重复跳过 ' + dup + ' 题' : '') +
        '（归属：' + (scopeLines || '未分类') + '）' +
        (madeBooks.size ? '；自动新建书籍 ' + madeBooks.size + ' 本' : '') +
        (madeChapters.size ? '、章节 ' + madeChapters.size + ' 个' : '') +
        (attached ? '；已自动为 ' + attached + ' 个考点的卡片追加本来源' : '') +
        (noCardKeys.size ? '；另有 ' + noCardKeys.size +
          ' 个考点还没有卡片（章节页显示为灰色词条，可稍后补卡片）' : '');
    } else {
      const items = valid.map(p => ({ ...p.data, id: Store.uid('c'), bookId, chapterId }));
      const r = Store.importCards(items);
      /* 反向补全：题目先到、卡片后到时，按已有题目的书章归属给新卡片补来源 */
      const es = Store.ensureCardSourcesForQuestions(Store.getQuestions());
      importState.message = '导入成功：新增卡片 ' + r.added + ' 张' +
        (r.appended ? '，为同名卡片追加来源 ' + r.appended + ' 个' : '') +
        (r.updated ? '，更新同书来源 ' + r.updated + ' 个' : '') +
        (es.attached ? '；另根据已有题目为卡片补挂来源 ' + es.attached + ' 个' : '') +
        '（归属：' + scopeText(bookId, chapterId) +
        '）。同名考点的不同书讲解会各自独立保留，不会互相覆盖。';
    }

    importState.text = '';
    importState.preview = null;
    renderImport();
  }

  /* ---------- JSON 备份标签 ---------- */

  function renderJSONTab() {
    return '<button class="btn btn-primary" data-action="export-json" style="margin-bottom:14px">' +
      '📤 导出全部数据（JSON 文件）</button>' +
      '<div class="import-card">' +
      '<label>从 JSON 备份文件恢复</label>' +
      '<input type="file" id="jsonFile" accept=".json,application/json">' +
      (pickedBundle
        ? '<div class="fmt-hint ok">已读取备份：' + pickedBundle.questions.length +
        ' 题、' + pickedBundle.cards.length + ' 张卡片，请选择导入方式。</div>'
        : '<div class="fmt-hint">备份包含：题目、考点卡片、完成状态、错题、疑难、考点统计。\n' +
        '合并导入：题目按 id 去重，其余数据取并集；\n覆盖导入：清空现有数据后完全还原。</div>') +
      '</div>' +
      '<div class="btn-row">' +
      '<button class="btn btn-ghost" data-action="import-json" data-mode="merge">合并导入</button>' +
      '<button class="btn btn-primary" data-action="import-json" data-mode="replace">覆盖导入</button>' +
      '</div>' +
      (importState.message
        ? '<div class="json-result-msg">' + esc(importState.message) + '</div>' : '');
  }

  function doExport() {
    const bundle = Store.exportBundle();
    const stamp = new Date().toISOString().slice(0, 10);
    download('jp-grammar-backup-' + stamp + '.json',
      JSON.stringify(bundle, null, 2), 'application/json');
    toast('已导出 JSON 文件');
  }

  let pickedBundle = null;

  function doImportJSON(mode) {
    if (!pickedBundle) { toast('请先选择备份文件'); return; }
    if (mode === 'replace' &&
      !confirm('覆盖导入会清空当前全部数据并还原为备份内容，确定继续？')) return;
    try {
      const r = Store.importBundle(pickedBundle, mode);
      importState.message = r.replaced
        ? '已覆盖还原：' + r.questions + ' 题（多来源信息已保留）'
        : '合并完成：新增题目 ' + r.questions + ' 题' +
        (r.questionsDup ? '，重复跳过 ' + r.questionsDup + ' 题' : '') +
        '；卡片新增 ' + r.cardsAdded + ' / 追加来源 ' +
        (r.cardsAppended || 0) + ' / 更新来源 ' + r.cardsUpdated +
        (r.cardSourcesAttached ? ' / 题目自动补挂来源 ' + r.cardSourcesAttached : '');
      pickedBundle = null;
      const fileEl = document.getElementById('jsonFile');
      if (fileEl) fileEl.value = '';
      renderImport();
    } catch (e) {
      toast(e.message || '导入失败');
    }
  }

  /* ---------- 考点管理标签 ---------- */

  function renderManageTab() {
    const qs = Store.getQuestions();
    const map = {};
    qs.forEach(q => {
      if (!map[q.point]) map[q.point] = { point: q.point, category: q.category, count: 0 };
      map[q.point].count++;
    });
    const groups = Object.values(map)
      .sort((a, b) => b.count - a.count || a.point.localeCompare(b.point, 'zh'));

    if (!groups.length) {
      return '<div class="empty"><span class="e-ico">🗂</span>' +
        '<div class="e-txt">题库是空的，暂无可管理的考点</div></div>';
    }

    return '<div class="fmt-hint" style="margin-bottom:12px">共 ' + groups.length +
      ' 个考点、' + qs.length + ' 道题。删除操作会同时清理对应的错题与疑难记录。</div>' +
      groups.map(g =>
        '<div class="manage-item">' +
        '<div class="mi-info"><div class="mi-name">' + esc(g.point) + '</div>' +
        '<div class="mi-sub">' + esc(g.category) + ' · ' + g.count + ' 题</div></div>' +
        '<div class="mi-btns">' +
        '<button class="btn-mini danger" data-action="mgmt-delete" data-name="' +
        esc(g.point) + '">删除全部</button>' +
        '<button class="btn-mini" data-action="mgmt-keep" data-name="' +
        esc(g.point) + '">只保留它</button>' +
        '</div>' +
        '</div>').join('') +
      (importState.message
        ? '<div class="json-result-msg">' + esc(importState.message) + '</div>' : '');
  }

  function mgmtDelete(name) {
    if (!confirm('确定删除「' + name + '」的全部题目？此操作不可恢复。')) return;
    const n = Store.deleteQuestionsByPoint(name);
    importState.message = '已删除「' + name + '」题目 ' + n + ' 道';
    renderImport();
  }

  function mgmtKeep(name) {
    if (!confirm('只保留「' + name + '」，其余考点的题目将全部删除，确定？')) return;
    const n = Store.keepOnlyPoint(name);
    importState.message = '已保留「' + name + '」，删除其他考点题目 ' + n + ' 道';
    renderImport();
  }

  /* ================= 视图：书架（书籍 → 章节） ================= */

  /** 路由用：'' 与 'none' 互转 */
  function scopeFromRoute(v) { return v === 'none' ? '' : (v || ''); }
  function scopeToRoute(v) { return v || 'none'; }

  function renderBookshelf() {
    const books = Store.getBooks();
    /* 阅读理解同步进错题本的题（reading:true）不属于语法书架，不计入 */
    const qs = Store.getQuestions().filter(q => !q.reading);
    const cs = Store.getCards();

    /* 未分类（没有 bookId 的题目/卡片；卡片按多来源归属判断） */
    const noneQ = qs.filter(q => !q.bookId).length;
    const noneC = cs.filter(c => Store.cardHasScope(c, '', '')).length;

    const noneRow = (noneQ || noneC)
      ? '<div class="shelf-book uncategorized">' +
      '<div class="sb-main" data-action="shelf-open" data-book="none" data-chapter="none">' +
      '<span class="sb-caret">📂</span>' +
      '<div class="sb-text"><div class="sb-name">未分类</div>' +
      '<div class="sb-sub">' + noneQ + ' 题 · ' + noneC + ' 张卡片</div></div>' +
      '<span class="sb-go">›</span></div></div>'
      : '';

    const booksHTML = books.map(book => {
      const bq = qs.filter(q => q.bookId === book.id);
      /* 卡片只要有一个来源属于本书即计入（同一卡多来源不重复计本数） */
      const bc = cs.filter(c =>
        Store.cardScopes(c).some(sc => sc.bookId === book.id));
      const chapters = Array.isArray(book.chapters) ? book.chapters : [];
      const looseQ = bq.filter(q => !q.chapterId).length;
      const looseC = bc.filter(c =>
        Store.cardScopes(c).some(sc => sc.bookId === book.id && !sc.chapterId)).length;
      const open = shelfExpanded === book.id;

      /* 单元行：第一行 名称+题数（点按进章节）；第二行 卡片刷题进度；
         改名/删除收进「⋯」菜单，不挤占章节名显示区域 */
      const chRow = (chId, name, cq, isLoose) => {
        const p = Store.chapterCardProgress(book.id, chId || '');
        const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
        const progHTML = p.total
          ? '<div class="sc-progress"><div class="scp-bar"><i style="width:' + pct + '%"></i></div>' +
            '<div class="scp-txt"><span class="fresh">未刷 ' + p.fresh + '</span>' +
            '<span class="half">半截 ' + p.half + '</span>' +
            '<span class="done">刷完 ' + p.done + '</span>' +
            '<em>共 ' + p.total + ' 卡</em></div></div>'
          : '<div class="sc-progress scp-empty">本单元还没有卡片</div>';
        const moreHTML = isLoose ? '' :
          '<details class="sb-more"><summary>⋯</summary>' +
          '<button class="btn-mini" data-action="shelf-rename-chapter" data-book="' +
          esc(book.id) + '" data-id="' + esc(chId) + '">改名</button>' +
          '<button class="btn-mini danger" data-action="shelf-del-chapter" data-book="' +
          esc(book.id) + '" data-id="' + esc(chId) + '">删除</button>' +
          '</details>';
        return '<div class="sb-chapter">' +
          '<div class="sc-main" data-action="shelf-open" data-book="' + esc(book.id) +
          '" data-chapter="' + esc(chId || 'none') + '">' +
          '<span class="sc-ico">📄</span>' +
          '<span class="sc-body"><span class="sc-name">' + esc(name) + '</span>' +
          '<span class="sc-count">' + cq + ' 题</span></span>' +
          '<span class="sb-go">›</span></div>' +
          progHTML + moreHTML +
          '</div>';
      };

      const chaptersHTML = chapters.map(ch =>
        chRow(ch.id, ch.name, bq.filter(q => q.chapterId === ch.id).length, false)
      ).join('');

      const looseRow = (looseQ || looseC) ? chRow('', '未分章节', looseQ, true) : '';

      return '<div class="shelf-book">' +
        '<div class="sb-head">' +
        '<div class="sb-main" data-action="shelf-toggle" data-id="' + esc(book.id) + '">' +
        '<span class="sb-caret">' + (open ? '▾' : '▸') + '</span>' +
        '<div class="sb-text"><div class="sb-name">📖 ' + esc(book.name) + '</div>' +
        '<div class="sb-sub">' + chapters.length + ' 个章节 · ' +
        bq.length + ' 题 · ' + bc.length + ' 张卡片</div></div>' +
        '<span class="sb-go" data-action="shelf-toggle" data-id="' + esc(book.id) + '">›</span>' +
        '</div>' +
        '<div class="sb-btns">' +
        '<button class="btn-mini" data-action="shelf-add-chapter" data-book="' +
        esc(book.id) + '">＋章节</button>' +
        '<button class="btn-mini" data-action="shelf-rename-book" data-id="' +
        esc(book.id) + '">改名</button>' +
        '<button class="btn-mini danger" data-action="shelf-del-book" data-id="' +
        esc(book.id) + '">删除</button>' +
        '</div></div>' +
        '<div class="sb-chapters"' + (open ? '' : ' hidden') + '>' +
        chaptersHTML + looseRow +
        (!chapters.length && !looseRow
          ? '<div class="sc-empty">还没有章节，点「＋章节」新建，或导入时归入本书</div>' : '') +
        '</div></div>';
    }).join('');

    setHTML(
      '<header class="page-head"><h1>书架</h1>' +
      '<div class="sub">按「书籍 → 章节」分层管理题目与卡片</div></header>' +
      '<button class="btn btn-primary shelf-new-btn" data-action="shelf-new-book">＋ 新建书籍</button>' +
      '<div class="fmt-hint" style="margin-bottom:12px">点击书籍可展开章节；' +
      '删除书籍会删除其下章节与题目，但考点卡片（主考点）会保留，仅摘除来自该书的来源。</div>' +
      ((noneRow || booksHTML)
        ? noneRow + booksHTML
        : '<div class="empty"><span class="e-ico">📚</span>' +
        '<div class="e-txt">书架还是空的<br>新建一本书，或在导入时选择归属书籍</div>' +
        '<button class="btn btn-primary" data-action="shelf-new-book">＋ 新建书籍</button>' +
        '<a class="btn btn-ghost" href="#/import">去导入题目/卡片</a></div>')
    );
  }

  /* ================= 视图：综合练习（书籍 → 目录 → 直接刷题） ================= */

  let practiceExpanded = '';

  /** 练一整本书（全部题随机） */
  function startBookPractice(bookId) {
    const qs = Store.getQuestions().filter(q => !q.reading && q.bookId === bookId);
    if (!qs.length) { toast('这本书还没有题目'); return; }
    const book = Store.getBookById(bookId);
    startSession('chapter', '《' + (book ? book.name : '未知') + '》随机练习', qs);
    if (session) { session.bookId = bookId; session.chapterId = ''; }
  }

  function renderPractice() {
    const qs = Store.getQuestions().filter(q => !q.reading && q.bookId);
    const total = qs.length;
    const books = Store.getBooks()
      .map(b => ({ b, list: qs.filter(q => q.bookId === b.id) }))
      .filter(x => x.list.length);
    const uncategorized = Store.getQuestions().filter(q => !q.reading && !q.bookId).length;

    const booksHTML = books.map(({ b, list }) => {
      const chapters = Array.isArray(b.chapters) ? b.chapters : [];
      const open = practiceExpanded === b.id;
      const loose = list.filter(q => !q.chapterId).length;

      const chRow = (cid, name, n) =>
        n ? '<div class="pr-chapter" data-action="practice-chapter" data-book="' +
          esc(b.id) + '" data-chapter="' + esc(cid) + '">' +
          '<span class="sc-ico">📄</span><span class="sc-name">' + esc(name) + '</span>' +
          '<span class="sc-count">' + n + ' 题</span><span class="sb-go">▶</span></div>' : '';

      const chaptersHTML = chapters
        .map(ch => chRow(ch.id, ch.name, list.filter(q => q.chapterId === ch.id).length))
        .join('');
      const looseHTML = loose ? chRow('', '未分章节', loose) : '';

      return '<div class="shelf-book pr-book">' +
        '<div class="sb-head">' +
        '<div class="sb-main" data-action="practice-toggle" data-id="' + esc(b.id) + '">' +
        '<span class="sb-caret">' + (open ? '▾' : '▸') + '</span>' +
        '<div class="sb-text"><div class="sb-name">📖 ' + esc(b.name) + '</div>' +
        '<div class="sb-sub">' + list.length + ' 题</div></div>' +
        '<span class="sb-go">›</span></div>' +
        '<div class="sb-btns"><button class="btn-mini" data-action="practice-book" data-id="' +
        esc(b.id) + '">练整本</button></div></div>' +
        '<div class="sb-chapters"' + (open ? '' : ' hidden') + '>' +
        chaptersHTML + looseHTML + '</div></div>';
    }).join('');

    const uncatRow = uncategorized
      ? '<div class="shelf-book uncategorized"><div class="pr-chapter" ' +
        'data-action="practice-uncat">' +
        '<span class="sc-ico">📂</span><span class="sc-name">未分类题目</span>' +
        '<span class="sc-count">' + uncategorized + ' 题</span>' +
        '<span class="sb-go">▶</span></div></div>' : '';

    setHTML(
      '<header class="page-head"><h1>综合练习</h1>' +
      '<div class="sub">选一本书、展开目录，点章节直接开练</div></header>' +
      '<button class="btn btn-primary shelf-new-btn" data-action="practice-random"' +
      (total ? '' : ' disabled') + '>🎲 随机练习全部（' + total + ' 题）</button>' +
      '<div class="fmt-hint" style="margin-bottom:12px">这里只有已归入语法练习书章节的题目，' +
      '不涉及首页考点卡片；做题时点选项右侧的 📇 可查看该选项对应的语法点卡片，' +
      '可用顶部「学习模式 / 训练模式」开关控制作答前能否查看。</div>' +
      (booksHTML || uncatRow ||
        '<div class="empty"><span class="e-ico">📚</span>' +
        '<div class="e-txt">还没有练习书题目<br>到「批量导入」导入语法书题目，并归入书籍章节</div>' +
        '<a class="btn btn-primary" href="#/import">去导入题目</a></div>') +
      (booksHTML && uncatRow ? uncatRow : '')
    );
  }

  /* ---------- 章节详情：卡片与题目 ---------- */

  function renderChapter(bookId, chapterId) {
    const book = bookId ? Store.getBookById(bookId) : null;
    if (bookId && !book) {
      setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
        '<div class="e-txt">未找到该书籍（可能已被删除）</div>' +
        '<a class="btn btn-primary back-link" href="#/books">‹ 返回</a></div>');
      return;
    }
    let chapter = null;
    if (book && chapterId) {
      chapter = (book.chapters || []).find(c => c.id === chapterId) || null;
      if (!chapter) {
        setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
          '<div class="e-txt">未找到该章节（可能已被删除）</div>' +
          '<a class="btn btn-primary back-link" href="#/books">‹ 返回</a></div>');
        return;
      }
    }

    const inScope = o => (o.bookId || '') === bookId && (o.chapterId || '') === chapterId;
    const qs = Store.getQuestions().filter(q => !q.reading && inScope(q));
    /* 卡片按多来源归属：任一来源属于本书章即显示 */
    const cards = Store.getCards().filter(c => Store.cardHasScope(c, bookId, chapterId));

    const title = !bookId ? '未分类' : book.name + ' · ' + (chapter ? chapter.name : '未分章节');

    /* 以考点名为线索，合并本章卡片与题目进行展示 */
    const pointSet = new Set();
    cards.forEach(c => c.name && pointSet.add(c.name));
    qs.forEach(q => q.point && pointSet.add(q.point));
    const points = Array.from(pointSet)
      .sort((a, b) => a.localeCompare(b, 'zh'));

    const scopeAttrs = ' data-book="' + esc(scopeFromRoute(bookId)) +
      '" data-chapter="' + esc(scopeFromRoute(chapterId)) + '"';
    const rows = points.map(name => {
      /* 章节页语境：卡片在「本章来源」存在才算有卡；
         卡虽存在但本章来源已摘除时，按“只有题目”的灰色词条处理 */
      const globalCard = Store.getCardByName(name);
      const hasCard = globalCard && Store.cardHasScope(globalCard, bookId, chapterId)
        ? globalCard : null;
      const count = qs.filter(q => q.point === name).length;
      const main = hasCard
        ? '<a class="chp-point" href="#/card/' + encodeURIComponent(name) + '">' +
        '<span class="cp-name">' + esc(name) + '</span>' +
        '<span class="sb-go">›</span></a>'
        : '<div class="chp-point no-card"><span class="cp-name">' + esc(name) +
        '</span><span class="badge todo">缺卡片</span></div>';
      /* 有卡片：删除=移出本章（只摘本章节来源）；无卡片灰条：可删本章题目 */
      const delBtn = hasCard
        ? '<button class="btn-mini danger" data-action="ch-detach-card"' +
        ' data-name="' + esc(name) + '"' + scopeAttrs + '>移出本章</button>'
        : '<button class="btn-mini danger" data-action="ch-del-point-qs"' +
        ' data-name="' + esc(name) + '"' + scopeAttrs + '>删除题目</button>';
      return '<div class="manage-item chapter-point' + (hasCard ? '' : ' no-card') + '">' +
        '<div class="mi-info"><div class="mi-name">' + main + '</div>' +
        '<div class="mi-sub">' + (hasCard ? esc(hasCard.category) : '暂无卡片') +
        ' · ' + count + ' 题</div></div>' +
        '<div class="mi-btns">' +
        (count ? '<button class="btn-mini" data-action="start-point" data-name="' +
          esc(name) + '">刷题</button>' : '') +
        delBtn +
        '</div></div>';
    }).join('');

    setHTML(
      '<a class="back-link" href="#/books">‹ 返回</a>' +
      '<header class="page-head"><h1>📖 ' + esc(title) + '</h1>' +
      '<div class="sub">' + qs.length + ' 题 · ' + cards.length + ' 张卡片</div></header>' +
      (qs.length
        ? '<button class="btn btn-primary" data-action="chapter-practice" data-book="' +
        esc(scopeToRoute(bookId)) + '" data-chapter="' + esc(scopeToRoute(chapterId)) +
        '" style="margin-bottom:14px">练习本章全部题目（' + qs.length + ' 题）</button>'
        : '') +
      (points.length
        ? '<div class="section-title">考点 <span class="count">点击查看卡片详情</span></div>' + rows
        : '<div class="empty"><span class="e-ico">🗂</span>' +
        '<div class="e-txt">本章还没有题目或卡片<br>到「导入」页粘贴内容，并选择归属到本章</div>' +
        '<a class="btn btn-primary" href="#/import">去导入</a>' +
        '<a class="btn btn-ghost back-link" href="#/books">‹ 返回</a></div>')
    );
  }

  /** 章节整体练习 */
  function startChapter(bookId, chapterId) {
    const qs = Store.getQuestions()
      .filter(q => (q.bookId || '') === bookId && (q.chapterId || '') === chapterId);
    if (!qs.length) { toast('本章还没有题目'); return; }
    startSession('chapter', scopeText(bookId, chapterId), qs);
    if (session) { session.bookId = bookId; session.chapterId = chapterId; }
  }

  /**
   * 章节页「移出本章」：按来源删除，不删卡片本身。
   * 删除前列出该考点全部来源与影响；最后一个来源时才删除整张卡片（题目保留）。
   */
  function chapterDetachCard(name, bookRoute, chapterRoute) {
    const bookId = scopeFromRoute(bookRoute);
    const chapterId = scopeFromRoute(chapterRoute);
    const card = Store.getCardByName(name);
    if (!card) { toast('卡片不存在'); renderChapter(bookId, chapterId); return; }
    const scopes = Store.cardScopes(card);
    const key = (bookId || '') + '|' + (chapterId || '');
    const matched = scopes.filter(s =>
      ((s.bookId || '') + '|' + (s.chapterId || '')) === key);
    if (!matched.length) {
      toast('这张卡片没有归属本章的来源');
      renderChapter(bookId, chapterId);
      return;
    }
    const scopeLines = scopes.map((s, i) =>
      (i + 1) + '. ' + scopeText(s.bookId, s.chapterId)).join('\n');
    const targetText = scopeText(bookId, chapterId);
    let msg;
    if (scopes.length <= 1) {
      msg = '⚠️ 这是「' + name + '」唯一的来源：\n' + scopeLines +
        '\n\n移出后将删除整张卡片（讲解、例句一并删除）；\n' +
        '本章题目会保留，该词条变为「缺卡片」灰色状态，以后可重新补卡片。\n\n确定移出本章？';
    } else {
      msg = '「' + name + '」共有 ' + scopes.length + ' 个来源：\n' + scopeLines +
        '\n\n本次只移除来源「' + targetText + '」，\n' +
        '其他 ' + (scopes.length - matched.length) +
        ' 个来源（其他章节/书籍）的卡片内容不受影响。\n\n确定移出本章？';
    }
    if (!confirm(msg)) return;
    const r = Store.deleteCardScope(name, bookId, chapterId);
    if (!r || r.error) { toast('移除失败：来源不存在'); renderChapter(bookId, chapterId); return; }
    if (r.removed === 'card') {
      toast('已删除整张卡片（这是最后一个来源），本章题目保留');
    } else {
      toast('已移出本章，卡片保留（仍有 ' + r.remaining + ' 个来源）');
    }
    renderChapter(bookId, chapterId);
  }

  /** 章节页灰色词条「删除题目」：只删该考点本章来源的题，其他章节同名题不动 */
  function chapterDeletePointQuestions(name, bookRoute, chapterRoute) {
    const bookId = scopeFromRoute(bookRoute);
    const chapterId = scopeFromRoute(chapterRoute);
    const n = Store.getQuestions().filter(q => q.point === name &&
      (q.bookId || '') === bookId && (q.chapterId || '') === chapterId).length;
    if (!n) { toast('本章该考点下没有题目'); renderChapter(bookId, chapterId); return; }
    if (!confirm('删除「' + name + '」在「' + scopeText(bookId, chapterId) +
      '」下的 ' + n + ' 道题目？\n只删除本来源的题目（含错题/疑难记录），' +
      '其他章节或书籍中的同名题目不受影响。')) return;
    const removed = Store.deleteQuestionsByPointScope(name, bookId, chapterId);
    toast('已删除本章题目 ' + removed + ' 道');
    renderChapter(bookId, chapterId);
  }

  /* ---------- 书架操作 ---------- */

  function shelfNewBook() {
    const name = prompt('新书籍名称：');
    if (name == null) return;
    const b = Store.addBook(name);
    if (!b) { toast('书籍名称为空或与现有书籍重名'); return; }
    shelfExpanded = b.id;
    toast('已新建书籍');
    renderBookshelf();
  }

  function shelfRenameBook(id) {
    const book = Store.getBookById(id);
    if (!book) return;
    const name = prompt('修改书籍名称：', book.name);
    if (name == null) return;
    if (!Store.renameBook(id, name)) { toast('名称为空或与其他书籍重名'); return; }
    renderBookshelf();
  }

  function shelfDeleteBook(id) {
    const book = Store.getBookById(id);
    if (!book) return;
    const qn = Store.getQuestions().filter(q => q.bookId === id).length;
    const cn = Store.getCards().filter(c =>
      Store.cardScopes(c).some(sc => sc.bookId === id)).length;
    const chn = (book.chapters || []).length;
    if (!confirm('确定删除《' + book.name + '》？\n将删除 ' + chn +
      ' 个章节、' + qn + ' 道题目；' + cn +
      ' 张考点卡片会保留（主考点不删），仅摘除来自本书的来源。')) return;
    const r = Store.deleteBook(id);
    if (shelfExpanded === id) shelfExpanded = null;
    toast('已删除《' + book.name + '》：删除题目 ' + r.questions +
      ' 道，' + r.cards + ' 张卡片已摘除该书来源');
    renderBookshelf();
  }

  function shelfAddChapter(bookId) {
    const book = Store.getBookById(bookId);
    if (!book) return;
    const name = prompt('在《' + book.name + '》下新建章节：');
    if (name == null) return;
    const ch = Store.addChapter(bookId, name);
    if (!ch) { toast('章节名称为空或与本书已有章节重名'); return; }
    shelfExpanded = bookId;
    toast('已新建章节');
    renderBookshelf();
  }

  function shelfRenameChapter(bookId, chapterId) {
    const book = Store.getBookById(bookId);
    const ch = book && (book.chapters || []).find(c => c.id === chapterId);
    if (!ch) return;
    const name = prompt('修改章节名称：', ch.name);
    if (name == null) return;
    if (!Store.renameChapter(bookId, chapterId, name)) {
      toast('名称为空或与同书其他章节重名');
      return;
    }
    renderBookshelf();
  }

  function shelfDeleteChapter(bookId, chapterId) {
    const book = Store.getBookById(bookId);
    const ch = book && (book.chapters || []).find(c => c.id === chapterId);
    if (!ch) return;
    const qn = Store.getQuestions()
      .filter(q => q.bookId === bookId && q.chapterId === chapterId).length;
    const cn = Store.getCards()
      .filter(c => Store.cardHasScope(c, bookId, chapterId)).length;
    if (!confirm('确定删除《' + book.name + '》的章节「' + ch.name + '」？\n将删除 ' +
      qn + ' 道题目；' + cn +
      ' 张考点卡片会保留，仅摘除来自本章节的来源。')) return;
    const r = Store.deleteChapter(bookId, chapterId);
    toast('已删除章节：删除题目 ' + r.questions + ' 道，' + r.cards + ' 张卡片已摘除来源');
    renderBookshelf();
  }

  /* ================= 路由与导航 ================= */

  function updateTabs(route) {
    const map = {
      home: 'home', mixed: 'mixed', wrong: 'wrong', marked: 'wrong',
      import: 'import', articles: 'home', article: 'home',
      books: 'home', chapter: 'home', reading: 'home'
    };
    const active = map[route] || 'home';
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === active);
    });
  }

  function refreshBadge() {
    const n = Store.wrongCount();
    wrongBadge.textContent = String(n);
    wrongBadge.hidden = n === 0;
  }

  function router() {
    closeCardPop();
    const parts = (location.hash || '#/home').slice(2).split('/').map(decodeURIComponent);
    const route = parts[0] || 'home';
    updateTabs(route);
    switch (route) {
      case 'home': renderHome(); break;
      case 'card': renderCard(parts[1]); break;
      case 'quiz': renderQuiz(); break;
      case 'mixed': renderPractice(); break;
      case 'wrong': wrongPageTab = 'wrong'; renderWrongPage(); break;
      case 'marked': wrongPageTab = 'marked'; renderWrongPage(); break;
      case 'import': renderImport(); break;
      case 'articles': ArticlePage.renderList(); break;
      case 'article':
        if (parts[1] === 'new') ArticlePage.renderNew();
        else ArticlePage.renderDetail(parts[1]);
        break;
      case 'games': window.GamesPage.renderHub(); break;
      case 'boss':
        if (parts[1]) window.GamesPage.startBoss(parts[1]);
        else window.GamesPage.renderBossList();
        break;
      case 'bomb': window.GamesPage.renderBomb(parts[1] ? Number(parts[1]) : null); break;
      case 'bomb-import': window.GamesPage.renderBombImport(); break;
      case 'bomb-manage': window.GamesPage.renderBombManage(); break;
      case 'books': renderBookshelf(); break;
      case 'chapter':
        renderChapter(scopeFromRoute(parts[1]), scopeFromRoute(parts[2]));
        break;
      case 'reading': window.ReadingPage.dispatch(parts); break;
      default: renderHome();
    }
    refreshBadge();
  }

  /* ---------- 全局事件委托 ---------- */
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    switch (action) {
      case 'start-point': startPoint(el.dataset.name); break;
      /* 卡片详情：多来源 + 来源筛选刷题 */
      case 'card-start': startPoint(currentCardName, cardSourceFilter); break;
      case 'card-src':
        cardSourceFilter = (el.dataset.book === undefined) ? '' : el.dataset.book;
        renderCard(currentCardName);
        break;
      case 'src-add': openSourceEdit(''); break;
      case 'src-edit': openSourceEdit(el.dataset.sid); break;
      case 'src-save': saveSourceEdit(el.dataset.sid || ''); break;
      case 'src-del': deleteSourceById(el.dataset.sid); break;
      /* 错题/疑难：按来源重练 */
      case 'wrong-src': startWrongPractice(el.dataset.book); break;
      case 'marked-src': startMarkedPractice(el.dataset.book); break;
      case 'quiz-option': answerCurrent(Number(el.dataset.idx)); break;
      /* 选项 → 语法点卡片（学习模式随时可看；训练模式作答后才可看） */
      case 'quiz-opt-card': {
        if (!session || session.finished) break;
        const it = session.items[session.index];
        if (session.learnMode !== 'learn' && it.chosen === null) {
          toast('训练模式：作答后才能查看选项的语法点卡片');
          break;
        }
        const name = ((it.q.optionCards || {})[el.dataset.orig]) || '';
        openCardPop(name, e.clientX, e.clientY);
        break;
      }
      case 'set-learn':
        if (session && !session.finished) {
          session.learnMode = el.dataset.mode === 'train' ? 'train' : 'learn';
          setLearnModePref(session.learnMode);
          renderQuiz();
        }
        break;
      case 'mark-uncertain': toggleUncertain(); break;
      case 'set-feedback': setFeedback(el.dataset.mode); break;
      case 'quiz-next': nextQuestion(); break;
      case 'quiz-restart': restartSession(); break;
      case 'review-start': session.reviewing = true; session.index = 0; renderQuiz(); break;
      case 'review-prev': session.index--; renderQuiz(); break;
      case 'review-next': session.index++; renderQuiz(); break;
      case 'review-back': session.reviewing = false; renderQuiz(); break;
      case 'remove-wrong':
        Store.removeWrong(el.dataset.id);
        toast('已移出错题本');
        renderWrongPage();
        refreshBadge();
        break;
      case 'remove-marked':
        Store.removeMarked(el.dataset.id);
        toast('已移出疑难队列');
        renderWrongPage();
        break;
      case 'wrong-practice': startWrongPractice(); break;
      case 'marked-practice': startMarkedPractice(); break;
      case 'weak-practice': startPoint(el.dataset.name); break;
      case 'similar-q': startSimilar(el.dataset.point, el.dataset.id); break;
      case 'wrongpage-tab': wrongPageTab = el.dataset.tab; renderWrongPage(); break;
      case 'import-tab':
        importState.tab = el.dataset.tab;
        importState.preview = null;
        importState.message = '';
        renderImport();
        break;
      case 'copy-template':
        normalizeImportScope();
        if (!importState.bookId || !importState.chapterId) {
          toast('请先选好归属书籍和章节');
          break;
        }
        copyText(questionPromptText()).then(
          () => toast('已复制，提示词已带上《' +
            Store.getBookById(importState.bookId).name + '》的归属'),
          () => toast('复制失败，请长按手动选择')
        );
        break;
      case 'copy-card-prompt':
        copyText(TEMPLATE_FOR_CARD).then(
          () => toast('已复制，去其他 AI 生成卡片吧'),
          () => toast('复制失败，请长按手动选择')
        );
        break;
      case 'quick-import': doQuickImport(); break;
      case 'import-parse': doParse(); break;
      /* 导入预览：点选项查看它绑定的语法点卡片（只查看，不会把练习题加进卡片池） */
      case 'preview-card':
        openCardPop(el.dataset.card || '', e.clientX, e.clientY);
        break;
      case 'import-confirm': doConfirmImport(); break;
      case 'export-json': doExport(); break;
      case 'import-json': doImportJSON(el.dataset.mode); break;
      case 'mgmt-delete': mgmtDelete(el.dataset.name); break;
      case 'mgmt-keep': mgmtKeep(el.dataset.name); break;

      /* 考点卡片详情页：卡片 / 题目管理 */
      case 'modal-close': closeModal(); break;
      case 'card-edit': openCardEdit(); break;
      case 'card-save': saveCardEdit(el.dataset.name); break;
      case 'card-del': openCardDelete(); break;
      case 'card-del-all': doDeleteCard(el.dataset.name, true); break;
      case 'card-del-keep': doDeleteCard(el.dataset.name, false); break;
      case 'q-edit': openQuestionEdit(el.dataset.id); break;
      case 'q-save': saveQuestion(el.dataset.id); break;
      case 'q-del': deleteQuestionById(el.dataset.id); break;
      case 'q-move': openQuestionMove(el.dataset.id); break;
      case 'q-move-save': saveQuestionMove(el.dataset.id); break;
      case 'q-add': openAddQuestion(); break;
      case 'q-add-tab': switchAddQTab(el.dataset.tab); break;
      case 'q-add-save': saveNewQuestion(); break;
      case 'q-add-parse': parsePasteQuestions(); break;
      case 'q-add-import': importPasteQuestions(); break;
      case 'batch-open': openBatch(); break;
      case 'batch-del': batchDelete(); break;
      case 'batch-keep': batchKeep(); break;
      case 'batch-move': batchMove(); break;
      case 'batch-delall': batchDeleteAll(); break;

      /* 导入归属：新建书籍/章节 */
      case 'owner-new-book': {
        const name = prompt('新书籍名称（导入内容将归入此书）：');
        if (name == null) break;
        const b = Store.addBook(name);
        if (!b) { toast('书籍名称为空或与现有书籍重名'); break; }
        importState.bookId = b.id;
        importState.chapterId = '';
        toast('已新建书籍，可继续新建章节或直接导入');
        renderImport();
        break;
      }
      case 'owner-new-chapter': {
        normalizeImportScope();
        if (!importState.bookId) { toast('请先选择或新建一本书'); break; }
        const book = Store.getBookById(importState.bookId);
        const name = prompt('在《' + book.name + '》下新建章节：');
        if (name == null) break;
        const ch = Store.addChapter(importState.bookId, name);
        if (!ch) { toast('章节名称为空或与本书已有章节重名'); break; }
        importState.chapterId = ch.id;
        toast('已新建章节');
        renderImport();
        break;
      }

      /* 书架 */
      case 'shelf-new-book': shelfNewBook(); break;
      case 'shelf-rename-book': shelfRenameBook(el.dataset.id); break;
      case 'shelf-del-book': shelfDeleteBook(el.dataset.id); break;
      case 'shelf-add-chapter': shelfAddChapter(el.dataset.book); break;
      case 'shelf-rename-chapter':
        shelfRenameChapter(el.dataset.book, el.dataset.id); break;
      case 'shelf-del-chapter':
        shelfDeleteChapter(el.dataset.book, el.dataset.id); break;
      case 'shelf-toggle':
        shelfExpanded = shelfExpanded === el.dataset.id ? null : el.dataset.id;
        renderBookshelf();
        break;
      case 'shelf-open':
        location.hash = '#/chapter/' + el.dataset.book + '/' + el.dataset.chapter;
        break;
      case 'chapter-practice':
        startChapter(scopeFromRoute(el.dataset.book), scopeFromRoute(el.dataset.chapter));
        break;
      case 'ch-detach-card':
        chapterDetachCard(el.dataset.name, el.dataset.book, el.dataset.chapter);
        break;
      case 'ch-del-point-qs':
        chapterDeletePointQuestions(el.dataset.name, el.dataset.book, el.dataset.chapter);
        break;

      /* 综合练习：书籍 → 章节 → 直接刷题 */
      case 'practice-toggle':
        practiceExpanded = practiceExpanded === el.dataset.id ? '' : el.dataset.id;
        renderPractice();
        break;
      case 'practice-chapter':
        startChapter(el.dataset.book, el.dataset.chapter || '');
        break;
      case 'practice-book':
        startBookPractice(el.dataset.id);
        break;
      case 'practice-random':
        startMixed();
        break;
      case 'practice-uncat':
        startSession('mixed', '未分类题目 · 随机',
          Store.getQuestions().filter(q => !q.reading && !q.bookId));
        break;
    }
  });

  /* change 事件：归属下拉 + JSON 文件选择 */
  document.addEventListener('change', function (e) {
    if (e.target.id === 'ownerBook') {
      importState.bookId = e.target.value || '';
      importState.chapterId = '';
      renderImport();
      return;
    }
    if (e.target.id === 'ownerChapter') {
      normalizeImportScope();
      importState.chapterId = e.target.value || '';
      renderImport();
      return;
    }
    /* 题目表单 / 来源弹窗：书变化时刷新章节下拉 */
    if (e.target.classList && e.target.classList.contains('src-book-select')) {
      refreshChapterSelect(e.target);
      return;
    }
    /* 批量管理弹窗：全选 / 单选联动 */
    if (e.target.id === 'batch-all') {
      if (modalEl) {
        const on = e.target.checked;
        modalEl.querySelectorAll('.batch-chk').forEach(cb => { cb.checked = on; });
        updateBatchCount();
      }
      return;
    }
    if (e.target.classList && e.target.classList.contains('batch-chk')) {
      updateBatchCount();
      return;
    }
    if (e.target.id !== 'jsonFile') return;
    const file = e.target.files && e.target.files[0];
    pickedBundle = null;
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        pickedBundle = JSON.parse(reader.result);
        if (!pickedBundle || !Array.isArray(pickedBundle.questions)) {
          pickedBundle = null;
          toast('备份内容格式不正确');
        } else {
          toast('已读取备份：' + pickedBundle.questions.length + ' 题');
          renderImport();
        }
      } catch (err) {
        toast('文件不是有效的 JSON');
      }
    };
    reader.onerror = () => toast('文件读取失败');
    reader.readAsText(file);
  });

  /* 弹窗：点击遮罩空白处或按 Esc 关闭 */
  document.addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('modal-mask')) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); closeCardPop(); closeDetailsMenus(); }
  });

  /* ---------- 统一返回：应用内导航过就 history.back，否则走链接兜底 ---------- */
  let navReady = false;      // 首次路由完成后才开始计数（冷启动不计）
  let navDepth = 0;          // 应用内前进步数
  let goingBack = false;
  window.addEventListener('hashchange', function () {
    if (!navReady) return;
    if (goingBack) { goingBack = false; navDepth = Math.max(0, navDepth - 1); }
    else navDepth++;
  });
  document.addEventListener('click', function (e) {
    const a = e.target.closest && e.target.closest('a.back-link');
    if (a && navDepth > 0) {
      e.preventDefault();
      goingBack = true;
      history.back();
    }
  });

  /* 卡片页/书架的「⋯」details 菜单：点开一个时收起其他，点菜单外收起 */
  function closeDetailsMenus(except) {
    document.querySelectorAll('details.dc-more, details.sb-more').forEach(d => {
      if (d !== except) d.open = false;
    });
  }
  document.addEventListener('click', function (e) {
    const sum = e.target.closest && e.target.closest('details.dc-more > summary, details.sb-more > summary');
    if (sum) {
      const d = sum.parentElement;
      const willOpen = !d.open;
      closeDetailsMenus(d);
      if (!willOpen) d.open = false;
      return;
    }
    if (!(e.target.closest && e.target.closest('details.dc-more, details.sb-more'))) {
      closeDetailsMenus();
    }
  });

  /* 暴露给 article.js / games.js 等扩展模块（必须在首次 router() 之前就位，
     否则冷启动 URL 直接带 hash（如 #/bomb/1）时页面内 B() 取到 undefined 会白屏） */
  window.AppBridge = {
    startSession: startSession,
    toast: toast,
    esc: esc,
    setHTML: setHTML,
    copyText: copyText,
    refreshBadge: refreshBadge
  };

  /* ---------- 启动 ---------- */
  /* v5.8 起无内置题库：仅执行一次旧内置数据的精准清除，题库完全靠用户导入 */
  Store.purgeBuiltinBank();
  /* v6.1：旧卡片补「来源」层、旧题目补来源字段，幂等不丢数据 */
  Store.migrateSources();
  window.addEventListener('hashchange', router);
  if (!location.hash) {
    /* 程序首次设置 #/home 触发的 hashchange 不计入前进深度 */
    const arm = () => { navReady = true; window.removeEventListener('hashchange', arm); };
    window.addEventListener('hashchange', arm);
    location.hash = '#/home';
  } else {
    router();
    navReady = true;
  }
})();
