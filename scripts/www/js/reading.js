/* =====================================================================
 * reading.js —— 阅读理解：独立书架（书籍 → 单元 → 文章）+ 挖空作答
 *
 * 路由：
 *   #/reading                        书架（书籍列表）
 *   #/reading/book/<bookId>          单元列表（可展开预览文章）
 *   #/reading/unit/<bookId>/<unitId> 文章列表
 *   #/reading/pass/<articleId>       文章详情（做题 / 解析 / 一键精读）
 *   #/reading/import                 导入（单篇或批量）
 *
 * 数据：Store 的 jp_reading_v1（结构见 storage.js 注释）
 * 联动：答错的空自动生成题库题（category 阅读理解、reading:true）进错题本，
 *       综合刷题与语法书架会过滤这些题；文章可一键填坑导入「文章精读」。
 * =================================================================== */

(function () {
  'use strict';

  /* ---------- 模块状态 ---------- */
  let shelfSort = 'created';     // created | study
  let unitExpanded = {};         // 书籍页内联展开的单元 id
  let passId = null;             // 当前打开的文章 id
  let passMode = 'step';         // step 逐题作答 | exam 全部作答后统一提交
  let importText = '';
  let importPreview = null;
  let selBook = '';     // '' 跟随文本 | 已有书 id
  let selUnit = '';     // '__auto__' 跟随文本【单元】 | 已有单元 id（仅 selBook 有值时生效）

  const B = () => window.AppBridge;
  const esc = s => B().esc(s);
  const MARK_RE = /[（(]\s*(\d{1,2})\s*[）)]/g;

  function fmtDate(ts) {
    const d = new Date(ts);
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function freshState() {
    return { chosen: {}, submitted: false, correct: 0, total: 0, updatedAt: 0, history: [] };
  }

  function normState(a) {
    if (!a.state || typeof a.state !== 'object') a.state = freshState();
    const s = a.state;
    if (!s.chosen || typeof s.chosen !== 'object') s.chosen = {};
    if (!Array.isArray(s.history)) s.history = [];
    return s;
  }

  /* 题目统一视图：挖空题 key=no；正文外附加题 key='x'+no（避免编号冲突） */
  function qKey(kind, no) { return kind === 'extra' ? 'x' + no : String(no); }

  function allQs(a) {
    const list = [];
    (a.blanks || []).forEach(b => list.push({ kind: 'blank', key: String(b.no), q: b }));
    (a.extras || []).forEach(q => list.push({ kind: 'extra', key: 'x' + q.no, q }));
    return list;
  }

  function findQ(a, kind, no) {
    const arr = kind === 'extra' ? (a.extras || []) : (a.blanks || []);
    return arr.find(x => x.no === no) || null;
  }

  /** 一篇文章的总题数（挖空 + 附加题） */
  function qTotal(a) {
    return (a.blanks || []).length + ((a.extras || []).length);
  }

  /** 已作答数（只统计当前仍存在的题，防止删改后的残留 key） */
  function qAnswered(a, s) {
    s = s || normState(a);
    return allQs(a).reduce((n, x) => n + (s.chosen[x.key] ? 1 : 0), 0);
  }

  /** 文章状态：none 未做 / progress 作答中 / done 已做 / wrong 有错题 */
  function artStatus(a) {
    const s = normState(a);
    const total = qTotal(a);
    if (s.submitted) return s.correct >= total ? 'done' : 'wrong';
    return qAnswered(a, s) ? 'progress' : 'none';
  }

  function statusBadge(a) {
    const st = artStatus(a);
    const s = normState(a);
    if (st === 'done') return '<span class="badge done">✓ 已做</span>';
    if (st === 'wrong') return '<span class="badge warn">有错题</span>';
    if (st === 'progress') {
      return '<span class="badge todo">作答中 ' + qAnswered(a, s) +
        '/' + qTotal(a) + '</span>';
    }
    return '<span class="badge todo">未做</span>';
  }

  /** 已提交文章的正确率（%），未提交返回 null */
  function accuracyOf(a) {
    const s = normState(a);
    const total = qTotal(a);
    if (!s.submitted || !total) return null;
    return Math.round(s.correct / total * 100);
  }

  function unitStats(unit) {
    const arts = unit.articles || [];
    let done = 0, cor = 0, tot = 0;
    arts.forEach(a => {
      const s = normState(a);
      if (s.submitted) { done++; cor += s.correct; tot += qTotal(a); }
    });
    return { count: arts.length, done, acc: tot ? Math.round(cor / tot * 100) : null };
  }

  function bookStats(book) {
    let units = 0, count = 0, done = 0;
    (book.units || []).forEach(u => {
      units++;
      const st = unitStats(u);
      count += st.count;
      done += st.done;
    });
    return { units, count, done };
  }

  /* ================= 判分与错题本联动 ================= */

  /** 挖空所在句子（含句末标点），找不到则截取标记前后各 60 字 */
  function sentenceOf(text, no) {
    const re = new RegExp('[（(]\\s*' + no + '\\s*[）)]');
    const sents = String(text).match(/[^。！？!?\n]+[。！？!?]?/g) || [text];
    const hit = sents.find(s => re.test(s));
    if (hit) return hit.trim();
    const m = re.exec(text);
    if (!m) return text.slice(0, 120);
    return text.slice(Math.max(0, m.index - 60), m.index + 60).trim();
  }

  /**
   * 把某道题（挖空题 / 附加题）同步成题库题（category 阅读理解、reading:true），返回题 id。
   * 仅在答错或标记疑难时调用；题记录用于错题本/疑难队列展示与重练。
   */
  function ensureQid(article, q, kind) {
    if (q.qid && Store.getQuestionById(q.qid)) return q.qid;
    let stem;
    if (kind === 'extra') {
      stem = q.stem || ('阅读理解附加题 ' + q.no + '（《' + article.title + '》）');
    } else {
      stem = sentenceOf(article.text, q.no)
        .replace(new RegExp('[（(]\\s*' + q.no + '\\s*[）)]'), '（　）');
    }
    const pts = (q.points || []).join('・');
    const rec = {
      id: Store.uid('rcq'),
      category: '阅读理解',
      point: '阅读理解·' + article.title,
      type: '单选题',
      stem,
      options: q.options,
      answer: q.answer,
      explanation: (q.explanation || '') + (pts ? (q.explanation ? '　' : '') + '知识点：' + pts : ''),
      difficulty: '中',
      reading: true,
      rcArticleId: article.id,
      rcBlankNo: q.no
    };
    Store.addQuestions([rec]);
    q.qid = rec.id;
    return rec.id;
  }

  /** 判一道题：答错进错题本，答对则从错题本移除（若曾在） */
  function gradeQ(article, item, bookId) {
    const s = normState(article);
    const chosen = s.chosen[item.key];
    const correct = chosen === item.q.answer;
    if (!correct) {
      Store.addWrong(ensureQid(article, item.q, item.kind));
      item.q.lastWrong = true;
    } else if (item.q.qid) {
      Store.removeWrong(item.q.qid);
      item.q.lastWrong = false;
    }
    if (bookId) Store.touchReadingBook(bookId);
    return correct;
  }

  /** 全部答完则收尾：计分、写历史、置已提交 */
  function finalize(article, bookId) {
    const s = normState(article);
    const items = allQs(article);
    const total = items.length;
    const answered = qAnswered(article, s);
    if (s.submitted || answered < total) return false;
    let cor = 0;
    items.forEach(it => { if (s.chosen[it.key] === it.q.answer) cor++; });
    s.correct = cor;
    s.total = total;
    s.submitted = true;
    s.updatedAt = Date.now();
    s.history.unshift({ ts: s.updatedAt, correct: cor, total });
    s.history = s.history.slice(0, 20);
    if (bookId) Store.touchReadingBook(bookId);
    return true;
  }

  function locate() {
    const hit = Store.findReadingArticle(passId);
    return hit || null;
  }

  /** 详情页原地刷新（保持滚动位置，setHTML 默认会滚回顶部） */
  function refreshPassage() {
    const y = window.scrollY;
    renderPassage(passId);
    window.scrollTo(0, y);
  }

  /* ================= 视图：书架 ================= */

  function renderShelf() {
    passId = null;
    importPreview = null;
    const books = Store.getReadingBooks().slice();
    books.sort(shelfSort === 'study'
      ? (a, b) => (b.lastStudyAt || 0) - (a.lastStudyAt || 0)
      : (a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const listHTML = books.length ? books.map(book => {
      const st = bookStats(book);
      return '<div class="shelf-book">' +
        '<div class="sb-head">' +
        '<div class="sb-main" data-rc="open-book" data-id="' + esc(book.id) + '">' +
        '<span class="sb-caret">📖</span>' +
        '<div class="sb-text"><div class="sb-name">' + esc(book.name) + '</div>' +
        '<div class="sb-sub">' + st.units + ' 个单元 · ' + st.count + ' 篇' +
        (st.count ? ' · 已做 ' + st.done + '/' + st.count : '') +
        (shelfSort === 'study' && book.lastStudyAt ? ' · ' + fmtDate(book.lastStudyAt) : '') +
        '</div></div>' +
        '<span class="sb-go">›</span></div>' +
        '<div class="sb-btns">' +
        '<button class="btn-mini" data-rc="rename-book" data-id="' + esc(book.id) + '">改名</button>' +
        '<button class="btn-mini danger" data-rc="del-book" data-id="' + esc(book.id) + '">删除</button>' +
        '</div></div></div>';
    }).join('') :
      '<div class="empty"><span class="e-ico">📚</span>' +
      '<div class="e-txt">阅读理解书架还是空的<br>新建一本书，或直接导入文章（挖空题、附加题都支持）</div>' +
      '<button class="btn btn-primary" data-rc="new-book">＋ 新建书籍</button></div>';

    B().setHTML(
      '<header class="page-head"><h1>阅读理解</h1>' +
      '<div class="sub">书籍 → 单元 → 文章（挖空题 / 正文外附加题）；答错自动进错题本，做完可一键精读</div></header>' +
      '<div class="rc-toolbar">' +
      '<button class="btn btn-ink" data-rc="new-book">＋ 新建书籍</button>' +
      '<a class="btn btn-primary" href="#/reading/import">📥 导入文章</a>' +
      '<select id="rcSort" class="rc-sort">' +
      '<option value="created"' + (shelfSort === 'created' ? ' selected' : '') + '>按创建时间</option>' +
      '<option value="study"' + (shelfSort === 'study' ? ' selected' : '') + '>按最近学习</option>' +
      '</select></div>' +
      listHTML
    );
  }

  /* ================= 视图：单元列表 ================= */

  function renderBook(bookId) {
    passId = null;
    const book = Store.getReadingBookById(bookId);
    if (!book) {
      B().setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
        '<div class="e-txt">未找到该书籍（可能已被删除）</div>' +
        '<a class="btn btn-primary back-link" href="#/reading">‹ 返回</a></div>');
      return;
    }
    const units = Array.isArray(book.units) ? book.units : [];

    const rows = units.map(u => {
      const st = unitStats(u);
      const open = !!unitExpanded[u.id];
      const mini = open ? (u.articles || []).map(a =>
        '<div class="rc-mini-item" data-rc="open-pass" data-id="' + esc(a.id) + '">' +
        '<span class="rc-mini-title">' + esc(a.title) + '</span>' + statusBadge(a) +
        '<span class="sb-go">›</span></div>').join('') : '';
      return '<div class="shelf-book">' +
        '<div class="sb-head">' +
        '<div class="sb-main" data-rc="unit-toggle" data-id="' + esc(u.id) + '">' +
        '<span class="sb-caret">' + (open ? '▾' : '▸') + '</span>' +
        '<div class="sb-text"><div class="sb-name" data-rc="open-unit" data-book="' +
        esc(bookId) + '" data-id="' + esc(u.id) + '">' + esc(u.name) + '</div>' +
        '<div class="sb-sub">' + st.count + ' 篇 · 已做 ' + st.done +
        (st.acc !== null ? ' · 正确率 ' + st.acc + '%' : '') + '</div></div>' +
        '<span class="sb-go" data-rc="open-unit" data-book="' + esc(bookId) +
        '" data-id="' + esc(u.id) + '">›</span></div>' +
        '<div class="sb-btns">' +
        '<button class="btn-mini" data-rc="rename-unit" data-book="' + esc(bookId) +
        '" data-id="' + esc(u.id) + '">改名</button>' +
        '<button class="btn-mini danger" data-rc="del-unit" data-book="' + esc(bookId) +
        '" data-id="' + esc(u.id) + '">删除</button>' +
        '</div></div>' +
        (open ? '<div class="sb-chapters">' +
          (mini || '<div class="sc-empty">本单元还没有文章，去「导入文章」添加</div>') +
          '</div>' : '') +
        '</div>';
    }).join('');

    B().setHTML(
      '<a class="back-link" href="#/reading">‹ 返回</a>' +
      '<header class="page-head"><h1>📖 ' + esc(book.name) + '</h1>' +
      '<div class="sub">' + units.length + ' 个单元 · 点击单元名进入文章列表，点击 ▸ 快速预览</div></header>' +
      '<div class="rc-toolbar">' +
      '<button class="btn btn-ink" data-rc="new-unit" data-book="' + esc(bookId) + '">＋ 新建单元</button>' +
      '<a class="btn btn-primary" href="#/reading/import">📥 导入文章</a>' +
      '</div>' +
      (rows || '<div class="empty"><span class="e-ico">🗂</span>' +
        '<div class="e-txt">还没有单元，先新建一个单元</div>' +
        '<button class="btn btn-primary" data-rc="new-unit" data-book="' + esc(bookId) +
        '">＋ 新建单元</button></div>')
    );
  }

  /* ================= 视图：文章列表 ================= */

  function renderUnit(bookId, unitId) {
    passId = null;
    const book = Store.getReadingBookById(bookId);
    const unit = book && (book.units || []).find(u => u.id === unitId);
    if (!book || !unit) {
      B().setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
        '<div class="e-txt">未找到该单元（可能已被删除）</div>' +
        '<a class="btn btn-primary back-link" href="#/reading">‹ 返回</a></div>');
      return;
    }
    const st = unitStats(unit);
    const arts = unit.articles || [];

    const rows = arts.map(a => {
      const acc = accuracyOf(a);
      const extraCount = (a.extras || []).length;
      const hasExpl = (a.blanks || []).some(b => b.explanation) ||
        (a.extras || []).some(q => q.explanation);
      return '<div class="art-item" data-rc="open-pass" data-id="' + esc(a.id) + '">' +
        '<div class="ai-main">' +
        '<div class="ai-title">' + (a.favorite ? '<span class="rc-fav">★</span> ' : '') +
        esc(a.title) + '</div>' +
        '<div class="ai-meta">' +
        statusBadge(a) +
        '<span class="badge todo">' + qTotal(a) + ' 题</span>' +
        (extraCount ? '<span class="badge cat">附加题 ' + extraCount + '</span>' : '') +
        (acc !== null ? '<span class="badge ' + (acc >= 60 ? 'done' : 'warn') +
          '">正确率 ' + acc + '%</span>' : '') +
        (hasExpl ? '<span class="badge cat">有解析</span>' : '') +
        '</div></div>' +
        '<button class="btn-mini danger ai-del" data-rc="del-article" data-id="' +
        esc(a.id) + '">删除</button>' +
        '</div>';
    }).join('');

    B().setHTML(
      '<a class="back-link" href="#/reading/book/' + encodeURIComponent(bookId) +
      '">‹ 返回</a>' +
      '<header class="page-head"><h1>' + esc(unit.name) + '</h1>' +
      '<div class="sub">' + st.count + ' 篇 · 已做 ' + st.done +
      (st.acc !== null ? ' · 单元正确率 ' + st.acc + '%' : '') + '</div></header>' +
      '<div class="rc-toolbar">' +
      '<a class="btn btn-primary" href="#/reading/import">📥 导入文章</a>' +
      '<button class="btn btn-danger" data-rc="del-unit" data-book="' +
      esc(bookId) + '" data-id="' + esc(unitId) + '">🗑 一键删除整个单元</button>' +
      '</div>' +
      (rows || '<div class="empty"><span class="e-ico">📝</span>' +
        '<div class="e-txt">本单元还没有文章</div>' +
        '<a class="btn btn-primary" href="#/reading/import">📥 导入文章</a></div>')
    );
  }

  /* ================= 视图：文章详情（做题 / 解析 / 一键精读） ================= */

  function blankSpan(a, no) {
    const s = normState(a);
    const b = (a.blanks || []).find(x => x.no === no);
    const chosen = s.chosen[no];
    let cls = 'rc-blank', inner = String(no);
    if (b && chosen) {
      inner += '·' + chosen;
      const graded = passMode === 'step' || s.submitted;
      if (graded) cls += chosen === b.answer ? ' ok' : ' bad';
      else cls += ' picked';
    }
    return '<span class="' + cls + '">（' + esc(inner) + '）</span>';
  }

  function bodyHTML(a) {
    const escaped = esc(a.text);
    return escaped.replace(MARK_RE, (m, n) => blankSpan(a, Number(n)));
  }

  /** 统一题卡：item = { kind:'blank'|'extra', key, q } */
  function questionCard(a, item, markedIds) {
    const { kind, key, q: b } = item;
    const s = normState(a);
    const chosen = s.chosen[key];
    const graded = (passMode === 'step' && !!chosen) || s.submitted;
    const locked = graded;
    const isExtra = kind === 'extra';

    const opts = ['A', 'B', 'C', 'D'].map(L => {
      let cls = 'rc-opt';
      if (chosen === L) cls += ' chosen';
      if (graded) {
        if (L === b.answer) cls += ' ok';
        else if (chosen === L) cls += ' bad';
        else cls += ' dim';
      }
      return '<button class="' + cls + '" data-rc="opt" data-kind="' + kind +
        '" data-no="' + b.no + '" data-letter="' + L + '"' +
        (locked ? ' disabled' : '') + '>' +
        '<span class="rc-opt-l">' + L + '</span><span class="rc-opt-t">' +
        esc(b.options[L]) + '</span></button>';
    }).join('');

    let result = '';
    if (graded && chosen) {
      const correct = chosen === b.answer;
      const marked = b.qid && markedIds.indexOf(b.qid) !== -1;
      result =
        '<div class="rc-result ' + (correct ? 'ok' : 'bad') + '">' +
        (correct ? '✓ 回答正确' : '✗ 正确答案：' + b.answer + '．' + esc(b.options[b.answer])) +
        '</div>' +
        '<button class="btn-mini rc-mark' + (marked ? ' on' : '') +
        '" data-rc="mark-blank" data-kind="' + kind + '" data-no="' + b.no + '">' +
        (marked ? '🚩 已标疑难' : '🚩 标记疑难') + '</button>' +
        ((b.explanation || (b.points || []).length) ?
          '<details class="rc-expl"' + (correct ? '' : ' open') + '><summary>查看解析</summary>' +
          (b.explanation ? '<div class="rc-expl-b">' + esc(b.explanation) + '</div>' : '') +
          ((b.points || []).length ?
            '<div class="rc-pts">' + b.points.map(p =>
              '<span class="badge cat">' + esc(p) + '</span>').join('') + '</div>' : '') +
          '</details>' : '');
    }

    const headLabel = isExtra ? ('附加题 ' + b.no) : ('第 ' + b.no + ' 空');
    const headHint = isExtra
      ? (graded && chosen ? '' : '<span class="rc-q-hint">正文之外的独立题</span>')
      : (graded && chosen ? '' : '<span class="rc-q-hint">在上方原文中找到（' + b.no + '）</span>');

    return '<div class="rc-q' + (graded && chosen ?
      (chosen === b.answer ? ' ok' : ' bad') : '') + '">' +
      '<div class="rc-q-head"><span class="rc-q-no">' + headLabel + '</span>' + headHint + '</div>' +
      (isExtra && b.stem ? '<div class="rc-q-stem">' + esc(b.stem) + '</div>' : '') +
      opts + result + '</div>';
  }

  function renderPassage(id) {
    passId = id;
    const hit = locate();
    if (!hit) {
      B().setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
        '<div class="e-txt">文章不存在或已删除</div>' +
        '<a class="btn btn-primary back-link" href="#/reading">‹ 返回</a></div>');
      return;
    }
    const { book, unit, article: a } = hit;
    const s = normState(a);
    const blankCount = (a.blanks || []).length;
    const extraCount = (a.extras || []).length;
    const total = qTotal(a);
    const answered = qAnswered(a, s);
    const started = answered > 0;
    const markedIds = Store.getMarkedIds();

    /* 计分横幅 */
    let banner = '';
    if (s.submitted) {
      const acc = total ? Math.round(s.correct / total * 100) : 0;
      banner = '<div class="rc-score ' + (s.correct >= total ? 'ok' : 'bad') + '">' +
        '本次得分：' + s.correct + ' / ' + total + '（' + acc + '%）' +
        (s.correct < total ? ' · 错题已收入错题本' : ' · 全对，太棒了！') + '</div>';
    }

    /* 历史作答记录 */
    const history = s.history.length ?
      '<details class="rc-history"><summary>历史作答记录（' + s.history.length + ' 次）</summary>' +
      s.history.map(h =>
        '<div class="rc-h-row"><span>' + fmtDate(h.ts) + '</span>' +
        '<span class="' + (h.correct >= h.total ? 'rc-h-ok' : 'rc-h-bad') + '">' +
        h.correct + ' / ' + h.total + '</span></div>').join('') +
      '</details>' : '';

    /* 精读按钮：已导入过且精读文章仍在 → 查看；否则 → 一键导入 */
    const precision = a.precisionId && Store.getArticleById(a.precisionId);
    const precisionBtn = precision
      ? '<a class="btn btn-primary" href="#/article/' + encodeURIComponent(a.precisionId) +
      '">📖 查看精读</a>'
      : '<button class="btn btn-primary" data-rc="to-precision">📖 一键导入到文章精读</button>';

    B().setHTML(
      '<a class="back-link" href="#/reading/unit/' + encodeURIComponent(book.id) + '/' +
      encodeURIComponent(unit.id) + '">‹ 返回</a>' +
      '<header class="page-head"><h1>' + esc(a.title) + '</h1>' +
      '<div class="art-meta-row">' +
      '<span class="badge cat">' + esc(book.name) + ' · ' + esc(unit.name) + '</span>' +
      '<span class="badge todo">' + total + ' 题</span>' +
      (blankCount ? '<span class="badge todo">挖空 ' + blankCount + '</span>' : '') +
      (extraCount ? '<span class="badge cat">附加题 ' + extraCount + '</span>' : '') +
      statusBadge(a) +
      (a.favorite ? '<span class="badge rc-fav-badge">★ 已收藏</span>' : '') +
      '</div></header>' +

      '<div class="rc-toolbar">' +
      '<button class="btn-mini" data-rc="fav">' + (a.favorite ? '★ 取消收藏' : '☆ 收藏文章') + '</button>' +
      '<button class="btn-mini" data-rc="restart"' + (started || s.submitted ? '' : ' disabled') +
      '>🔁 重新作答</button>' +
      '<button class="btn-mini danger" data-rc="del-article" data-id="' + esc(a.id) + '">删除</button>' +
      '</div>' +

      '<div class="import-tabs">' +
      '<div class="import-tab' + (passMode === 'step' ? ' active' : '') +
      '" data-rc="mode" data-mode="step">逐题作答</div>' +
      '<div class="import-tab' + (passMode === 'exam' ? ' active' : '') +
      '" data-rc="mode" data-mode="exam">全部作答后提交</div>' +
      '</div>' +

      banner +
      '<div class="art-body rc-body">' + bodyHTML(a) + '</div>' +

      (blankCount
        ? '<div class="hl-hint">— 在下方选择每空的答案 —</div>' +
        allQs(a).filter(x => x.kind === 'blank')
          .map(item => questionCard(a, item, markedIds)).join('')
        : '') +

      (extraCount
        ? '<div class="rc-extra-head"><span class="rc-extra-t">📝 附加题目</span>' +
        '<span class="rc-extra-sub">正文之外的独立题（语法辨析・读音・阅读选择等）</span></div>' +
        allQs(a).filter(x => x.kind === 'extra')
          .map(item => questionCard(a, item, markedIds)).join('')
        : '') +

      (passMode === 'exam' && !s.submitted ?
        '<button class="btn btn-ink rc-submit" data-rc="submit"' +
        (answered < total ? ' disabled' : '') + '>提交作答（' + answered + '/' + total + '）</button>' : '') +

      '<div class="ex-div">学 完 这 篇</div>' +
      '<div class="rc-foot">' + precisionBtn + '</div>' +
      history
    );
  }

  /* ================= 作答动作 ================= */

  function doOpt(kind, no, letter) {
    const hit = locate();
    if (!hit) return;
    const { book, article: a } = hit;
    const s = normState(a);
    if (s.submitted) return;
    const q = findQ(a, kind, no);
    if (!q) return;
    const key = qKey(kind, no);
    const item = { kind, key, q };

    if (passMode === 'step') {
      if (s.chosen[key]) return;                // 逐题模式：判过即锁定
      s.chosen[key] = letter;
      gradeQ(a, item, book.id);
      const done = finalize(a, book.id);
      Store.updateReadingArticle(a);
      B().refreshBadge();
      if (done) B().toast('已全部完成：' + s.correct + '/' + s.total +
        (s.correct < s.total ? '，错题已进错题本' : '，全对！'));
    } else {
      s.chosen[key] = s.chosen[key] === letter ? undefined : letter;
      if (!s.chosen[key]) delete s.chosen[key];
      Store.updateReadingArticle(a);
    }
    refreshPassage();
  }

  function doSubmit() {
    const hit = locate();
    if (!hit) return;
    const { book, article: a } = hit;
    const s = normState(a);
    const items = allQs(a);
    const total = items.length;
    if (s.submitted) return;
    if (qAnswered(a, s) < total) {
      B().toast('还有 ' + (total - qAnswered(a, s)) + ' 题未作答');
      return;
    }
    items.forEach(item => gradeQ(a, item, book.id));
    finalize(a, book.id);
    Store.updateReadingArticle(a);
    B().refreshBadge();
    B().toast('已提交：' + s.correct + '/' + s.total +
      (s.correct < s.total ? '，错题已进错题本' : '，全对！'));
    refreshPassage();
  }

  function doRestart() {
    const hit = locate();
    if (!hit) return;
    const { article: a } = hit;
    const s = normState(a);
    if (!Object.keys(s.chosen).length && !s.submitted) return;
    a.state = { chosen: {}, submitted: false, correct: 0, total: 0, updatedAt: 0, history: s.history };
    Store.updateReadingArticle(a);
    B().toast('已重置，可以重新作答');
    refreshPassage();
  }

  function doMarkBlank(kind, no) {
    const hit = locate();
    if (!hit) return;
    const { article: a } = hit;
    const b = findQ(a, kind, no);
    if (!b) return;
    const qid = ensureQid(a, b, kind);
    if (Store.getMarkedIds().indexOf(qid) !== -1) {
      Store.removeMarked(qid);
      B().toast('已移出疑难队列');
    } else {
      Store.addMarked(qid);
      B().toast('已加入疑难队列');
    }
    Store.updateReadingArticle(a);
    refreshPassage();
  }

  /** 一键导入精读：填上正确答案生成完整文章，写入文章精读模块并跳转 */
  function doToPrecision() {
    const hit = locate();
    if (!hit) return;
    const { article: a } = hit;
    if (a.precisionId && Store.getArticleById(a.precisionId)) {
      location.hash = '#/article/' + a.precisionId;
      return;
    }
    const filled = a.text.replace(MARK_RE, (m, n) => {
      const b = (a.blanks || []).find(x => x.no === Number(n));
      return b ? b.options[b.answer] : m;
    });
    const AP = window.ArticlePage;
    const analysis = AP && AP.analyze ? AP.analyze(filled) : { points: [] };
    const art = {
      id: Store.uid('a'),
      text: filled,
      title: a.title,
      createdAt: Date.now(),
      pointCount: analysis.points.length,
      newCount: analysis.points.filter(p => p.isNew).length,
      difficulty: AP && AP.assessDifficulty
        ? AP.assessDifficulty(filled, analysis.points) : '进阶',
      questionIds: []
    };
    Store.addArticle(art);
    a.precisionId = art.id;
    Store.updateReadingArticle(a);
    B().toast('已填坑导入「文章精读」，正在跳转…');
    setTimeout(() => { location.hash = '#/article/' + art.id; }, 350);
  }

  /* ================= 视图：导入 ================= */

  const FORMAT_HINT =
    '在上方「导入到哪个书籍 / 单元」直接选择已有的书籍和单元；也可以选「跟随文本」，由文中的【书名】【单元】自动归类（可一次批量导入多本多套）。\n' +
    '每篇文章以【标题】开头；【书名】【单元】写在任意位置，对其后的所有文章生效（未指定归属时可省略）。\n' +
    '题目分两类：① 挖空题——挖空在正文中写作（1）（2）…，连续的（　）会按顺序自动编号；' +
    '② 附加题——正文中没有对应挖空的题（语法辨析、读音题、阅读选择题等），可用【题N题干】写明题干，导入后显示在正文下方。\n' +
    '只要有任意一类题目就算有效文章，正文没有挖空也不报错。\n' +
    '每题配一组【题N选项A-D】【题N答案】，【题N解析】【题N知识点】可选。';

  /**
   * AI 整理提示词：按上方选择的书籍/单元动态替换【书名】【单元】。
   * 跟随文本时保留可修改的占位词，AI 可自行命名。
   */
  function buildAIPrompt() {
    let bookName = '书名';
    let unitName = '单元名';
    if (selBook) {
      const book = Store.getReadingBookById(selBook);
      if (book) {
        bookName = book.name;
        if (selUnit && selUnit !== '__auto__') {
          const u = (book.units || []).find(x => x.id === selUnit);
          if (u) unitName = u.name;
        }
      }
    }
    return '你是一名日语资料整理助手。我会给你一篇日语文章和对应的题目' +
      '（可能包含完形填空、语法辨析、读音题、阅读选择题等）。' +
      '请你严格按下面的格式，把资料整理成系统可导入的结构化文本，不要输出任何其他内容。\n\n' +
      '要求：\n' +
      '1. 正文原样保留，挖空处用（1）（2）…标出；如果原文用其他符号，请统一改成（数字）。\n' +
      '2. 题目按顺序编号，每道题输出：选项A-D、答案、解析、知识点。\n' +
      '3. 如果某道题在正文中没有对应挖空（如语法辨析题、读音题、阅读选择题），' +
      '也照常输出，不要报错，系统会把它归为「附加题目」；这类题请用【题N题干】写明题目问的是什么。\n' +
      '4. 解析用中文，知识点用「～语法」的形式。\n' +
      '5. 严格按下面的格式输出，不要输出任何其他内容：\n\n' +
      '【书名】' + bookName + '\n【单元】' + unitName + '\n\n' +
      '【标题】文章标题\n【正文】\n……（1）……（2）……\n' +
      '【题1选项A】…\n【题1选项B】…\n【题1选项C】…\n【题1选项D】…\n' +
      '【题1答案】A\n【题1解析】…\n【题1知识点】～ばかり\n\n' +
      '（第 2 空起重复 题N选项A-D / 题N答案 / 题N解析 / 题N知识点；' +
      '正文外的独立题额外加一行【题N题干】；多篇文章之间用空行分隔）\n\n' +
      '下面是我要整理的资料：\n【粘贴你的文章和题目】';
  }

  /* ---------- 导入归属：下拉选已有书籍/单元 ---------- */

  function scopeBookOpts() {
    return '<option value="">📄 跟随文本（按文中【书名】自动归类）</option>' +
      Store.getReadingBooks().map(b =>
        '<option value="' + esc(b.id) + '"' + (selBook === b.id ? ' selected' : '') +
        '>📖 ' + esc(b.name) + '</option>').join('') +
      '<option value="__new__">＋ 新建书籍…</option>';
  }

  function scopeUnitOpts() {
    const book = selBook ? Store.getReadingBookById(selBook) : null;
    if (!book) return '<option value="">先选书籍，或跟随文本</option>';
    const cur = selUnit || '__auto__';
    return '<option value="__auto__"' + (cur === '__auto__' ? ' selected' : '') +
      '>📄 跟随文本（按文中【单元】）</option>' +
      (book.units || []).map(u =>
        '<option value="' + esc(u.id) + '"' + (cur === u.id ? ' selected' : '') +
        '>📘 ' + esc(u.name) + '</option>').join('') +
      '<option value="__new__">＋ 新建单元…</option>';
  }

  function scopeHint() {
    if (!selBook) {
      return '未指定具体书籍：文中写了【书名】【单元】就按它自动建书/单元；' +
        '没写【书名】的文章统一进《阅读理解》的「未分单元」。';
    }
    const book = Store.getReadingBookById(selBook);
    if (!book) return '未指定具体书籍时按文本自动归类。';
    if (selUnit && selUnit !== '__auto__') {
      const u = (book.units || []).find(x => x.id === selUnit);
      if (u) return '全部文章将导入到《' + esc(book.name) + '》「' + esc(u.name) + '」。';
    }
    return '书籍固定为《' + esc(book.name) +
      '》；单元跟随文中的【单元】自动归类，没写【单元】的进「未分单元」。';
  }

  /**
   * 解析一篇数据最终落到的书/单元（预览用，不写库）：
   * 返回 { bookName, unitName }
   */
  function previewTarget(d) {
    if (!selBook) {
      return { bookName: d.book || '阅读理解（自动新建）', unitName: d.unit || '未分单元' };
    }
    const book = Store.getReadingBookById(selBook);
    if (!book) return { bookName: d.book || '阅读理解（自动新建）', unitName: d.unit || '未分单元' };
    if (selUnit && selUnit !== '__auto__') {
      const u = (book.units || []).find(x => x.id === selUnit);
      if (u) return { bookName: book.name, unitName: u.name };
    }
    return { bookName: book.name, unitName: d.unit || '未分单元（跟随文本）' };
  }

  /** 确认导入时解析并确保书/单元存在，返回 {book, unit} */
  function resolveTarget(d) {
    if (!selBook) {
      const book = Store.ensureReadingBook(d.book || '阅读理解');
      return { book, unit: Store.ensureReadingUnit(book.id, d.unit || '未分单元') };
    }
    let book = Store.getReadingBookById(selBook);
    if (!book) {
      book = Store.ensureReadingBook(d.book || '阅读理解');
    }
    if (selUnit && selUnit !== '__auto__') {
      const u = (book.units || []).find(x => x.id === selUnit);
      if (u) return { book, unit: u };
    }
    return { book, unit: Store.ensureReadingUnit(book.id, d.unit || '未分单元') };
  }

  /** 重渲染导入页前先留住 textarea 内容 */
  function syncImportText() {
    const ta = document.getElementById('rcText');
    if (ta) importText = ta.value;
  }

  function renderImport() {
    passId = null;
    const previewHTML = importPreview ? previewListHTML() : '';
    B().setHTML(
      '<a class="back-link" href="#/reading">‹ 返回</a>' +
      '<header class="page-head"><h1>导入阅读理解</h1>' +
      '<div class="sub">粘贴文章与题目文本（挖空题、正文外附加题都支持），自动解析进书架</div></header>' +

      '<div class="import-card">' +
      '<label>文章文本（可一次粘贴多篇批量导入）</label>' +
      '<textarea id="rcText" placeholder="【标题】心の問題との向き合い&#10;【正文】&#10;自分は心の問題とは無縁（1）と高を括っている人もいるでしょう。…&#10;【题1选项A】に&#10;【题1选项B】とは&#10;【题1选项C】で&#10;【题1选项D】を&#10;【题1答案】B&#10;【题1解析】「無縁とは」表示……&#10;【题1知识点】～ばかり">' +
      esc(importText) + '</textarea>' +
      '<details class="rc-fmt"><summary>📖 格式说明</summary>' +
      '<div class="fmt-hint" style="white-space:pre-line">' + esc(FORMAT_HINT) + '</div></details>' +
      '</div>' +

      '<div class="import-card">' +
      '<label>导入到哪个书籍 / 单元</label>' +
      '<div class="rc-def-row">' +
      '<select id="rcSelBook" class="rc-scope-sel">' + scopeBookOpts() + '</select>' +
      '<select id="rcSelUnit" class="rc-scope-sel"' + (selBook ? '' : ' disabled') + '>' +
      scopeUnitOpts() + '</select>' +
      '</div>' +
      '<div class="fmt-hint" id="rcScopeHint">' + scopeHint() + '</div></div>' +

      '<div class="rc-toolbar">' +
      '<button class="btn btn-ink" data-rc="ai-prompt">🤖 复制 AI 整理提示词</button>' +
      '<button class="btn btn-primary" data-rc="import-parse">解析预览</button>' +
      '</div>' +
      previewHTML
    );
  }

  function previewListHTML() {
    const valid = importPreview.filter(p => p.valid);
    return '<div class="ai-preview">' +
      '<div class="ai-pv-sum">解析出 ' + importPreview.length + ' 篇：有效 ' + valid.length +
      (importPreview.length - valid.length ? '，无效 ' + (importPreview.length - valid.length) : '') +
      '</div>' +
      importPreview.map(p => {
        if (!p.valid) {
          return '<div class="ai-pv-item rc-pv-err"><b>第 ' + p.index + ' 篇</b>' +
            esc(p.errors.join('；')) + '</div>';
        }
        const d = p.data;
        const t = previewTarget(d);
        const parts = [];
        if (d.blanks.length) parts.push('挖空 ' + d.blanks.length + ' 题');
        if (d.extras.length) parts.push('附加 ' + d.extras.length + ' 题');
        return '<div class="ai-pv-item"><b>' + esc(d.title) + '</b>' +
          esc(t.bookName + ' / ' + t.unitName) +
          ' · ' + esc(parts.join(' · ') || '无题目') + '</div>';
      }).join('') +
      (valid.length ?
        '<button class="btn btn-ink" data-rc="import-confirm" style="margin-top:12px">一键导入 ' +
        valid.length + ' 篇</button>' :
        '<div class="ai-pv-err">没有可导入的有效文章，请对照格式说明检查</div>') +
      '</div>';
  }

  function doImportParse() {
    syncImportText();
    if (!importText.trim()) { B().toast('请先粘贴文章文本'); return; }
    importPreview = Parser.parseReadingText(importText);
    if (!importPreview.length) { B().toast('没有识别到文章，每篇需以【标题】开头'); importPreview = null; }
    renderImport();
  }

  function doImportConfirm() {
    if (!importPreview) return;
    const valid = importPreview.filter(p => p.valid);
    if (!valid.length) return;
    let added = 0, skipped = 0;
    valid.forEach(p => {
      const d = p.data;
      const { book, unit } = resolveTarget(d);
      const dup = (unit.articles || []).some(x => x.title === d.title);
      if (dup) { skipped++; return; }
      Store.addReadingArticle(book.id, unit.id, {
        id: Store.uid('ra'),
        title: d.title,
        text: d.text,
        createdAt: Date.now(),
        favorite: false,
        blanks: d.blanks.map(b => ({
          no: b.no, options: b.options, answer: b.answer,
          explanation: b.explanation, points: b.points, qid: null, lastWrong: false
        })),
        extras: d.extras.map(q => ({
          no: q.no, stem: q.stem || '', options: q.options, answer: q.answer,
          explanation: q.explanation, points: q.points, qid: null, lastWrong: false
        })),
        precisionId: null,
        state: freshState()
      });
      added++;
    });
    importPreview = null;
    importText = '';
    B().toast('已导入 ' + added + ' 篇' + (skipped ? '，跳过重名 ' + skipped + ' 篇' : ''));
    location.hash = '#/reading';
  }

  /* ================= 书籍 / 单元管理 ================= */

  function doNewBook() {
    const name = prompt('新书籍名称：');
    if (name == null) return;
    const b = Store.addReadingBook(name);
    if (!b) { B().toast('书籍名称为空或与现有书籍重名'); return; }
    renderShelf();
  }

  function doRenameBook(id) {
    const b = Store.getReadingBookById(id);
    if (!b) return;
    const name = prompt('重命名书籍：', b.name);
    if (name == null) return;
    if (!Store.renameReadingBook(id, name)) { B().toast('名称为空或与其他书籍重名'); return; }
    rerender();
  }

  function doDelBook(id) {
    const b = Store.getReadingBookById(id);
    if (!b) return;
    const st = bookStats(b);
    if (!confirm('删除《' + b.name + '》？其下 ' + st.units + ' 个单元、' + st.count +
      ' 篇文章将一并删除，已同步进错题本的记录也会移除。')) return;
    Store.deleteReadingBook(id);
    B().toast('已删除');
    B().refreshBadge();
    renderShelf();
  }

  function doNewUnit(bookId) {
    const book = Store.getReadingBookById(bookId);
    if (!book) return;
    const name = prompt('在《' + book.name + '》下新建单元：');
    if (name == null) return;
    const u = Store.addReadingUnit(bookId, name);
    if (!u) { B().toast('单元名称为空或与本书已有单元重名'); return; }
    rerender();
  }

  function doRenameUnit(bookId, unitId) {
    const book = Store.getReadingBookById(bookId);
    const u = book && (book.units || []).find(x => x.id === unitId);
    if (!u) return;
    const name = prompt('重命名单元：', u.name);
    if (name == null) return;
    if (!Store.renameReadingUnit(bookId, unitId, name)) {
      B().toast('名称为空或与本书已有单元重名');
      return;
    }
    rerender();
  }

  function doDelUnit(bookId, unitId) {
    const book = Store.getReadingBookById(bookId);
    const u = book && (book.units || []).find(x => x.id === unitId);
    if (!u) return;
    const st = unitStats(u);
    if (!confirm('删除单元「' + u.name + '」？其下 ' + st.count +
      ' 篇文章（含全部挖空题与附加题）将一并删除，已同步进错题本的记录也会移除。')) return;
    Store.deleteReadingUnit(bookId, unitId);
    B().toast('已删除');
    B().refreshBadge();
    /* 在单元详情页删除后返回书籍页；在书籍页展开行删除时原地刷新 */
    if ((location.hash || '').indexOf('#/reading/unit/') === 0) {
      location.hash = '#/reading/book/' + encodeURIComponent(bookId);
    } else {
      rerender();
    }
  }

  function doDelArticle(id) {
    if (!confirm('删除这篇文章？已同步进错题本的相关记录会一并移除。')) return;
    const hit = Store.findReadingArticle(id);
    Store.deleteReadingArticle(id);
    B().toast('已删除');
    B().refreshBadge();
    if (passId === id) {
      location.hash = hit
        ? '#/reading/unit/' + encodeURIComponent(hit.book.id) + '/' + encodeURIComponent(hit.unit.id)
        : '#/reading';
      return;
    }
    rerender();
  }

  /* ================= 事件（独立委托，action 前缀 data-rc） ================= */

  /** 按当前 hash 重新渲染本模块页面 */
  function rerender() {
    const parts = (location.hash || '#/reading').slice(2).split('/').map(decodeURIComponent);
    dispatch(parts);
  }

  function dispatch(parts) {
    if (parts[1] === 'import') return renderImport();
    if (parts[1] === 'book') return renderBook(parts[2]);
    if (parts[1] === 'unit') return renderUnit(parts[2], parts[3]);
    if (parts[1] === 'pass') return renderPassage(parts[2]);
    return renderShelf();
  }

  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-rc]');
    if (!el) return;
    switch (el.dataset.rc) {
      case 'open-book': location.hash = '#/reading/book/' + encodeURIComponent(el.dataset.id); break;
      case 'open-unit':
        e.stopPropagation();
        location.hash = '#/reading/unit/' + encodeURIComponent(el.dataset.book) +
          '/' + encodeURIComponent(el.dataset.id);
        break;
      case 'open-pass': location.hash = '#/reading/pass/' + encodeURIComponent(el.dataset.id); break;
      case 'unit-toggle': {
        const id = el.dataset.id;
        unitExpanded[id] = !unitExpanded[id];
        const y = window.scrollY;
        rerender();
        window.scrollTo(0, y);
        break;
      }
      case 'new-book': doNewBook(); break;
      case 'rename-book': doRenameBook(el.dataset.id); break;
      case 'del-book': doDelBook(el.dataset.id); break;
      case 'new-unit': doNewUnit(el.dataset.book); break;
      case 'rename-unit': doRenameUnit(el.dataset.book, el.dataset.id); break;
      case 'del-unit': doDelUnit(el.dataset.book, el.dataset.id); break;
      case 'del-article':
        e.stopPropagation();
        doDelArticle(el.dataset.id);
        break;
      case 'opt': doOpt(el.dataset.kind || 'blank', Number(el.dataset.no), el.dataset.letter); break;
      case 'mode': {
        const hit = locate();
        if (hit) {
          const s = normState(hit.article);
          if (Object.keys(s.chosen).length && !s.submitted) {
            B().toast('已开始作答，模式无法切换');
            break;
          }
        }
        passMode = el.dataset.mode;
        rerender();
        break;
      }
      case 'submit': doSubmit(); break;
      case 'restart': doRestart(); break;
      case 'mark-blank': doMarkBlank(el.dataset.kind || 'blank', Number(el.dataset.no)); break;
      case 'fav': {
        const hit = locate();
        if (!hit) break;
        hit.article.favorite = !hit.article.favorite;
        Store.updateReadingArticle(hit.article);
        refreshPassage();
        break;
      }
      case 'to-precision': doToPrecision(); break;
      case 'ai-prompt':
        B().copyText(buildAIPrompt()).then(
          () => B().toast('提示词已复制（已带入当前书籍/单元），发给任意 AI 即可'),
          () => B().toast('复制失败，请长按手动选择'));
        break;
      case 'import-parse': doImportParse(); break;
      case 'import-confirm': doImportConfirm(); break;
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.id === 'rcSort') {
      shelfSort = e.target.value === 'study' ? 'study' : 'created';
      renderShelf();
      return;
    }
    if (e.target.id === 'rcSelBook') {
      syncImportText();
      let v = e.target.value;
      if (v === '__new__') {
        const name = prompt('新书籍名称：');
        if (name == null) {
          v = selBook || '';
        } else {
          const nb = Store.addReadingBook(name);
          if (!nb) { B().toast('书籍名称为空或与现有书籍重名'); v = selBook || ''; }
          else v = nb.id;
        }
      }
      selBook = v || '';
      /* 选定书后单元默认跟随文本；未选书时单元下拉禁用 */
      selUnit = selBook ? '__auto__' : '';
      renderImport();
      return;
    }
    if (e.target.id === 'rcSelUnit') {
      syncImportText();
      let v = e.target.value;
      if (v === '__new__') {
        const name = prompt('在该书下新建单元：');
        if (name == null) {
          v = selUnit || '__auto__';
        } else {
          const nu = Store.addReadingUnit(selBook, name);
          if (!nu) { B().toast('单元名称为空或与本书已有单元重名'); v = selUnit || '__auto__'; }
          else v = nu.id;
        }
      }
      selUnit = v || '__auto__';
      renderImport();
    }
  });

  /* ---------- 对外接口（app.js 路由调用） ---------- */
  window.ReadingPage = { dispatch };
})();
