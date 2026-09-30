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
 * =================================================================== */

(function () {
  'use strict';

  const APP_VERSION = 'v5.9（2026-09-30）';

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

  function startSession(mode, title, qs, pointName, articleId) {
    if (!qs.length) {
      toast(mode === 'marked' ? '疑难队列是空的' : '没有可用的题目');
      return;
    }
    session = {
      mode, title, pointName: pointName || '', articleId: articleId || '',
      items: makeItems(shuffle(qs)),
      index: 0,
      feedback: 'instant',   // instant | exam
      finished: false,
      reviewing: false,
      qStart: Date.now()
    };
    if (location.hash !== '#/quiz') location.hash = '#/quiz';
    else renderQuiz();
  }

  function startPoint(name) {
    startSession('point', name, Store.getQuestions().filter(q => q.point === name), name);
  }

  function startMixed() {
    if (!Store.getQuestions().length) {
      toast('题库是空的，先到「导入」页导入题目');
      location.hash = '#/import';
      return;
    }
    startSession('mixed', '综合刷题', Store.getQuestions());
  }

  function startWrongPractice() {
    startSession('wrong', '错题重练', Store.getWrongQuestions());
    if (!Store.getWrongQuestions().length) location.hash = '#/wrong';
  }

  function startMarkedPractice() {
    startSession('marked', '疑难重练', Store.getMarkedQuestions());
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
    ({
      point: () => startPoint(session.pointName),
      mixed: startMixed,
      wrong: startWrongPractice,
      marked: startMarkedPractice,
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
      '<div class="app-version">当前文件版本：' + APP_VERSION +
      ' · 看不到这行字说明手机上的文件是旧的</div>' +
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
      '<span class="q-title"><i class="q-dot"></i>综合刷题</span>' +
      '<span class="q-desc">全部题目随机 · 选项乱序</span></a>' +
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

  function renderCard(name) {
    const card = Store.getCardByName(name);
    if (!card) {
      setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
        '<div class="e-txt">未找到该考点</div>' +
        '<a class="btn btn-primary" href="#/home">返回首页</a></div>');
      return;
    }
    const qCount = Store.getQuestions().filter(q => q.point === name).length;
    const done = Store.isCompleted(name);

    const scopeHTML = card.bookId
      ? '<a class="scope-badge" href="#/chapter/' + scopeToRoute(card.bookId) + '/' +
      scopeToRoute(card.chapterId || '') + '">🗂 ' + esc(scopeText(card.bookId, card.chapterId)) + '</a>'
      : '<span class="scope-badge muted">🗂 未分类</span>';

    setHTML(
      '<a class="back-link" href="#/home">‹ 返回首页</a>' +
      '<div class="detail-card">' +
      '<h2>' + esc(card.name) + '</h2>' +
      '<div class="tags">' +
      '<span class="badge cat">' + esc(card.category) + '</span>' +
      '<span class="badge ' + (done ? 'done' : 'todo') + '">' +
      (done ? '✓ 已完成' : '未完成') + '</span>' +
      '<span class="badge todo">' + qCount + ' 题</span>' +
      dueBadgeOf(card) +
      '</div>' +
      scopeHTML +
      '<div class="detail-block"><div class="db-title">📌 摘要</div>' +
      '<div class="db-body">' + esc(card.summary) + '</div></div>' +
      '<div class="detail-block"><div class="db-title">📖 讲解</div>' +
      '<div class="db-body">' + esc(card.lecture) + '</div></div>' +
      (card.examples && card.examples.length ?
        '<div class="detail-block"><div class="db-title">💬 例句</div>' +
        card.examples.map(ex =>
          '<div class="example-item"><div class="ex-jp">' + esc(ex.jp) +
          '</div><div class="ex-cn">' + esc(ex.cn) + '</div></div>'
        ).join('') + '</div>' : '') +
      '</div>' +
      '<button class="btn btn-primary" data-action="start-point" data-name="' +
      esc(card.name) + '"' + (qCount ? '' : ' disabled') + '>' +
      (qCount ? '开始刷题（' + qCount + '题）' : '暂无题目') + '</button>'
    );
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

    /* 选项（展示顺序按 perm） */
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
      return '<button class="' + cls + '" data-action="quiz-option"' +
        (answered ? '' : ' data-idx="' + i + '"') + '>' +
        '<span class="opt-key">' + String.fromCharCode(65 + i) + '</span>' +
        '<span>' + esc(q.options[origKey]) + '</span></button>';
    }).join('');

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
      '<a class="back-link" href="#/home">‹ 退出刷题</a>' +

      '<div class="mode-switch' + (modeLocked ? ' locked' : '') + '">' +
      '<span class="ms-pill' + (s.feedback === 'instant' ? ' active' : '') +
      '" data-action="set-feedback" data-mode="instant">即时反馈</span>' +
      '<span class="ms-pill' + (s.feedback === 'exam' ? ' active' : '') +
      '" data-action="set-feedback" data-mode="exam">统一解析</span>' +
      '</div>' +

      '<div class="quiz-progress-bar"><i style="width:' + percent + '%"></i></div>' +
      '<div class="quiz-progress-txt">' +
      '<span>' + esc(s.title) + '</span>' +
      '<span>' + (s.index + 1) + ' / ' + s.items.length + '</span>' +
      '</div>' +

      '<div class="q-panel">' +
      '<div class="q-tags">' +
      '<span class="badge cat">' + esc(q.category) + '</span>' +
      '<span class="badge todo">' + esc(q.point) + '</span>' +
      '<span class="badge diff-' + q.difficulty + '">' + esc(q.difficulty) + '</span>' +
      '</div>' +
      '<div class="q-stem">' + esc(q.stem) + '</div>' +
      optionsHTML +
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
      return '<div class="' + cls + '">' +
        '<span class="opt-key">' + String.fromCharCode(65 + i) + '</span>' +
        '<span>' + esc(q.options[origKey]) + '</span></div>';
    }).join('');

    setHTML(
      '<div class="quiz-progress-txt"><span>解析回顾</span>' +
      '<span>' + (s.index + 1) + ' / ' + s.items.length + '</span></div>' +
      '<div class="q-panel">' +
      '<div class="q-tags">' +
      '<span class="badge cat">' + esc(q.category) + '</span>' +
      '<span class="badge todo">' + esc(q.point) + '</span>' +
      '<span class="badge diff-' + q.difficulty + '">' + esc(q.difficulty) + '</span>' +
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
        : '<button class="btn btn-primary" data-action="review-back">返回结果</button>') +
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
      mixed: { ico: '🎊', h2: '综合刷题完成！', sub: '所有题目已作答完毕' },
      wrong: { ico: '💪', h2: '错题重练完成！', sub: '答对的错题已自动移出错题本' },
      marked: { ico: '🚩', h2: '疑难重练完成！', sub: '答对且未再标记的题已移出疑难队列' },
      article: { ico: '📖', h2: '本文练习完成！', sub: '答错的题已自动收入错题本' },
      similar: { ico: '🔁', h2: '相似题完成！', sub: '同一考点的相似题已练完，答错的照常进错题本' },
      chapter: { ico: '📚', h2: '本章练习完成！', sub: '本章节的题目已全部答完' }
    }[s.mode];

    const contextBtn = s.mode === 'point'
      ? '<a class="btn btn-ghost" href="#/card/' + encodeURIComponent(s.pointName) + '">返回考点</a>'
      : s.mode === 'wrong'
        ? '<a class="btn btn-ghost" href="#/wrong">返回错题本</a>'
        : s.mode === 'marked'
          ? '<a class="btn btn-ghost" href="#/marked">返回疑难队列</a>'
          : s.mode === 'article'
            ? '<a class="btn btn-ghost" href="#/article/' + encodeURIComponent(s.articleId) + '">返回文章</a>'
            : s.mode === 'similar'
              ? '<a class="btn btn-ghost" href="#/wrong">返回错题本</a>'
              : s.mode === 'chapter'
                ? '<a class="btn btn-ghost" href="#/chapter/' +
                scopeToRoute(s.bookId || '') + '/' + scopeToRoute(s.chapterId || '') +
                '">返回章节</a>'
                : '<a class="btn btn-ghost" href="#/home">返回首页</a>';

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
      actionBtn = wrongs.length
        ? '<button class="btn btn-primary" data-action="wrong-practice" style="margin-bottom:14px">' +
        '错题重练（' + wrongs.length + '题）</button>' : '';
      listHTML = wrongs.length ? wrongs.map(q =>
        '<div class="wrong-item">' +
        '<div class="wi-top"><div class="wi-tags">' +
        '<span class="badge cat">' + esc(q.category) + '</span>' +
        '<span class="badge todo">' + esc(q.point) + '</span>' +
        '<span class="badge diff-' + q.difficulty + '">' + esc(q.difficulty) + '</span>' +
        '</div>' +
        '<button class="btn-mini" data-action="similar-q" data-point="' +
        esc(q.point) + '" data-id="' + esc(q.id) + '">🔁 相似题</button>' +
        '<button class="btn-mini danger" data-action="remove-wrong" data-id="' +
        esc(q.id) + '">移除</button></div>' +
        '<div class="wi-stem">' + esc(q.stem) + '</div>' +
        '<div class="wi-ans">正确答案：' + esc(q.answer + '．' + q.options[q.answer]) + '</div>' +
        '</div>').join('') :
        '<div class="empty"><span class="e-ico">📕</span>' +
        '<div class="e-txt">错题本还是空的<br>刷题答错的题会自动收录到这里</div></div>';
    } else {
      actionBtn = markeds.length
        ? '<button class="btn btn-primary" data-action="marked-practice" style="margin-bottom:14px">' +
        '疑难重练（' + markeds.length + '题）</button>' : '';
      listHTML = markeds.length ? markeds.map(q =>
        '<div class="wrong-item">' +
        '<div class="wi-top"><div class="wi-tags">' +
        '<span class="badge cat">' + esc(q.category) + '</span>' +
        '<span class="badge todo">' + esc(q.point) + '</span>' +
        '<span class="badge diff-' + q.difficulty + '">' + esc(q.difficulty) + '</span>' +
        '</div>' +
        '<button class="btn-mini danger" data-action="remove-marked" data-id="' +
        esc(q.id) + '">移除</button></div>' +
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
        ? '错题统计与重练' : '蒙对/不确定的题，往往才是真漏洞') + '</div></header>' +

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
    '【答案】B\n【解析】「今」表示正在进行，用ている。\n【难度】易';

  const FMT_CARD =
    '每张卡片用空行分隔，可写多条【例句】，日文与中文用 / 分隔：\n' +
    '【考点名称】～ている\n【门类】N4文法\n【摘要】表示正在进行的动作或持续的状态。\n' +
    '【讲解】Vて+いる。主要用法：①正在进行 ②结果状态 ③习惯反复。\n' +
    '【例句】父は今、新聞を読んでいます。/ 爸爸正在看报纸。\n' +
    '【例句】田中さんは東京に住んでいます。/ 田中先生住在东京。';

  /** 给 AI 的完整题目生成模板（一键复制用） */
  const TEMPLATE_FOR_AI =
    '请按以下格式生成日语语法单选题，每道题之间用一个空行分隔，' +
    '每行一个字段，字段名必须用【】包裹，不要输出格式以外的内容：\n\n' +
    '【门类】（如 N5文法 / N4文法 / N3文法/ N2文法/ N1文法）\n' +
    '【考点名称】（语法点名称）\n' +
    '【题型】单选题\n' +
    '【题干】（日语句子，需要选择的位置用（　）标出）\n' +
    '【选项A】（日文选项）\n' +
    '【选项B】（日文选项）\n' +
    '【选项C】（日文选项）\n' +
    '【选项D】（日文选项）\n' +
    '【答案】（只能是 A / B / C / D 中的一个字母）\n' +
    '【解析】（中文，解析需要详细，说明正确选项为什么对、其他选项为什么不合适,① 正确选项的语法含义和接续方式）,② 正确选项在句中的具体作用（为什么符合句意）,③ 逐一说明其他三个选项为什么不适合（各自含义、接续、语境差异）,④ 如果涉及近义语法，要补充对比辨析,⑤ 必要时给出一个额外的正确例句\n' +
    '【难度】（易 / 中 / 难）\n\n' +
    '要求：四个选项必须有迷惑性、考察同一语法点；题干自然地道、符合日语语法；\n' +
    '一次生成 100 道题，考点不要重复。';

  /** 给 AI 的卡片生成提示词（一键复制用） */
  const TEMPLATE_FOR_CARD =
    '请按以下格式生成日语语法考点卡片，每张卡片之间用一个空行分隔，' +
    '每行一个字段，字段名必须用【】包裹，不要输出格式以外的内容：\n\n' +
    '【考点名称】（语法点名称，接续用～表示，如 ～ている、～わけだ；' +
    '变体用・分隔，如 ～べき・～べからず；可选部分用（），如 ～際（は））\n' +
    '【门类】（如 N5文法 / N4文法 / N3文法 / N2文法 / N1文法 / 自定义语法，不填也行）\n' +
    '【摘要】（一句话概括这个语法的意思和用法）\n' +
    '【讲解】（接续方式 + 主要用法 + 注意事项，可写多条）\n' +
    '【例句】（日语句子 / 中文翻译，可写多条，每条单独一行【例句】）\n\n' +
    '要求：考点名称必须带～接续符号（决定能否被文章精读识别）；' +
    '摘要简洁；讲解讲清接续和用法区别；例句地道且带翻译。\n' +
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
      '<label>🗂 归属书籍 / 章节（仅用于分类管理，不选则为未分类）</label>' +
      '<div class="owner-row">' +
      '<select id="ownerBook" class="owner-select">' + bookOpts + '</select>' +
      '<select id="ownerChapter" class="owner-select"' + (book ? '' : ' disabled') + '>' +
      chapterOpts + '</select>' +
      '</div>' +
      '<div class="owner-actions">' +
      '<button type="button" class="btn-mini" data-action="owner-new-book">＋ 新建书籍</button>' +
      '<button type="button" class="btn-mini" data-action="owner-new-chapter"' +
      (book ? '' : ' disabled') + '>＋ 新建章节</button>' +
      '<span class="owner-target">将导入到：' +
      esc(scopeText(importState.bookId, importState.chapterId)) + '</span>' +
      '</div>' +
      '</div>';
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

    const itemHTML = tab === 'question'
      ? preview.map(p => {
        const d = p.data;
        return '<div class="preview-item' + (p.valid ? '' : ' invalid') + '">' +
          '<div class="pi-title">第' + p.index + '块 · ' + esc(d.point || '(无考点)') + '</div>' +
          '<div class="pi-line">' + esc(d.stem || '(无题干)') + '</div>' +
          '<div class="pi-opt">A.' + esc(d.options.A) + '　B.' + esc(d.options.B) +
          '　C.' + esc(d.options.C) + '　D.' + esc(d.options.D) + '</div>' +
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
              ? '<span style="color:#c98a2a;font-weight:normal;font-size:12px;margin-left:6px">⚠ 已存在，将更新内容与归属</span>'
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
      valid.length + ' 条' + (invalid.length ? '，无效 ' + invalid.length + ' 条' : '') +
      '<br>🗂 归属：' + esc(scopeText(importState.bookId, importState.chapterId)) + '</div>' +
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

    importState.preview = importState.tab === 'question'
      ? Parser.parseQuestionsText(importState.text)
      : Parser.parseCardsText(importState.text);
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
      const r = Store.upsertCards(items);
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
      const dupSet = new Set(
        Store.getQuestions().map(q => q.point + '||' + q.stem)
      );
      const fresh = [];
      let dup = 0;
      valid.forEach(p => {
        const key = p.data.point + '||' + p.data.stem;
        if (dupSet.has(key)) { dup++; return; }
        dupSet.add(key);
        fresh.push({ ...p.data, id: Store.uid('q'), bookId, chapterId });
      });
      Store.addQuestions(fresh);
      importState.message = '导入成功：新增 ' + fresh.length + ' 题' +
        (dup ? '，跳过重复 ' + dup + ' 题' : '') +
        '（归属：' + scopeText(bookId, chapterId) + '）';
    } else {
      const items = valid.map(p => ({ ...p.data, id: Store.uid('c'), bookId, chapterId }));
      const r = Store.upsertCards(items);
      importState.message = '导入成功：新增卡片 ' + r.added + ' 张' +
        (r.updated ? '，更新同名卡片 ' + r.updated + ' 张' : '') +
        '（归属：' + scopeText(bookId, chapterId) + '）';
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
        ? '已覆盖还原：' + r.questions + ' 题'
        : '合并完成：新增题目 ' + r.questions + ' 题，卡片新增 ' +
        r.cardsAdded + ' / 更新 ' + r.cardsUpdated;
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
    const qs = Store.getQuestions();
    const cs = Store.getCards();

    /* 未分类（没有 bookId 的题目/卡片） */
    const noneQ = qs.filter(q => !q.bookId).length;
    const noneC = cs.filter(c => !c.bookId).length;

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
      const bc = cs.filter(c => c.bookId === book.id);
      const chapters = Array.isArray(book.chapters) ? book.chapters : [];
      const looseQ = bq.filter(q => !q.chapterId).length;
      const looseC = bc.filter(c => !c.chapterId).length;
      const open = shelfExpanded === book.id;

      const chRow = (chId, name, cq, cc, isLoose) =>
        '<div class="sb-chapter">' +
        '<div class="sc-main" data-action="shelf-open" data-book="' + esc(book.id) +
        '" data-chapter="' + esc(chId || 'none') + '">' +
        '<span class="sc-ico">📄</span>' +
        '<span class="sc-name">' + esc(name) + '</span>' +
        '<span class="sc-count">' + cq + ' 题 · ' + cc + ' 卡</span>' +
        '<span class="sb-go">›</span></div>' +
        (isLoose ? '' :
          '<div class="sc-btns">' +
          '<button class="btn-mini" data-action="shelf-rename-chapter" data-book="' +
          esc(book.id) + '" data-id="' + esc(chId) + '">改名</button>' +
          '<button class="btn-mini danger" data-action="shelf-del-chapter" data-book="' +
          esc(book.id) + '" data-id="' + esc(chId) + '">删除</button>' +
          '</div>') +
        '</div>';

      const chaptersHTML = chapters.map(ch =>
        chRow(ch.id, ch.name,
          bq.filter(q => q.chapterId === ch.id).length,
          bc.filter(c => c.chapterId === ch.id).length, false)
      ).join('');

      const looseRow = (looseQ || looseC) ? chRow('', '未分章节', looseQ, looseC, true) : '';

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
      '删除书籍会连带删除其下所有章节、卡片和题目，请谨慎操作。</div>' +
      (noneRow || booksHTML ||
        '<div class="empty"><span class="e-ico">📚</span>' +
        '<div class="e-txt">书架还是空的<br>新建一本书，或在导入时选择归属书籍</div>' +
        '<button class="btn btn-primary" data-action="shelf-new-book">＋ 新建书籍</button>' +
        '<a class="btn btn-ghost" href="#/import">去导入题目/卡片</a></div>')
    );
  }

  /* ---------- 章节详情：卡片与题目 ---------- */

  function renderChapter(bookId, chapterId) {
    const book = bookId ? Store.getBookById(bookId) : null;
    if (bookId && !book) {
      setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
        '<div class="e-txt">未找到该书籍（可能已被删除）</div>' +
        '<a class="btn btn-primary" href="#/books">返回书架</a></div>');
      return;
    }
    let chapter = null;
    if (book && chapterId) {
      chapter = (book.chapters || []).find(c => c.id === chapterId) || null;
      if (!chapter) {
        setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
          '<div class="e-txt">未找到该章节（可能已被删除）</div>' +
          '<a class="btn btn-primary" href="#/books">返回书架</a></div>');
        return;
      }
    }

    const inScope = o => (o.bookId || '') === bookId && (o.chapterId || '') === chapterId;
    const qs = Store.getQuestions().filter(inScope);
    const cards = Store.getCards().filter(inScope);

    const title = !bookId ? '未分类' : book.name + ' · ' + (chapter ? chapter.name : '未分章节');

    /* 以考点名为线索，合并本章卡片与题目进行展示 */
    const pointSet = new Set();
    cards.forEach(c => c.name && pointSet.add(c.name));
    qs.forEach(q => q.point && pointSet.add(q.point));
    const points = Array.from(pointSet)
      .sort((a, b) => a.localeCompare(b, 'zh'));

    const rows = points.map(name => {
      const hasCard = Store.getCardByName(name);
      const count = qs.filter(q => q.point === name).length;
      const main = hasCard
        ? '<a class="chp-point" href="#/card/' + encodeURIComponent(name) + '">' +
          '<span class="cp-name">' + esc(name) + '</span>' +
          '<span class="sb-go">›</span></a>'
        : '<div class="chp-point no-card"><span class="cp-name">' + esc(name) +
        '</span><span class="badge todo">缺卡片</span></div>';
      return '<div class="manage-item chapter-point">' +
        '<div class="mi-info"><div class="mi-name">' + main + '</div>' +
        '<div class="mi-sub">' + (hasCard ? esc(hasCard.category) : '暂无卡片') +
        ' · ' + count + ' 题</div></div>' +
        '<div class="mi-btns">' +
        (count ? '<button class="btn-mini" data-action="start-point" data-name="' +
          esc(name) + '">刷题</button>' : '') +
        '</div></div>';
    }).join('');

    setHTML(
      '<a class="back-link" href="#/books">‹ 返回书架</a>' +
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
        '<a class="btn btn-ghost" href="#/books">返回书架</a></div>')
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
    const cn = Store.getCards().filter(c => c.bookId === id).length;
    const chn = (book.chapters || []).length;
    if (!confirm('确定删除《' + book.name + '》？\n将连带删除 ' + chn +
      ' 个章节、' + qn + ' 道题目、' + cn + ' 张卡片，此操作不可恢复。')) return;
    const r = Store.deleteBook(id);
    if (shelfExpanded === id) shelfExpanded = null;
    toast('已删除《' + book.name + '》：' + r.questions + ' 题、' + r.cards + ' 张卡片');
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
      .filter(c => c.bookId === bookId && c.chapterId === chapterId).length;
    if (!confirm('确定删除《' + book.name + '》的章节「' + ch.name + '」？\n将连带删除 ' +
      qn + ' 道题目、' + cn + ' 张卡片，此操作不可恢复。')) return;
    const r = Store.deleteChapter(bookId, chapterId);
    toast('已删除章节：' + r.questions + ' 题、' + r.cards + ' 张卡片');
    renderBookshelf();
  }

  /* ================= 路由与导航 ================= */

  function updateTabs(route) {
    const map = {
      home: 'home', mixed: 'mixed', wrong: 'wrong', marked: 'wrong',
      import: 'import', articles: 'home', article: 'home',
      books: 'home', chapter: 'home'
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
    const parts = (location.hash || '#/home').slice(2).split('/').map(decodeURIComponent);
    const route = parts[0] || 'home';
    updateTabs(route);
    switch (route) {
      case 'home': renderHome(); break;
      case 'card': renderCard(parts[1]); break;
      case 'quiz': renderQuiz(); break;
      case 'mixed': startMixed(); break;
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
      case 'quiz-option': answerCurrent(Number(el.dataset.idx)); break;
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
        copyText(TEMPLATE_FOR_AI).then(
          () => toast('已复制，去其他 AI 生成题目吧'),
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
      case 'import-confirm': doConfirmImport(); break;
      case 'export-json': doExport(); break;
      case 'import-json': doImportJSON(el.dataset.mode); break;
      case 'mgmt-delete': mgmtDelete(el.dataset.name); break;
      case 'mgmt-keep': mgmtKeep(el.dataset.name); break;

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

  /* 暴露给 article.js / games.js 等扩展模块（必须在首次 router() 之前就位，
     否则冷启动 URL 直接带 hash（如 #/bomb/1）时页面内 B() 取到 undefined 会白屏） */
  window.AppBridge = {
    startSession: startSession,
    toast: toast,
    esc: esc,
    setHTML: setHTML,
    copyText: copyText
  };

  /* ---------- 启动 ---------- */
  /* v5.8 起无内置题库：仅执行一次旧内置数据的精准清除，题库完全靠用户导入 */
  Store.purgeBuiltinBank();
  window.addEventListener('hashchange', router);
  if (!location.hash) location.hash = '#/home';
  else router();
})();
