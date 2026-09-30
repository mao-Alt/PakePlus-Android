/* =====================================================================
 * storage.js —— localStorage 数据层
 *
 * 存储的 key：
 *   jp_questions_v1  题目数组
 *   jp_cards_v1      考点卡片数组
 *   jp_completed_v1  完成状态 { 考点名称: true }
 *   jp_wrong_v1      错题ID数组（去重）
 *   jp_marked_v1     疑难/不确定 题目ID数组（蒙对或标记的题）
 *   jp_pointmeta_v1  考点元数据 { 考点名称: {lastPractice,attempts,wrongs,timeMs} }
 *   jp_seeded_v1     示例数据是否已初始化
 *   jp_books_v1      书籍/章节（纯分类层）
 *                    [{id,name,createdAt,chapters:[{id,name,createdAt}]}]
 *                    题目/卡片通过 bookId、chapterId 归属；字段缺失视为未分类
 * =================================================================== */

const Store = {
  KEYS: {
    questions: 'jp_questions_v1',
    cards: 'jp_cards_v1',
    completed: 'jp_completed_v1',
    wrong: 'jp_wrong_v1',
    marked: 'jp_marked_v1',
    pointMeta: 'jp_pointmeta_v1',
    seeded: 'jp_seeded_v1',
    bankVersion: 'jp_bank_version_v1',
    bankPurged: 'jp_bank_purged_v1',
    articles: 'jp_articles_v1',
    boss: 'jp_boss_v1',
    bombLog: 'jp_bomblog_v1',
    bombCustom: 'jp_bombcustom_v1',
    bombLabels: 'jp_bomblabels_v1',
    bombProgress: 'jp_bombprogress_v1',
    books: 'jp_books_v1'
  },

  _read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const val = JSON.parse(raw);
      return val ?? fallback;
    } catch (e) {
      console.warn('读取失败:', key, e);
      return fallback;
    }
  },

  _write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error('写入失败:', key, e);
      throw e;
    }
  },

  /**
   * v5.8 起移除内置题库：按 bank-purge.js 的指纹，把旧版已合并进 localStorage
   * 的内置题目/卡片精准清除一次（用户自行导入的数据 id 带下划线，不会误伤）。
   * 联动清理：错题、疑难、已消失考点的完成标记与练习统计。
   * @returns {{skipped:boolean, questions:number, cards:number}}
   */
  purgeBuiltinBank() {
    const P = (typeof window !== 'undefined' && window.BUILTIN_PURGE) ||
      (typeof BUILTIN_PURGE !== 'undefined' ? BUILTIN_PURGE : null);
    const empty = { skipped: true, questions: 0, cards: 0 };
    if (!P || !P.version) return empty;
    if (localStorage.getItem(this.KEYS.bankPurged) === P.version) return empty;

    const qids = new Set(Array.isArray(P.questionIds) ? P.questionIds : []);
    const cnames = new Set(Array.isArray(P.cardNames) ? P.cardNames : []);

    /* 题目按内置 id 删除，同时收集被删 id 清错题/疑难 */
    const beforeQ = this.getQuestions();
    const removedQIds = new Set();
    const questions = [];
    beforeQ.forEach(q => {
      if (qids.has(q.id)) removedQIds.add(q.id);
      else questions.push(q);
    });
    if (removedQIds.size) {
      this.saveQuestions(questions);
      this._write(this.KEYS.wrong, this.getWrongIds().filter(id => !removedQIds.has(id)));
      this._write(this.KEYS.marked, this.getMarkedIds().filter(id => !removedQIds.has(id)));
    }

    /* 卡片按 name 删除（同名卡片本就视为同一张） */
    const beforeC = this.getCards();
    let removedCards = 0;
    const cards = beforeC.filter(c => {
      if (cnames.has(c.name)) { removedCards++; return false; }
      return true;
    });
    if (removedCards) this.saveCards(cards);

    /* 清理「既无题也无卡」的考点残留：完成标记 + 练习统计 */
    const leftPoints = new Set();
    questions.forEach(q => leftPoints.add(q.point));
    cards.forEach(c => leftPoints.add(c.name));

    const completed = this.getCompleted();
    let compChanged = false;
    Object.keys(completed).forEach(p => {
      if (!leftPoints.has(p)) { delete completed[p]; compChanged = true; }
    });
    if (compChanged) this._write(this.KEYS.completed, completed);

    const meta = this.getPointMeta();
    let metaChanged = false;
    Object.keys(meta).forEach(p => {
      if (!leftPoints.has(p)) { delete meta[p]; metaChanged = true; }
    });
    if (metaChanged) this._write(this.KEYS.pointMeta, meta);

    /* 旧版本号标记清掉，避免任何遗留逻辑再触发内置合并 */
    localStorage.removeItem(this.KEYS.bankVersion);
    localStorage.setItem(this.KEYS.bankPurged, P.version);
    return { skipped: false, questions: removedQIds.size, cards: removedCards };
  },

  /* ---------------- 题目 ---------------- */
  getQuestions() {
    return this._read(this.KEYS.questions, []);
  },

  saveQuestions(list) {
    this._write(this.KEYS.questions, list);
  },

  getQuestionById(id) {
    return this.getQuestions().find(q => q.id === id) || null;
  },

  /** 批量加入题目（已去重） */
  addQuestions(newItems) {
    const list = this.getQuestions();
    list.push(...newItems);
    this.saveQuestions(list);
  },

  /** 删除指定考点的全部题目（同时清理错题/疑难引用） */
  deleteQuestionsByPoint(pointName) {
    const removed = this.getQuestions().filter(q => q.point === pointName);
    const ids = new Set(removed.map(q => q.id));
    this.saveQuestions(this.getQuestions().filter(q => q.point !== pointName));
    if (ids.size) {
      this._write(this.KEYS.wrong, this.getWrongIds().filter(id => !ids.has(id)));
      this._write(this.KEYS.marked, this.getMarkedIds().filter(id => !ids.has(id)));
    }
    return removed.length;
  },

  /** 只保留指定考点的题目 */
  keepOnlyPoint(pointName) {
    const removed = this.getQuestions().filter(q => q.point !== pointName);
    const ids = new Set(removed.map(q => q.id));
    this.saveQuestions(this.getQuestions().filter(q => q.point === pointName));
    if (ids.size) {
      this._write(this.KEYS.wrong, this.getWrongIds().filter(id => !ids.has(id)));
      this._write(this.KEYS.marked, this.getMarkedIds().filter(id => !ids.has(id)));
    }
    return removed.length;
  },

  /* ---------------- 考点卡片 ---------------- */
  getCards() {
    return this._read(this.KEYS.cards, []);
  },

  saveCards(list) {
    this._write(this.KEYS.cards, list);
  },

  getCardByName(name) {
    return this.getCards().find(c => c.name === name) || null;
  },

  /**
   * 导入卡片：同名则更新内容，否则新增
   * @returns {{added:number, updated:number}}
   */
  upsertCards(items) {
    const list = this.getCards();
    let added = 0, updated = 0;
    items.forEach(item => {
      const idx = list.findIndex(c => c.name === item.name);
      if (idx === -1) {
        list.push(item);
        added++;
      } else {
        list[idx] = { ...list[idx], ...item, id: list[idx].id };
        updated++;
      }
    });
    this.saveCards(list);
    return { added, updated };
  },

  /* ---------------- 完成状态 ---------------- */
  getCompleted() {
    return this._read(this.KEYS.completed, {});
  },

  isCompleted(pointName) {
    return !!this.getCompleted()[pointName];
  },

  markCompleted(pointName) {
    const map = this.getCompleted();
    if (!map[pointName]) {
      map[pointName] = true;
      this._write(this.KEYS.completed, map);
    }
  },

  /* ---------------- 错题本 ---------------- */
  getWrongIds() {
    return this._read(this.KEYS.wrong, []);
  },

  getWrongQuestions() {
    const ids = this.getWrongIds();
    const qs = this.getQuestions();
    // 保持错题顺序；题库中已被删除的题目过滤掉并顺手清理
    const existing = new Map(qs.map(q => [q.id, q]));
    const valid = ids.filter(id => existing.has(id));
    if (valid.length !== ids.length) this._write(this.KEYS.wrong, valid);
    return valid.map(id => existing.get(id));
  },

  addWrong(qid) {
    const ids = this.getWrongIds();
    if (!ids.includes(qid)) {
      ids.push(qid);
      this._write(this.KEYS.wrong, ids);
    }
  },

  removeWrong(qid) {
    const ids = this.getWrongIds().filter(x => x !== qid);
    this._write(this.KEYS.wrong, ids);
  },

  wrongCount() {
    return this.getWrongIds().length;
  },

  /* ---------------- 疑难 / 不确定 标记 ---------------- */
  getMarkedIds() {
    return this._read(this.KEYS.marked, []);
  },

  getMarkedQuestions() {
    const ids = this.getMarkedIds();
    const qs = this.getQuestions();
    const existing = new Map(qs.map(q => [q.id, q]));
    const valid = ids.filter(id => existing.has(id));
    if (valid.length !== ids.length) this._write(this.KEYS.marked, valid);
    return valid.map(id => existing.get(id));
  },

  addMarked(qid) {
    const ids = this.getMarkedIds();
    if (!ids.includes(qid)) {
      ids.push(qid);
      this._write(this.KEYS.marked, ids);
    }
  },

  removeMarked(qid) {
    this._write(this.KEYS.marked, this.getMarkedIds().filter(x => x !== qid));
  },

  markedCount() {
    return this.getMarkedIds().length;
  },

  /* ---------------- 考点元数据（用于优先级/复习提醒/统计） ---------------- */
  getPointMeta() {
    return this._read(this.KEYS.pointMeta, {});
  },

  getPointMetaOf(name) {
    return this.getPointMeta()[name] ||
      { lastPractice: 0, attempts: 0, wrongs: 0, timeMs: 0 };
  },

  /**
   * 累加本次刷题的统计
   * @param {Object} agg { 考点名称: {attempts, wrongs, timeMs} }
   */
  recordPractice(agg) {
    const meta = this.getPointMeta();
    const now = Date.now();
    Object.keys(agg).forEach(name => {
      const a = agg[name];
      const m = meta[name] || { lastPractice: 0, attempts: 0, wrongs: 0, timeMs: 0 };
      m.attempts += a.attempts || 0;
      m.wrongs += a.wrongs || 0;
      m.timeMs += a.timeMs || 0;
      m.lastPractice = now;
      meta[name] = m;
    });
    this._write(this.KEYS.pointMeta, meta);
  },

  /* ---------------- 文章精读 ---------------- */
  getArticles() {
    return this._read(this.KEYS.articles, []);
  },

  saveArticles(list) {
    this._write(this.KEYS.articles, list);
  },

  getArticleById(id) {
    return this.getArticles().find(a => a.id === id) || null;
  },

  /** 新文章插到最前 */
  addArticle(a) {
    const list = this.getArticles();
    list.unshift(a);
    this.saveArticles(list);
  },

  updateArticle(a) {
    const list = this.getArticles();
    const i = list.findIndex(x => x.id === a.id);
    if (i > -1) {
      list[i] = a;
      this.saveArticles(list);
    }
  },

  deleteArticle(id) {
    this.saveArticles(this.getArticles().filter(x => x.id !== id));
  },

  /* ---------------- 训练场（Boss 战 / 拆弹） ---------------- */
  /** Boss 战绩 { 考点名称: {stars, tries} } */
  getBossProgress() {
    return this._read(this.KEYS.boss, {});
  },

  saveBossProgress(p) {
    this._write(this.KEYS.boss, p);
  },

  /** 拆弹错题记录 [{ts, tag, chunk, chose, correct, reason}] */
  getBombLog() {
    return this._read(this.KEYS.bombLog, []);
  },

  saveBombLog(list) {
    this._write(this.KEYS.bombLog, list);
  },

  /** 追加拆弹错题记录（保留最近 200 条，防止无限膨胀） */
  addBombLog(entries) {
    const list = this.getBombLog().concat(entries || []).slice(-200);
    this.saveBombLog(list);
  },

  /** 拆弹闯关进度 { "1": {cur,done,assigns,judged,wrongs,partials,recorded}, ... } */
  getBombProgress() {
    return this._read(this.KEYS.bombProgress, {});
  },

  saveBombProgress(p) {
    this._write(this.KEYS.bombProgress, p && typeof p === 'object' ? p : {});
  },

  /* ---------------- 拆弹自定义句库（批量导入） ---------------- */
  /** 自定义拆弹句数组 [{id,lv,tag,note,chunks:[{t,r,m,x}]}] */
  getBombCustom() {
    return this._read(this.KEYS.bombCustom, []);
  },

  saveBombCustom(list) {
    this._write(this.KEYS.bombCustom, list);
  },

  /** 句子去重键：难度 + 各块文本拼合 */
  _bombSentenceKey(lv, chunks, getT) {
    return lv + '|' + chunks.map(getT).join('');
  },

  /**
   * 批量追加拆弹句（导入前已归一化并带 id），自动去重
   * @returns {{added:number, dup:number, total:number}}
   */
  addBombCustom(items) {
    const list = this.getBombCustom();
    const have = new Set(list.map(s =>
      this._bombSentenceKey(s.lv, s.chunks, c => c.t)));
    (window.BOMB_BANK || []).forEach(s =>
      have.add(this._bombSentenceKey(s[0], s[3], c => c[0])));

    let added = 0, dup = 0;
    (items || []).forEach(s => {
      const key = this._bombSentenceKey(s.lv, s.chunks, c => c.t);
      if (have.has(key)) { dup++; return; }
      have.add(key);
      list.push(s);
      added++;
    });
    this.saveBombCustom(list);
    return { added, dup, total: list.length };
  },

  /** 删除指定 id 的自定义句，返回剩余条数 */
  deleteBombCustom(id) {
    const list = this.getBombCustom().filter(s => s.id !== id);
    this.saveBombCustom(list);
    return list.length;
  },

  clearBombCustom() {
    this.saveBombCustom([]);
  },

  /* ---------------- 拆弹自定义细分标签（导入 JSON 的 labels 字段） ---------------- */
  /** {SUB:[...], PRED:[...], OBJ:[...], MOD:[...], COMP:[...]} */
  getBombLabels() {
    return this._read(this.KEYS.bombLabels, {});
  },

  saveBombLabels(obj) {
    this._write(this.KEYS.bombLabels, obj && typeof obj === 'object' ? obj : {});
  },

  /** 合并导入的 labels：只在各大类下追加新标签 */
  mergeBombLabels(incoming) {
    if (!incoming || typeof incoming !== 'object') return 0;
    const cur = this.getBombLabels();
    let added = 0;
    ['SUB', 'PRED', 'OBJ', 'MOD', 'COMP'].forEach(k => {
      const base = Array.isArray(cur[k]) ? cur[k].slice() : [];
      (Array.isArray(incoming[k]) ? incoming[k] : []).forEach(x => {
        const v = String(x || '').trim();
        if (v && base.indexOf(v) === -1) { base.push(v); added++; }
      });
      if (base.length) cur[k] = base;
    });
    if (added) this.saveBombLabels(cur);
    return added;
  },

  /* ---------------- 书籍 / 章节（纯分类层） ---------------- */
  /** 书籍数组 [{id,name,createdAt,chapters:[{id,name,createdAt}]}] */
  getBooks() {
    return this._read(this.KEYS.books, []);
  },

  saveBooks(list) {
    this._write(this.KEYS.books, Array.isArray(list) ? list : []);
  },

  getBookById(id) {
    return this.getBooks().find(b => b.id === id) || null;
  },

  /** 新建书籍（同名忽略大小写/空白判重），返回新书；重名或空名返回 null */
  addBook(name) {
    name = String(name || '').trim();
    if (!name) return null;
    const books = this.getBooks();
    if (books.some(b => b.name.trim().toLowerCase() === name.toLowerCase())) return null;
    const book = { id: this.uid('b'), name, createdAt: Date.now(), chapters: [] };
    books.push(book);
    this.saveBooks(books);
    return book;
  },

  renameBook(id, name) {
    name = String(name || '').trim();
    if (!name) return false;
    const books = this.getBooks();
    const b = books.find(x => x.id === id);
    if (!b) return false;
    if (books.some(x => x.id !== id &&
      x.name.trim().toLowerCase() === name.toLowerCase())) return false;
    b.name = name;
    this.saveBooks(books);
    return true;
  },

  /** 在指定书下新建章节（同一书内章节名唯一），返回新章节；否则 null */
  addChapter(bookId, name) {
    name = String(name || '').trim();
    if (!name) return null;
    const books = this.getBooks();
    const b = books.find(x => x.id === bookId);
    if (!b) return null;
    if (!Array.isArray(b.chapters)) b.chapters = [];
    if (b.chapters.some(c => c.name.trim().toLowerCase() === name.toLowerCase())) return null;
    const ch = { id: this.uid('ch'), name, createdAt: Date.now() };
    b.chapters.push(ch);
    this.saveBooks(books);
    return ch;
  },

  renameChapter(bookId, chapterId, name) {
    name = String(name || '').trim();
    if (!name) return false;
    const books = this.getBooks();
    const b = books.find(x => x.id === bookId);
    if (!b || !Array.isArray(b.chapters)) return false;
    const c = b.chapters.find(x => x.id === chapterId);
    if (!c) return false;
    if (b.chapters.some(x => x.id !== chapterId &&
      x.name.trim().toLowerCase() === name.toLowerCase())) return false;
    c.name = name;
    this.saveBooks(books);
    return true;
  },

  /**
   * 删除命中的题目与卡片，并联动清理错题/疑难引用、
   * 已消失考点的完成标记与练习统计。
   * @returns {{questions:number, cards:number}}
   */
  _purgeScoped(matchQ, matchC) {
    const beforeQ = this.getQuestions();
    const removedIds = new Set();
    const qs = [];
    beforeQ.forEach(q => {
      if (matchQ(q)) removedIds.add(q.id);
      else qs.push(q);
    });
    if (removedIds.size) {
      this.saveQuestions(qs);
      this._write(this.KEYS.wrong, this.getWrongIds().filter(id => !removedIds.has(id)));
      this._write(this.KEYS.marked, this.getMarkedIds().filter(id => !removedIds.has(id)));
    }

    const beforeC = this.getCards();
    const cards = beforeC.filter(c => !matchC(c));
    if (cards.length !== beforeC.length) this.saveCards(cards);

    this._cleanOrphanPointMeta(qs, cards);
    return { questions: removedIds.size, cards: beforeC.length - cards.length };
  },

  /** 清理题库/卡库中已不存在的考点残留（完成标记 + 练习统计） */
  _cleanOrphanPointMeta(questions, cards) {
    const left = new Set();
    questions.forEach(q => q.point && left.add(q.point));
    cards.forEach(c => c.name && left.add(c.name));

    const completed = this.getCompleted();
    let compChanged = false;
    Object.keys(completed).forEach(p => {
      if (!left.has(p)) { delete completed[p]; compChanged = true; }
    });
    if (compChanged) this._write(this.KEYS.completed, completed);

    const meta = this.getPointMeta();
    let metaChanged = false;
    Object.keys(meta).forEach(p => {
      if (!left.has(p)) { delete meta[p]; metaChanged = true; }
    });
    if (metaChanged) this._write(this.KEYS.pointMeta, meta);
  },

  /** 删除整本书：连带其下所有章节、题目、卡片 */
  deleteBook(id) {
    const r = this._purgeScoped(
      q => q.bookId === id,
      c => c.bookId === id
    );
    this.saveBooks(this.getBooks().filter(b => b.id !== id));
    return r;
  },

  /** 删除某书下的单个章节：先删题目卡片，再从书中移除章节记录 */
  deleteChapter(bookId, chapterId) {
    const inChapter = o => o.bookId === bookId && o.chapterId === chapterId;
    const r = this._purgeScoped(inChapter, inChapter);
    const books = this.getBooks();
    const b = books.find(x => x.id === bookId);
    if (b && Array.isArray(b.chapters)) {
      b.chapters = b.chapters.filter(c => c.id !== chapterId);
      this.saveBooks(books);
    }
    return r;
  },

  /**
   * 校正悬空归属：bookId/章节不存在时降级为未分类/未分章节。
   * 用于外部备份合并后保证书架数据一致。
   */
  reconcileScopes() {
    const books = this.getBooks();
    const bookIds = new Set();
    const chapterIds = {};
    books.forEach(b => {
      bookIds.add(b.id);
      chapterIds[b.id] = new Set((Array.isArray(b.chapters) ? b.chapters : [])
        .map(c => c.id));
    });

    const fix = (o) => {
      if (o.bookId && !bookIds.has(o.bookId)) {
        o.bookId = '';
        o.chapterId = '';
        return true;
      }
      if (o.chapterId &&
        !(chapterIds[o.bookId] && chapterIds[o.bookId].has(o.chapterId))) {
        o.chapterId = '';
        return true;
      }
      return false;
    };

    const qs = this.getQuestions();
    if (qs.some(fix)) this.saveQuestions(qs);
    const cs = this.getCards();
    if (cs.some(fix)) this.saveCards(cs);
  },

  /* ---------------- JSON 导出 / 导入 ---------------- */

  /** 导出全部数据为可迁移对象 */
  exportBundle() {
    return {
      app: 'jp-grammar-quiz',
      version: 1,
      exportedAt: new Date().toISOString(),
      questions: this.getQuestions(),
      cards: this.getCards(),
      completed: this.getCompleted(),
      wrongIds: this.getWrongIds(),
      markedIds: this.getMarkedIds(),
      pointMeta: this.getPointMeta(),
      articles: this.getArticles(),
      boss: this.getBossProgress(),
      bombLog: this.getBombLog(),
      bombCustom: this.getBombCustom(),
      bombProgress: this.getBombProgress(),
      books: this.getBooks()
    };
  },

  /**
   * 导入备份包
   * @param {Object} bundle 备份对象
   * @param {'merge'|'replace'} mode
   * @returns {Object} 处理结果统计
   */
  importBundle(bundle, mode) {
    if (!bundle || !Array.isArray(bundle.questions)) {
      throw new Error('文件格式不正确：缺少 questions 数组');
    }
    const isArr = Array.isArray;
    const result = { questions: 0, cardsAdded: 0, cardsUpdated: 0, replaced: false };

    if (mode === 'replace') {
      this.saveQuestions(bundle.questions);
      this.saveCards(isArr(bundle.cards) ? bundle.cards : []);
      this._write(this.KEYS.completed, bundle.completed && typeof bundle.completed === 'object' ? bundle.completed : {});
      this._write(this.KEYS.wrong, isArr(bundle.wrongIds) ? bundle.wrongIds : []);
      this._write(this.KEYS.marked, isArr(bundle.markedIds) ? bundle.markedIds : []);
      this._write(this.KEYS.pointMeta, bundle.pointMeta && typeof bundle.pointMeta === 'object' ? bundle.pointMeta : {});
      this._write(this.KEYS.articles, isArr(bundle.articles) ? bundle.articles : []);
      this._write(this.KEYS.boss, bundle.boss && typeof bundle.boss === 'object' ? bundle.boss : {});
      this._write(this.KEYS.bombLog, isArr(bundle.bombLog) ? bundle.bombLog : []);
      this._write(this.KEYS.bombCustom, isArr(bundle.bombCustom) ? bundle.bombCustom : []);
      this._write(this.KEYS.bombProgress, bundle.bombProgress && typeof bundle.bombProgress === 'object' ? bundle.bombProgress : {});
      this.saveBooks(isArr(bundle.books) ? bundle.books : []);
      this.reconcileScopes();
      result.questions = bundle.questions.length;
      result.replaced = true;
      return result;
    }

    /* 合并：题目按 id 去重 */
    const qs = this.getQuestions();
    const have = new Set(qs.map(q => q.id));
    bundle.questions.forEach(q => {
      if (q && q.id && !have.has(q.id)) {
        qs.push(q);
        have.add(q.id);
        result.questions++;
      }
    });
    this.saveQuestions(qs);

    if (isArr(bundle.cards) && bundle.cards.length) {
      const r = this.upsertCards(bundle.cards);
      result.cardsAdded = r.added;
      result.cardsUpdated = r.updated;
    }

    // 文章按 id 去重合并
    if (isArr(bundle.articles) && bundle.articles.length) {
      const arts = this.getArticles();
      const haveA = new Set(arts.map(a => a.id));
      bundle.articles.forEach(a => {
        if (a && a.id && !haveA.has(a.id)) {
          arts.push(a);
          haveA.add(a.id);
          result.articles = (result.articles || 0) + 1;
        }
      });
      this.saveArticles(arts);
    }

    // 进度类数据取并集
    if (bundle.completed && typeof bundle.completed === 'object') {
      const c = this.getCompleted();
      Object.keys(bundle.completed).forEach(k => { c[k] = true; });
      this._write(this.KEYS.completed, c);
    }
    if (isArr(bundle.wrongIds)) {
      const w = new Set(this.getWrongIds());
      bundle.wrongIds.forEach(id => w.add(id));
      this._write(this.KEYS.wrong, Array.from(w));
    }
    if (isArr(bundle.markedIds)) {
      const m = new Set(this.getMarkedIds());
      bundle.markedIds.forEach(id => m.add(id));
      this._write(this.KEYS.marked, Array.from(m));
    }
    if (bundle.pointMeta && typeof bundle.pointMeta === 'object') {
      const meta = this.getPointMeta();
      Object.keys(bundle.pointMeta).forEach(name => {
        const b = bundle.pointMeta[name];
        const m = meta[name] || { lastPractice: 0, attempts: 0, wrongs: 0, timeMs: 0 };
        m.attempts += b.attempts || 0;
        m.wrongs += b.wrongs || 0;
        m.timeMs += b.timeMs || 0;
        m.lastPractice = Math.max(m.lastPractice, b.lastPractice || 0);
        meta[name] = m;
      });
      this._write(this.KEYS.pointMeta, meta);
    }
    // Boss 战绩：取最高星级
    if (bundle.boss && typeof bundle.boss === 'object') {
      const bp = this.getBossProgress();
      Object.keys(bundle.boss).forEach(name => {
        const b = bundle.boss[name] || {};
        const cur = bp[name] || { stars: 0, tries: 0 };
        bp[name] = {
          stars: Math.max(cur.stars, b.stars || 0),
          tries: cur.tries + (b.tries || 0)
        };
      });
      this.saveBossProgress(bp);
    }
    // 拆弹错题：按 ts 去重合并
    if (isArr(bundle.bombLog) && bundle.bombLog.length) {
      const have = new Set(this.getBombLog().map(e => e.ts + '|' + e.chunk));
      const merged = this.getBombLog();
      bundle.bombLog.forEach(e => {
        if (e && e.ts && !have.has(e.ts + '|' + e.chunk)) {
          merged.push(e);
          have.add(e.ts + '|' + e.chunk);
        }
      });
      this.saveBombLog(merged.slice(-200));
    }
    // 自定义拆弹句：按句去重合并
    if (isArr(bundle.bombCustom) && bundle.bombCustom.length) {
      const r = this.addBombCustom(bundle.bombCustom);
      result.bombCustomAdded = r.added;
    }
    // 拆弹闯关进度：按难度取已完成句并集（当前做题位置保留本机的）
    if (bundle.bombProgress && typeof bundle.bombProgress === 'object') {
      const bp = this.getBombProgress();
      Object.keys(bundle.bombProgress).forEach(lv => {
        const inc = bundle.bombProgress[lv];
        if (!inc || typeof inc !== 'object') return;
        const cur = bp[lv] || { cur: '', done: [] };
        const set = new Set(Array.isArray(cur.done) ? cur.done : []);
        (Array.isArray(inc.done) ? inc.done : []).forEach(id => set.add(id));
        cur.done = Array.from(set);
        bp[lv] = cur;
      });
      this.saveBombProgress(bp);
    }
    // 书籍/章节：按 id 取并集，同书内章节按 id 取并集
    if (isArr(bundle.books) && bundle.books.length) {
      const books = this.getBooks();
      const index = new Map(books.map(b => [b.id, b]));
      bundle.books.forEach(inc => {
        if (!inc || !inc.id) return;
        const ex = index.get(inc.id);
        if (!ex) {
          books.push({
            id: inc.id, name: inc.name || '未命名书籍',
            createdAt: inc.createdAt || Date.now(),
            chapters: isArr(inc.chapters) ? inc.chapters : []
          });
        } else if (isArr(inc.chapters)) {
          if (!isArr(ex.chapters)) ex.chapters = [];
          const haveCh = new Set(ex.chapters.map(c => c.id));
          inc.chapters.forEach(c => {
            if (c && c.id && !haveCh.has(c.id)) ex.chapters.push(c);
          });
        }
      });
      this.saveBooks(books);
    }
    this.reconcileScopes();
    return result;
  },

  /** 生成唯一ID */
  uid(prefix) {
    return prefix + '_' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7);
  }
};
