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
 *   jp_reading_v1    阅读理解独立书架（书籍 → 单元 → 挖空文章，见下方注释）
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
    books: 'jp_books_v1',
    reading: 'jp_reading_v1'
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

  /** 删除指定考点的全部题目（联动清理错题/疑难；考点若彻底消失再清完成标记/统计） */
  deleteQuestionsByPoint(pointName) {
    const removed = this.getQuestions().filter(q => q.point === pointName);
    const ids = new Set(removed.map(q => q.id));
    const remain = this.getQuestions().filter(q => q.point !== pointName);
    this.saveQuestions(remain);
    if (ids.size) {
      this._write(this.KEYS.wrong, this.getWrongIds().filter(id => !ids.has(id)));
      this._write(this.KEYS.marked, this.getMarkedIds().filter(id => !ids.has(id)));
    }
    this._cleanOrphanPointMeta(remain, this.getCards());
    return removed.length;
  },

  /** 只保留指定考点的题目 */
  keepOnlyPoint(pointName) {
    const removed = this.getQuestions().filter(q => q.point !== pointName);
    const ids = new Set(removed.map(q => q.id));
    const remain = this.getQuestions().filter(q => q.point === pointName);
    this.saveQuestions(remain);
    if (ids.size) {
      this._write(this.KEYS.wrong, this.getWrongIds().filter(id => !ids.has(id)));
      this._write(this.KEYS.marked, this.getMarkedIds().filter(id => !ids.has(id)));
    }
    this._cleanOrphanPointMeta(remain, this.getCards());
    return removed.length;
  },

  /** 按 id 更新单道题（字段合并，id 不可改）；考点可能消失时清理残留统计 */
  updateQuestion(id, patch) {
    const qs = this.getQuestions();
    const i = qs.findIndex(q => q.id === id);
    if (i === -1) return null;
    qs[i] = { ...qs[i], ...(patch || {}), id: id };
    this.saveQuestions(qs);
    this._cleanOrphanPointMeta(qs, this.getCards());
    return qs[i];
  },

  /** 删除单道题，联动清理错题/疑难，返回是否删除成功 */
  deleteQuestion(id) {
    const qs = this.getQuestions();
    const remain = qs.filter(q => q.id !== id);
    if (remain.length === qs.length) return false;
    this.saveQuestions(remain);
    this._write(this.KEYS.wrong, this.getWrongIds().filter(x => x !== id));
    this._write(this.KEYS.marked, this.getMarkedIds().filter(x => x !== id));
    this._cleanOrphanPointMeta(remain, this.getCards());
    return true;
  },

  /** 批量按 id 删除题目，联动清理错题/疑难，返回删除条数 */
  deleteQuestionsByIds(ids) {
    const set = new Set(ids || []);
    if (!set.size) return 0;
    const qs = this.getQuestions();
    const remain = qs.filter(q => !set.has(q.id));
    const removed = qs.length - remain.length;
    if (!removed) return 0;
    this.saveQuestions(remain);
    this._write(this.KEYS.wrong, this.getWrongIds().filter(id => !set.has(id)));
    this._write(this.KEYS.marked, this.getMarkedIds().filter(id => !set.has(id)));
    this._cleanOrphanPointMeta(remain, this.getCards());
    return removed;
  },

  /**
   * 把单道题移动到另一个考点（错题/疑难随题保留）。
   * 目标考点有卡片时门类自动跟随卡片，可用 patch 覆盖。
   */
  moveQuestion(id, newPoint, patch) {
    newPoint = String(newPoint || '').trim();
    if (!newPoint) return null;
    const cat = patch && patch.category
      ? patch.category
      : ((this.getCardByName(newPoint) || {}).category || undefined);
    return this.updateQuestion(id, { point: newPoint, ...(cat ? { category: cat } : {}) });
  },

  /** 批量移动题目到另一考点，返回实际移动条数 */
  moveQuestions(ids, newPoint, patch) {
    newPoint = String(newPoint || '').trim();
    if (!newPoint) return 0;
    const set = new Set(ids || []);
    if (!set.size) return 0;
    const cat = patch && patch.category
      ? patch.category
      : ((this.getCardByName(newPoint) || {}).category || undefined);
    const qs = this.getQuestions();
    let n = 0;
    qs.forEach(q => {
      if (set.has(q.id)) {
        q.point = newPoint;
        if (cat) q.category = cat;
        n++;
      }
    });
    if (n) {
      this.saveQuestions(qs);
      this._cleanOrphanPointMeta(qs, this.getCards());
    }
    return n;
  },

  /** 题目去重键：主考点 + 来源（书·章节）+ 题干。
   *  同一考点在不同书各有一道同题干题，视为两道题，分别保留。 */
  questionDedupKey(point, stem, bookId, chapterId) {
    return [point || '', stem || '', bookId || '', chapterId || ''].join('||');
  },

  /**
   * 在指定考点下新增一道题（自动补 id；门类缺省跟随该考点卡片）。
   * 去重按「主考点 + 来源书章 + 题干」；成功后若题目有所属书章，
   * 自动给对应卡片追加该来源（卡片不会自己跑到别的单元）。
   * 返回题目对象；重复返回 {error:'dup'}。
   */
  addQuestionToPoint(point, question) {
    point = String(point || '').trim();
    if (!point || !question) return { error: 'invalid' };
    const qs = this.getQuestions();
    const stem = String(question.stem || '').trim();
    if (!stem) return { error: 'invalid' };
    const bookId = question.bookId !== undefined ? (question.bookId || '') : '';
    const chapterId = question.chapterId !== undefined ? (question.chapterId || '') : '';
    if (qs.some(q => this.questionDedupKey(q.point, q.stem, q.bookId, q.chapterId) ===
      this.questionDedupKey(point, stem, bookId, chapterId))) return { error: 'dup' };
    const card = this.getCardByName(point);
    const opts = question.options || {};
    const oc = question.optionCards || {};
    const item = {
      id: question.id || this.uid('q'),
      category: question.category || (card && card.category) || '自定义',
      point: point,
      type: question.type || '单选题',
      stem: stem,
      options: {
        A: String(opts.A == null ? '' : opts.A),
        B: String(opts.B == null ? '' : opts.B),
        C: String(opts.C == null ? '' : opts.C),
        D: String(opts.D == null ? '' : opts.D)
      },
      /* 选项 → 语法点卡片名指针（只存名，不复制卡片内容；缺省为空串） */
      optionCards: {
        A: oc.A ? String(oc.A) : '',
        B: oc.B ? String(oc.B) : '',
        C: oc.C ? String(oc.C) : '',
        D: oc.D ? String(oc.D) : ''
      },
      answer: 'ABCD'.includes(question.answer) ? question.answer : 'A',
      explanation: question.explanation || '',
      difficulty: question.difficulty || '中',
      bookId: bookId,
      chapterId: chapterId
    };
    qs.push(item);
    this.saveQuestions(qs);
    /* 题目带书章归属时，自动把该来源挂到卡片上（卡不存在不自动建） */
    if (bookId) this.ensureCardSource(point, bookId, chapterId);
    return item;
  },

  /**
   * 确保某考点的卡片挂有「书+章」这个来源：
   *  - 卡片不存在：不自动建卡（允许“只有题目没有卡片”的灰色词条），返回 'no-card'
   *  - 已有该来源：返回 'exists'
   *  - 新来源：复制主来源内容作为初始讲解（各来源之后可独立编辑），返回 'added'
   * 仅对明确归属（bookId 非空）生效；未分类题目不改变卡片归属。
   */
  ensureCardSource(point, bookId, chapterId) {
    point = String(point || '').trim();
    if (!point || !bookId) return 'no-scope';
    const cards = this.getCards();
    const i = cards.findIndex(c => c.name === point);
    if (i === -1) return 'no-card';
    const card = cards[i];
    if (!Array.isArray(card.sources) || !card.sources.length) card.sources = [];
    if (card.sources.some(s => this._scopeKey(s.bookId, s.chapterId) ===
      this._scopeKey(bookId, chapterId))) return 'exists';
    const base = card.sources[0] || {};
    card.sources.push(this._makeSource({
      bookId: bookId,
      chapterId: chapterId || '',
      summary: base.summary || card.summary || '',
      lecture: base.lecture || card.lecture || '',
      emphasis: base.emphasis || card.emphasis || '',
      examples: Array.isArray(base.examples) ? base.examples : (card.examples || [])
    }));
    this.saveCards(cards);
    return 'added';
  },

  /** 批量为题目补齐卡片来源（导入题目后调用），去重处理同一考点同一来源 */
  ensureCardSourcesForQuestions(questions) {
    const seen = new Set();
    let attached = 0;
    let noCard = 0;
    const noCardPoints = new Set();
    (questions || []).forEach(q => {
      if (!q || !q.point || !q.bookId) return;
      const k = q.point + '|' + q.bookId + '|' + (q.chapterId || '');
      if (seen.has(k)) return;
      seen.add(k);
      const r = this.ensureCardSource(q.point, q.bookId, q.chapterId);
      if (r === 'added') attached++;
      if (r === 'no-card') { noCard++; noCardPoints.add(q.point); }
    });
    return { attached: attached, noCard: noCard, points: Array.from(noCardPoints) };
  },

  /** 只保留某考点下指定 id 的题目，其余删除（联动清理），返回删除条数 */
  keepOnlyQuestions(point, ids) {
    const keep = new Set(ids || []);
    return this.deleteQuestionsByIds(
      this.getQuestions()
        .filter(q => q.point === point && !keep.has(q.id))
        .map(q => q.id)
    );
  },

  /* ---------------- 考点卡片 ---------------- */
  getCards() {
    return this._read(this.KEYS.cards, []);
  },

  /**
   * 卡片落盘前一律归一化：
   *  - 保证 sources 至少 1 条；旧卡（无 sources）用原顶层内容补出第一条来源
   *  - 顶层 summary/lecture/emphasis/examples/bookId/chapterId 镜像 sources[0]，
   *    使首页/文章精读等旧读取方看到的永远是「第一个来源」的内容
   */
  saveCards(list) {
    const norm = (list || []).map(c => this._normalizeCard(c).card);
    this._write(this.KEYS.cards, norm);
  },

  getCardByName(name) {
    return this.getCards().find(c => c.name === name) || null;
  },

  /* ---------------- 多来源（sources） ---------------- */

  /** 归一化单条来源：补 id/字段、清洗例句 */
  _makeSource(s) {
    s = s && typeof s === 'object' ? s : {};
    const examples = (Array.isArray(s.examples) ? s.examples : [])
      .filter(e => e && e.jp)
      .map(e => ({ jp: String(e.jp), cn: e.cn ? String(e.cn) : '' }));
    return {
      id: s.id || this.uid('s'),
      bookId: s.bookId || '',
      chapterId: s.chapterId || '',
      summary: s.summary || '',
      lecture: s.lecture || '',
      emphasis: s.emphasis || '',
      examples: examples
    };
  },

  /** 归一化整张卡片，返回 { card, changed } */
  _normalizeCard(card) {
    const c = { ...(card || {}) };
    let changed = false;

    let sources;
    if (Array.isArray(c.sources) && c.sources.length) {
      sources = c.sources.map(x => this._makeSource(x));
      if (c.sources.some(x => !x || !x.id)) changed = true;
    } else {
      /* 旧数据迁移：用原顶层内容补出第一个来源 */
      sources = [this._makeSource({
        bookId: c.bookId || '',
        chapterId: c.chapterId || '',
        summary: c.summary || '',
        lecture: c.lecture || '',
        emphasis: c.emphasis || '',
        examples: Array.isArray(c.examples) ? c.examples : []
      })];
      changed = true;
    }
    c.sources = sources;

    /* 顶层字段无条件镜像 sources[0]（保证旧数据缺键时也显式补成 ''） */
    const p = sources[0];
    if (c.summary !== p.summary) changed = true;
    if (c.lecture !== p.lecture) changed = true;
    if ((c.emphasis || '') !== p.emphasis) changed = true;
    if ((c.bookId || '') !== p.bookId) changed = true;
    if ((c.chapterId || '') !== p.chapterId) changed = true;
    if (JSON.stringify(c.examples || []) !== JSON.stringify(p.examples)) changed = true;
    c.summary = p.summary;
    c.lecture = p.lecture;
    c.emphasis = p.emphasis;
    c.bookId = p.bookId;
    c.chapterId = p.chapterId;
    c.examples = p.examples.map(e => ({ ...e }));
    return { card: c, changed: changed };
  },

  /**
   * 一次性迁移（幂等）：
   *  - 旧卡片自动补 sources（由 saveCards 归一化完成）
   *  - 旧题目缺 bookId/chapterId 时补空串
   * 有变更才写盘。应用启动与备份导入后调用。
   */
  migrateSources() {
    const raw = this.getCards();
    let cardChanged = false;
    const cards = raw.map(c => {
      const r = this._normalizeCard(c);
      if (r.changed) cardChanged = true;
      return r.card;
    });
    if (cardChanged) this._write(this.KEYS.cards, cards);

    const qs = this.getQuestions();
    let qChanged = false;
    qs.forEach(q => {
      if (q.bookId === undefined || q.bookId === null) { q.bookId = ''; qChanged = true; }
      if (q.chapterId === undefined || q.chapterId === null) { q.chapterId = ''; qChanged = true; }
    });
    if (qChanged) this.saveQuestions(qs);
    return { cards: cardChanged ? 1 : 0, questions: qChanged ? 1 : 0 };
  },

  /** 来源归属键：书 + 章节（未分类为 '|'） */
  _scopeKey(bookId, chapterId) {
    return (bookId || '') + '|' + (chapterId || '');
  },

  /** 卡片的全部归属（按 sources，顶层字段兜底；去重） */
  cardScopes(card) {
    if (!card) return [];
    const seen = new Set();
    const out = [];
    const push = (b, ch) => {
      b = b || ''; ch = ch || '';
      const k = this._scopeKey(b, ch);
      if (!seen.has(k)) { seen.add(k); out.push({ bookId: b, chapterId: ch }); }
    };
    (Array.isArray(card.sources) ? card.sources : []).forEach(s => {
      if (s) push(s.bookId, s.chapterId);
    });
    push(card.bookId, card.chapterId);
    return out;
  },

  /** 卡片是否归属指定书/章节 */
  cardHasScope(card, bookId, chapterId) {
    const b = bookId || '', ch = chapterId || '';
    return this.cardScopes(card).some(s => s.bookId === b && s.chapterId === ch);
  },

  /**
   * 单元（书+章）维度的卡片刷题进度：
   *  total 归属该单元的卡片数
   *  done  已刷完（completed 标记）
   *  half  刷过但没刷完（pointMeta.attempts>0 且未完成）
   *  fresh 还没刷过
   */
  chapterCardProgress(bookId, chapterId) {
    const cards = this.getCards().filter(c => this.cardHasScope(c, bookId, chapterId));
    const meta = this.getPointMeta();
    const doneMap = this.getCompleted();
    let done = 0, half = 0;
    cards.forEach(c => {
      if (doneMap[c.name]) done++;
      else if ((meta[c.name] && meta[c.name].attempts > 0)) half++;
    });
    return { total: cards.length, done, half, fresh: cards.length - done - half };
  },

  /**
   * 兼容接口：整卡写入（同名用 item 覆盖顶层内容）。
   * 落盘统一归一化，sources 缺省时自动补出。新代码请用 importCards。
   * @returns {{added:number, updated:number}}
   */
  upsertCards(items) {
    const list = this.getCards();
    let added = 0, updated = 0;
    (items || []).forEach(item => {
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

  /**
   * 导入卡片（多来源语义）：
   *  - 同名不存在：新建，当前内容作为第一个来源；
   *  - 同名已存在且书+章相同：更新该来源内容（主展示内容不变）；
   *  - 同名已存在但书+章不同：追加为新来源，不覆盖任何已有讲解。
   * @param {Array} items 卡片数据（含 bookId/chapterId/summary/lecture/emphasis/examples）
   * @returns {{added:number, appended:number, updated:number}}
   */
  importCards(items) {
    const list = this.getCards();
    const result = { added: 0, appended: 0, updated: 0 };
    (items || []).forEach(item => {
      if (!item || !item.name) return;
      /* v2 备份的卡片本身可能带整组 sources；普通导入则把本条当作一个来源 */
      const incoming = (Array.isArray(item.sources) && item.sources.length)
        ? item.sources.map(s => this._makeSource(s))
        : [this._makeSource({
          bookId: item.bookId || '',
          chapterId: item.chapterId || '',
          summary: item.summary || '',
          lecture: item.lecture || '',
          emphasis: item.emphasis || '',
          examples: Array.isArray(item.examples) ? item.examples : []
        })];

      const idx = list.findIndex(c => c.name === item.name);
      if (idx === -1) {
        list.push({
          ...item,
          id: item.id || this.uid('c'),
          category: item.category || '自定义语法',
          sources: incoming
        });
        result.added++;
        return;
      }
      const card = list[idx];
      if (!Array.isArray(card.sources) || !card.sources.length) card.sources = [];
      incoming.forEach(src => {
        const key = this._scopeKey(src.bookId, src.chapterId);
        const si = card.sources.findIndex(s =>
          this._scopeKey(s.bookId, s.chapterId) === key);
        if (si === -1) {
          card.sources.push(src);
          result.appended++;
        } else {
          card.sources[si] = { ...card.sources[si], ...src, id: card.sources[si].id };
          result.updated++;
        }
      });
    });
    this.saveCards(list);
    return result;
  },

  /**
   * 给卡片追加一个来源。书+章与现有来源重复时返回 {error:'dup'}，
   * 卡片不存在返回 null，成功返回更新后的卡片。
   */
  addCardSource(name, source) {
    const cards = this.getCards();
    const i = cards.findIndex(c => c.name === name);
    if (i === -1) return null;
    const src = this._makeSource(source);
    const key = this._scopeKey(src.bookId, src.chapterId);
    if ((cards[i].sources || []).some(s =>
      this._scopeKey(s.bookId, s.chapterId) === key)) {
      return { error: 'dup' };
    }
    cards[i].sources = (cards[i].sources || []).concat([src]);
    this.saveCards(cards);
    return this.getCardByName(name);
  },

  /**
   * 修改某条来源（可改归属/讲解/例句/侧重点）。
   * 改成与其他来源相同书+章时返回 {error:'dup'}；卡片或来源不存在返回 null。
   */
  updateCardSource(name, sourceId, patch) {
    patch = patch || {};
    const cards = this.getCards();
    const i = cards.findIndex(c => c.name === name);
    if (i === -1) return null;
    const sources = Array.isArray(cards[i].sources) ? cards[i].sources : [];
    const si = sources.findIndex(s => s.id === sourceId);
    if (si === -1) return null;
    const next = this._makeSource({ ...sources[si], ...patch, id: sourceId });
    const key = this._scopeKey(next.bookId, next.chapterId);
    if (sources.some((s, idx) => idx !== si &&
      this._scopeKey(s.bookId, s.chapterId) === key)) {
      return { error: 'dup' };
    }
    sources[si] = next;
    cards[i].sources = sources;
    this.saveCards(cards);
    return this.getCardByName(name);
  },

  /**
   * 删除某条来源。最后一条不允许删（返回 {error:'last'}）；
   * 删的是第一条时，后一条自动提升为主展示内容。
   */
  deleteCardSource(name, sourceId) {
    const cards = this.getCards();
    const i = cards.findIndex(c => c.name === name);
    if (i === -1) return null;
    const sources = Array.isArray(cards[i].sources) ? cards[i].sources : [];
    if (sources.length <= 1) return { error: 'last' };
    const si = sources.findIndex(s => s.id === sourceId);
    if (si === -1) return null;
    sources.splice(si, 1);
    cards[i].sources = sources;
    this.saveCards(cards);
    return this.getCardByName(name);
  },

  /**
   * 书籍/章节页「移出本章」：只删除卡片在指定书章下的来源。
   *  - 删除后仍有其他来源：卡片保留，返回 {removed:'source', remaining, removedScopes}
   *  - 这是最后一个来源：删除整张卡片（题目保留，章节页转为“缺卡片”灰条），
   *    返回 {removed:'card'}
   *  - 卡片或来源不存在：null / {error:'notfound'}
   */
  deleteCardScope(name, bookId, chapterId) {
    const cards = this.getCards();
    const i = cards.findIndex(c => c.name === name);
    if (i === -1) return null;
    const card = cards[i];
    const sources = Array.isArray(card.sources) ? card.sources : [];
    const key = this._scopeKey(bookId, chapterId);
    const matchIdx = sources.findIndex(s =>
      this._scopeKey(s.bookId, s.chapterId) === key);
    if (matchIdx === -1) return { error: 'notfound' };
    const removedScopes = sources
      .filter(s => this._scopeKey(s.bookId, s.chapterId) === key)
      .map(s => ({ bookId: s.bookId || '', chapterId: s.chapterId || '' }));
    const rest = sources.filter(s =>
      this._scopeKey(s.bookId, s.chapterId) !== key);
    if (rest.length) {
      card.sources = rest;
      cards[i] = card;
      this.saveCards(cards);
      return { removed: 'source', remaining: rest.length, removedScopes: removedScopes };
    }
    /* 最后一个来源：删除整张卡片（题目保留） */
    this.saveCards(cards.filter(c => c.name !== name));
    this._cleanOrphanPointMeta(this.getQuestions(), this.getCards());
    return { removed: 'card', removedScopes: removedScopes };
  },

  /** 删除某考点在指定书章下的全部题目（联动错题/疑难），不影响其他来源的题 */
  deleteQuestionsByPointScope(point, bookId, chapterId) {
    const b = bookId || '', ch = chapterId || '';
    const qs = this.getQuestions();
    const targets = qs.filter(q => q.point === point &&
      (q.bookId || '') === b && (q.chapterId || '') === ch);
    if (!targets.length) return 0;
    const ids = new Set(targets.map(q => q.id));
    const remain = qs.filter(q => !ids.has(q.id));
    this.saveQuestions(remain);
    this._write(this.KEYS.wrong, this.getWrongIds().filter(id => !ids.has(id)));
    this._write(this.KEYS.marked, this.getMarkedIds().filter(id => !ids.has(id)));
    this._cleanOrphanPointMeta(remain, this.getCards());
    return targets.length;
  },

  /**
   * 按名称更新卡片。改名时联动把该考点下所有题目的 point 指向新名称，
   * 并迁移完成标记、练习统计与 Boss 战绩（保留历史数据）。
   * @returns {Object|null|{error:'dup'|'invalid'}} 成功返回更新后的卡片，找不到返回 null
   */
  updateCard(name, patch) {
    patch = patch || {};
    const cards = this.getCards();
    const i = cards.findIndex(c => c.name === name);
    if (i === -1) return null;

    const next = { ...cards[i] };
    ['category', 'summary', 'lecture', 'emphasis'].forEach(k => {
      if (patch[k] !== undefined) next[k] = patch[k];
    });
    if (Array.isArray(patch.examples)) next.examples = patch.examples;

    /* 主内容即第一个来源：编辑顶层字段时同步写回 sources[0]，
       否则 saveCards 归一化的镜像会把修改覆盖掉 */
    if (Array.isArray(next.sources) && next.sources.length) {
      const s0 = next.sources[0];
      if (patch.summary !== undefined) s0.summary = next.summary;
      if (patch.lecture !== undefined) s0.lecture = next.lecture;
      if (patch.emphasis !== undefined) s0.emphasis = next.emphasis;
      if (Array.isArray(patch.examples)) {
        s0.examples = (patch.examples || []).filter(e => e && e.jp)
          .map(e => ({ jp: String(e.jp), cn: e.cn ? String(e.cn) : '' }));
      }
    }

    let newName = name;
    if (patch.name !== undefined) {
      newName = String(patch.name || '').trim();
      if (!newName) return { error: 'invalid' };
      if (newName !== name &&
        cards.some((c, idx) => idx !== i && c.name === newName)) {
        return { error: 'dup' };
      }
    }

    if (newName !== name) {
      next.name = newName;
      /* 题目归属跟着改名 */
      const qs = this.getQuestions();
      let qChanged = false;
      qs.forEach(q => {
        if (q.point === name) { q.point = newName; qChanged = true; }
      });
      if (qChanged) this.saveQuestions(qs);

      /* 完成标记迁移到新名 */
      const completed = this.getCompleted();
      if (completed[name] !== undefined) {
        if (completed[newName] === undefined) completed[newName] = completed[name];
        delete completed[name];
        this._write(this.KEYS.completed, completed);
      }
      /* 练习统计迁移到新名 */
      const meta = this.getPointMeta();
      if (meta[name] !== undefined) {
        if (!meta[newName]) meta[newName] = meta[name];
        delete meta[name];
        this._write(this.KEYS.pointMeta, meta);
      }
      /* Boss 战绩迁移到新名 */
      const boss = this.getBossProgress();
      if (boss[name] !== undefined) {
        if (!boss[newName]) boss[newName] = boss[name];
        delete boss[name];
        this.saveBossProgress(boss);
      }
    }

    cards[i] = next;
    this.saveCards(cards);
    return next;
  },

  /**
   * 删除卡片。deleteQuestions 为 true 时同时删除该考点下全部题目，
   * 联动清理错题/疑难；最后统一清理彻底消失考点的完成标记与练习统计。
   * @returns {{card:number, questions:number}}
   */
  deleteCard(name, opts) {
    const cards = this.getCards();
    const i = cards.findIndex(c => c.name === name);
    if (i === -1) return { card: 0, questions: 0 };
    cards.splice(i, 1);
    this.saveCards(cards);

    let removed = 0;
    if (opts && opts.deleteQuestions) {
      const ids = new Set();
      const remain = [];
      this.getQuestions().forEach(q => {
        if (q.point === name) ids.add(q.id);
        else remain.push(q);
      });
      removed = ids.size;
      if (removed) {
        this.saveQuestions(remain);
        this._write(this.KEYS.wrong, this.getWrongIds().filter(id => !ids.has(id)));
        this._write(this.KEYS.marked, this.getMarkedIds().filter(id => !ids.has(id)));
      }
    }
    /* 卡片没了；若题目也没了（或本来就没有题），完成标记/统计随之清理 */
    this._cleanOrphanPointMeta(this.getQuestions(), cards);
    return { card: 1, questions: removed };
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

  /* ---------------- 阅读理解（独立书架：书籍 → 单元 → 文章） ----------------
   * jp_reading_v1:
   * [{ id, name, createdAt, lastStudyAt,
   *    units: [{ id, name, createdAt,
   *      articles: [{ id, title, text(挖空为（1）（2）…), createdAt, favorite,
   *        blanks: [{ no, options:{A,B,C,D}, answer, explanation, points:[],
   *                   qid(答错时同步进题库的题id), lastWrong }],
   *        precisionId(已导入精读的 articleId),
   *        state: { chosen:{no:letter}, submitted, correct, total,
   *                 updatedAt, history:[{ts,correct,total}] } }] }] }] */
  getReadingBooks() {
    return this._read(this.KEYS.reading, []);
  },

  saveReadingBooks(list) {
    this._write(this.KEYS.reading, Array.isArray(list) ? list : []);
  },

  getReadingBookById(id) {
    return this.getReadingBooks().find(b => b.id === id) || null;
  },

  /** 新建阅读理解书籍（同名忽略大小写/空白判重），重名或空名返回 null */
  addReadingBook(name) {
    name = String(name || '').trim();
    if (!name) return null;
    const books = this.getReadingBooks();
    if (books.some(b => b.name.trim().toLowerCase() === name.toLowerCase())) return null;
    const book = { id: this.uid('rb'), name, createdAt: Date.now(), lastStudyAt: 0, units: [] };
    books.push(book);
    this.saveReadingBooks(books);
    return book;
  },

  /** 按名取书，不存在则新建（导入用） */
  ensureReadingBook(name) {
    name = String(name || '').trim();
    if (!name) return null;
    const hit = this.getReadingBooks().find(
      b => b.name.trim().toLowerCase() === name.toLowerCase());
    return hit || this.addReadingBook(name);
  },

  renameReadingBook(id, name) {
    name = String(name || '').trim();
    if (!name) return false;
    const books = this.getReadingBooks();
    const b = books.find(x => x.id === id);
    if (!b) return false;
    if (books.some(x => x.id !== id &&
      x.name.trim().toLowerCase() === name.toLowerCase())) return false;
    b.name = name;
    this.saveReadingBooks(books);
    return true;
  },

  /** 收集文章已同步进题库的题 id（级联删除用） */
  _readingQids(articles) {
    const ids = [];
    (articles || []).forEach(a => (a.blanks || []).forEach(b => {
      if (b.qid) ids.push(b.qid);
    }));
    return ids;
  },

  deleteReadingBook(id) {
    const books = this.getReadingBooks();
    const b = books.find(x => x.id === id);
    if (!b) return false;
    const qids = [];
    (b.units || []).forEach(u => qids.push(...this._readingQids(u.articles)));
    this.saveReadingBooks(books.filter(x => x.id !== id));
    if (qids.length) this.deleteQuestionsByIds(qids);
    return true;
  },

  addReadingUnit(bookId, name) {
    name = String(name || '').trim();
    if (!name) return null;
    const books = this.getReadingBooks();
    const b = books.find(x => x.id === bookId);
    if (!b) return null;
    if (!Array.isArray(b.units)) b.units = [];
    if (b.units.some(u => u.name.trim().toLowerCase() === name.toLowerCase())) return null;
    const unit = { id: this.uid('ru'), name, createdAt: Date.now(), articles: [] };
    b.units.push(unit);
    this.saveReadingBooks(books);
    return unit;
  },

  /** 按名取单元，不存在则新建（导入用） */
  ensureReadingUnit(bookId, name) {
    name = String(name || '').trim();
    if (!name) return null;
    const b = this.getReadingBookById(bookId);
    if (!b) return null;
    const hit = (b.units || []).find(
      u => u.name.trim().toLowerCase() === name.toLowerCase());
    return hit || this.addReadingUnit(bookId, name);
  },

  renameReadingUnit(bookId, unitId, name) {
    name = String(name || '').trim();
    if (!name) return false;
    const books = this.getReadingBooks();
    const b = books.find(x => x.id === bookId);
    if (!b || !Array.isArray(b.units)) return false;
    const u = b.units.find(x => x.id === unitId);
    if (!u) return false;
    if (b.units.some(x => x.id !== unitId &&
      x.name.trim().toLowerCase() === name.toLowerCase())) return false;
    u.name = name;
    this.saveReadingBooks(books);
    return true;
  },

  deleteReadingUnit(bookId, unitId) {
    const books = this.getReadingBooks();
    const b = books.find(x => x.id === bookId);
    if (!b || !Array.isArray(b.units)) return false;
    const u = b.units.find(x => x.id === unitId);
    if (!u) return false;
    const qids = this._readingQids(u.articles);
    b.units = b.units.filter(x => x.id !== unitId);
    this.saveReadingBooks(books);
    if (qids.length) this.deleteQuestionsByIds(qids);
    return true;
  },

  /** 跨书定位文章，返回 {book, unit, article} 或 null */
  findReadingArticle(articleId) {
    const books = this.getReadingBooks();
    for (const b of books) {
      for (const u of (b.units || [])) {
        const a = (u.articles || []).find(x => x.id === articleId);
        if (a) return { book: b, unit: u, article: a };
      }
    }
    return null;
  },

  addReadingArticle(bookId, unitId, article) {
    const books = this.getReadingBooks();
    const b = books.find(x => x.id === bookId);
    if (!b) return null;
    const u = (b.units || []).find(x => x.id === unitId);
    if (!u) return null;
    if (!Array.isArray(u.articles)) u.articles = [];
    u.articles.push(article);
    this.saveReadingBooks(books);
    return article;
  },

  /** 按 id 覆盖更新文章（state/favorite/blanks.qid 等随对象整体替换） */
  updateReadingArticle(article) {
    if (!article || !article.id) return false;
    const books = this.getReadingBooks();
    for (const b of books) {
      for (const u of (b.units || [])) {
        const i = (u.articles || []).findIndex(x => x.id === article.id);
        if (i > -1) {
          u.articles[i] = article;
          this.saveReadingBooks(books);
          return true;
        }
      }
    }
    return false;
  },

  deleteReadingArticle(articleId) {
    const books = this.getReadingBooks();
    for (const b of books) {
      for (const u of (b.units || [])) {
        const i = (u.articles || []).findIndex(x => x.id === articleId);
        if (i > -1) {
          const qids = this._readingQids([u.articles[i]]);
          u.articles.splice(i, 1);
          this.saveReadingBooks(books);
          if (qids.length) this.deleteQuestionsByIds(qids);
          return true;
        }
      }
    }
    return false;
  },

  /** 记录书的最近学习时间（书架排序用） */
  touchReadingBook(bookId) {
    const books = this.getReadingBooks();
    const b = books.find(x => x.id === bookId);
    if (!b) return;
    b.lastStudyAt = Date.now();
    this.saveReadingBooks(books);
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

  /**
   * 从卡片上摘除命中的来源（不删主考点卡片）。
   * 一张卡的来源被摘光时，保留其主内容并补一条未分类来源。
   * @param {Function} matchScope (bookId, chapterId) => boolean
   * @returns {number} 受影响的卡片数
   */
  _detachCardSources(matchScope) {
    const cards = this.getCards();
    let n = 0;
    cards.forEach(c => {
      if (!Array.isArray(c.sources) || !c.sources.length) return;
      const before = c.sources.length;
      c.sources = c.sources.filter(s =>
        !matchScope(s.bookId || '', s.chapterId || ''));
      if (c.sources.length !== before) {
        n++;
        if (!c.sources.length) {
          c.sources = [this._makeSource({
            bookId: '',
            chapterId: '',
            summary: c.summary || '',
            lecture: c.lecture || '',
            emphasis: c.emphasis || '',
            examples: Array.isArray(c.examples) ? c.examples : []
          })];
        }
      }
    });
    if (n) this.saveCards(cards);
    return n;
  },

  /**
   * 删除整本书：其下题目照删（联动错题/疑难）；卡片不删，
   * 只摘除来自本书的来源（主考点可能还挂在别的书上）。
   * @returns {{questions:number, cards:number}} cards 为被摘来源的卡片数
   */
  deleteBook(id) {
    const beforeQ = this.getQuestions();
    const removedIds = new Set();
    const qs = [];
    beforeQ.forEach(q => {
      if (q.bookId === id) removedIds.add(q.id);
      else qs.push(q);
    });
    if (removedIds.size) {
      this.saveQuestions(qs);
      this._write(this.KEYS.wrong, this.getWrongIds().filter(x => !removedIds.has(x)));
      this._write(this.KEYS.marked, this.getMarkedIds().filter(x => !removedIds.has(x)));
    }
    const cardsAffected = this._detachCardSources(b => b === id);
    this.saveBooks(this.getBooks().filter(b => b.id !== id));
    this._cleanOrphanPointMeta(this.getQuestions(), this.getCards());
    return { questions: removedIds.size, cards: cardsAffected };
  },

  /**
   * 删除某书下的单个章节：题目照删；卡片只摘除该章来源，随后移除章节记录。
   */
  deleteChapter(bookId, chapterId) {
    const beforeQ = this.getQuestions();
    const removedIds = new Set();
    const qs = [];
    beforeQ.forEach(q => {
      if (q.bookId === bookId && q.chapterId === chapterId) removedIds.add(q.id);
      else qs.push(q);
    });
    if (removedIds.size) {
      this.saveQuestions(qs);
      this._write(this.KEYS.wrong, this.getWrongIds().filter(x => !removedIds.has(x)));
      this._write(this.KEYS.marked, this.getMarkedIds().filter(x => !removedIds.has(x)));
    }
    const cardsAffected = this._detachCardSources(
      (b, ch) => b === bookId && ch === chapterId);
    const books = this.getBooks();
    const b = books.find(x => x.id === bookId);
    if (b && Array.isArray(b.chapters)) {
      b.chapters = b.chapters.filter(c => c.id !== chapterId);
      this.saveBooks(books);
    }
    this._cleanOrphanPointMeta(this.getQuestions(), this.getCards());
    return { questions: removedIds.size, cards: cardsAffected };
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

    /* 卡片：先修各来源（含 sources[0]），再修顶层；
       saveCards 归一化会按修好的 sources[0] 重新镜像顶层字段 */
    const cs = this.getCards();
    let cChanged = false;
    cs.forEach(c => {
      if (Array.isArray(c.sources)) {
        c.sources.forEach(s => { if (fix(s)) cChanged = true; });
      }
      if (fix(c)) cChanged = true;
    });
    if (cChanged) this.saveCards(cs);
  },

  /* ---------------- JSON 导出 / 导入 ---------------- */

  /** 导出全部数据为可迁移对象 */
  exportBundle() {
    return {
      app: 'jp-grammar-quiz',
      version: 2,
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
    const result = {
      questions: 0, questionsDup: 0,
      cardsAdded: 0, cardsAppended: 0, cardsUpdated: 0,
      replaced: false
    };

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
      /* 旧版备份：卡片补 sources、题目补 bookId/chapterId，再修悬空归属 */
      this.migrateSources();
      this.reconcileScopes();
      result.questions = bundle.questions.length;
      result.replaced = true;
      return result;
    }

    /* 合并：题目先按 id 去重，再按「主考点 + 来源书章 + 题干」去重。
       不同来源（两本书各自收录）的同考点同题干题视为两道，分别保留；
       同一来源内重复导入才跳过。 */
    const qs = this.getQuestions();
    const haveIds = new Set(qs.map(q => q.id));
    const qkey = q => this.questionDedupKey(q.point, q.stem, q.bookId, q.chapterId);
    const haveKeys = new Set(qs.map(qkey));
    const incoming = [];
    bundle.questions.forEach(q => {
      if (!q || !q.id || haveIds.has(q.id)) return;
      if (q.stem && haveKeys.has(qkey(q))) { result.questionsDup++; return; }
      qs.push(q);
      incoming.push(q);
      haveIds.add(q.id);
      if (q.stem) haveKeys.add(qkey(q));
      result.questions++;
    });
    this.saveQuestions(qs);
    /* 合并进来的题目若带书章归属，自动给对应卡片补来源（卡缺失不自动建） */
    if (incoming.length) {
      const es = this.ensureCardSourcesForQuestions(incoming);
      result.cardSourcesAttached = es.attached;
    }

    if (isArr(bundle.cards) && bundle.cards.length) {
      /* 多来源语义：同名卡不覆盖，按书+章更新或追加来源 */
      const r = this.importCards(bundle.cards);
      result.cardsAdded = r.added;
      result.cardsAppended = r.appended;
      result.cardsUpdated = r.updated;
    }
    /* 卡片到达后，按库中已有题目的书章归属反向补挂缺失来源（题先卡后场景） */
    const esAll = this.ensureCardSourcesForQuestions(this.getQuestions());
    result.cardSourcesAttached = (result.cardSourcesAttached || 0) + esAll.attached;

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
    /* 旧备份题目补归属、卡片补 sources，然后统一修悬空归属 */
    this.migrateSources();
    this.reconcileScopes();
    return result;
  },

  /** 生成唯一ID */
  uid(prefix) {
    return prefix + '_' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7);
  }
};
