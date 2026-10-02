/* =====================================================================
 * parser.js —— 批量导入文本解析
 *
 * 规则：
 *  - 每道题 / 每张卡片为一个块，块之间用空行分隔
 *  - 每行一个字段：【字段名】字段值
 *  - 同一字段出现多次时收集为数组（考点卡片的多条【例句】由此支持）
 *
 * 返回结构：
 *   parseQuestionsText / parseCardsText
 *   -> [{ index, valid, errors: [], data: {...} }]
 * =================================================================== */

const Parser = {

  /* ---------- 基础工具 ---------- */

  splitBlocks(text) {
    return String(text || '')
      .replace(/^﻿/, '')
      .split(/\r?\n[ \t]*\r?\n/)
      .map(b => b.trim())
      .filter(Boolean);
  },

  /** 把一个块解析成 { 字段名: 值 }，重复字段变数组 */
  parseFields(block) {
    const map = {};
    block.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*【([^】]+)】\s*(.*)$/);
      if (!m) return;
      const key = m[1].trim();
      const val = m[2].trim();
      if (map[key] === undefined) {
        map[key] = val;
      } else if (Array.isArray(map[key])) {
        map[key].push(val);
      } else {
        map[key] = [map[key], val];
      }
    });
    return map;
  },

  /** 按别名字段取第一个出现的值（标量） */
  pick(map, aliases) {
    for (const a of aliases) {
      if (map[a] !== undefined) {
        return Array.isArray(map[a]) ? map[a][0] : map[a];
      }
    }
    return '';
  },

  /** 取数组值（用于例句） */
  pickList(map, aliases) {
    for (const a of aliases) {
      if (map[a] !== undefined) {
        return Array.isArray(map[a]) ? map[a] : [map[a]];
      }
    }
    return [];
  },

  normAnswer(v) {
    if (!v) return '';
    const fullwidth = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D' };
    v = String(v).trim();
    v = fullwidth[v] || v;
    const ch = v.charAt(0).toUpperCase();
    return 'ABCD'.includes(ch) ? ch : '';
  },

  normDifficulty(v) {
    const table = {
      '1': '易', '易': '易', '容易': '易',
      '2': '中', '中': '中', '普通': '中',
      '3': '难', '难': '难', '難': '难'
    };
    return table[String(v || '').trim()] || '中';
  },

  /** 例句行：日文与中文用 / ｜ | ／ 分隔，无分隔符则整句当日文 */
  splitExample(line) {
    const m = String(line).split(/\s*[\/｜|／]\s*/);
    if (m.length >= 2) {
      return { jp: m[0].trim(), cn: m.slice(1).join('/').trim() };
    }
    return { jp: String(line).trim(), cn: '' };
  },

  /* ---------- 题目解析 ---------- */

  parseQuestionsText(text) {
    return this.splitBlocks(text).map((block, i) => {
      const f = this.parseFields(block);
      const errors = [];

      const category = this.pick(f, ['门类', '分类']);
      const point = this.pick(f, ['考点名称', '考点', '知识点']);
      const type = this.pick(f, ['题型', '类型']) || '单选题';
      const stem = this.pick(f, ['题干', '题目']);
      /* 归属字段：由「复制格式模板」按用户选中的书章自动带上，导入时自动归位 */
      const book = this.pick(f, ['书籍', '书名']);
      const chapter = this.pick(f, ['章节', '单元']);
      const optA = this.pick(f, ['选项A', 'A']);
      const optB = this.pick(f, ['选项B', 'B']);
      const optC = this.pick(f, ['选项C', 'C']);
      const optD = this.pick(f, ['选项D', 'D']);
      /* 选项→语法卡片名（可选，导入时定死；不填则导入时按选项文本宽松匹配一次） */
      const cardA = this.pick(f, ['选项A卡片', 'A卡片', '选项A对应卡片']);
      const cardB = this.pick(f, ['选项B卡片', 'B卡片', '选项B对应卡片']);
      const cardC = this.pick(f, ['选项C卡片', 'C卡片', '选项C对应卡片']);
      const cardD = this.pick(f, ['选项D卡片', 'D卡片', '选项D对应卡片']);
      const answer = this.normAnswer(this.pick(f, ['答案', '正解']));
      const explanation = this.pick(f, ['解析', '详解', '解释']) || '';
      const difficulty = this.normDifficulty(this.pick(f, ['难度']));

      if (!category) errors.push('缺少【门类】');
      if (!point) errors.push('缺少【考点名称】');
      if (!stem) errors.push('缺少【题干】');
      if (!optA || !optB || !optC || !optD) errors.push('缺少完整的【选项A-D】');
      if (!answer) errors.push('【答案】缺失或不是 A-D');

      return {
        index: i + 1,
        valid: errors.length === 0,
        errors,
        data: {
          category, point, type, stem,
          book, chapter,
          options: { A: optA, B: optB, C: optC, D: optD },
          optionCards: { A: cardA, B: cardB, C: cardC, D: cardD },
          answer, explanation, difficulty
        }
      };
    });
  },

  /* ---------- 考点卡片解析 ----------
   * 支持「子考点」结构：一张卡片 = 总纲（摘要/讲解/例句）+ 多个子考点用法。
   * 卡片以【考点名称】为界（不再依赖空行分块）；【子考点】开启一个用法块，
   * 其后的【讲解】【例句】属于该用法，内嵌题目写法：
   *   【题目】题干
   *   【选项A】…【选项B】…【选项C】…【选项D】…
   *   【答案】B   【解析】…（可选）【难度】中（可选）
   * 每个【题目】开启一道新题，自动归入当前子考点。
   * 旧格式（无子考点）完全兼容。
   */

  parseCardsText(text) {
    const lines = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    const cards = [];
    let cur = null, sub = null, curQ = null;

    const newQuestion = () => ({
      stem: '', type: '单选题', difficulty: '中',
      options: { A: '', B: '', C: '', D: '' },
      optionCards: { A: '', B: '', C: '', D: '' },
      answer: '', explanation: '', subPoint: ''
    });
    const bucket = () => sub || cur;

    lines.forEach(raw => {
      const m = raw.match(/^\s*【([^】]+)】\s*(.*)$/);
      if (!m) return;
      const key = m[1].trim();
      const val = m[2].trim();

      /* 新卡片：刷新当前上下文 */
      if (key === '考点名称' || key === '考点' || key === '知识点') {
        cur = {
          name: val, category: '', summary: '', lecture: '', emphasis: '',
          examples: [], subPoints: [], questions: []
        };
        cards.push(cur);
        sub = null; curQ = null;
        return;
      }
      if (!cur) return;

      /* 子考点块切换 */
      if (key === '子考点' || key === '用法' || key === '子用法') {
        sub = { title: val, lecture: '', emphasis: '', examples: [], questions: [] };
        cur.subPoints.push(sub);
        curQ = null;
        return;
      }

      /* 内嵌题目字段 */
      if (key === '题目' || key === '题干') {
        curQ = newQuestion();
        curQ.stem = val;
        curQ.subPoint = sub ? sub.title : '';
        bucket().questions.push(curQ);
        return;
      }
      if (curQ) {
        const optKey = { '选项A': 'A', 'A': 'A', '选项B': 'B', 'B': 'B',
          '选项C': 'C', 'C': 'C', '选项D': 'D', 'D': 'D' }[key];
        if (optKey) { curQ.options[optKey] = val; return; }
        const ocKey = { '选项A卡片': 'A', 'A卡片': 'A', '选项A对应卡片': 'A',
          '选项B卡片': 'B', 'B卡片': 'B', '选项B对应卡片': 'B',
          '选项C卡片': 'C', 'C卡片': 'C', '选项C对应卡片': 'C',
          '选项D卡片': 'D', 'D卡片': 'D', '选项D对应卡片': 'D' }[key];
        if (ocKey) { curQ.optionCards[ocKey] = val; return; }
        if (key === '答案' || key === '正解') { curQ.answer = this.normAnswer(val); return; }
        if (key === '解析' || key === '解释' || key === '详解') { curQ.explanation = val; return; }
        if (key === '难度') { curQ.difficulty = this.normDifficulty(val); return; }
        if (key === '题型' || key === '类型') { curQ.type = val || '单选题'; return; }
      }

      /* 卡片 / 子考点内容字段 */
      const b = bucket();
      if (key === '门类' || key === '分类') { cur.category = val; return; }
      if (key === '摘要' || key === '简介') { cur.summary = val; return; }
      if (key === '讲解' || key === '说明') { b.lecture = val; return; }
      if (key === '侧重点' || key === '重点' || key === '注意') { b.emphasis = val; return; }
      if (key === '例句' || key === '例子') {
        const ex = this.splitExample(val);
        if (ex.jp) b.examples.push(ex);
        return;
      }
    });

    /* 逐卡校验与规范化 */
    return cards.map((c, i) => {
      const errors = [];
      if (!c.name) errors.push('缺少【考点名称】');
      const finalCategory = c.category || '自定义语法';
      const finalSummary = c.summary || (c.lecture ? c.lecture.slice(0, 40) : '');

      const checkQ = (q, label) => {
        if (!q.stem) errors.push(label + '题目缺少【题干】');
        if (!q.options.A || !q.options.B || !q.options.C || !q.options.D)
          errors.push(label + '题目缺少完整的【选项A-D】');
        if (!q.answer) errors.push(label + '题目【答案】缺失或不是 A-D');
      };
      c.questions.forEach(q => checkQ(q, '总纲'));
      c.subPoints.forEach(sp => {
        if (!sp.title) errors.push('存在缺少标题的【子考点】');
        sp.questions.forEach(q => checkQ(q, '子考点「' + (sp.title || '?') + '」'));
      });

      return {
        index: i + 1,
        valid: errors.length === 0,
        errors,
        data: {
          name: c.name, category: finalCategory, summary: finalSummary,
          lecture: c.lecture, emphasis: c.emphasis, examples: c.examples,
          subPoints: c.subPoints.map(sp => ({
            title: sp.title, lecture: sp.lecture,
            emphasis: sp.emphasis, examples: sp.examples,
            questions: sp.questions.length   // 仅预览用：该用法下内嵌题数
          })),
          questions: c.questions.concat(
            ...c.subPoints.map(sp => sp.questions)
          )
        }
      };
    });
  },

  /* ---------- 阅读理解文章解析 ----------
   * 格式（【书名】【单元】可选，写在任意位置，对其后的文章生效）：
   *   【书名】N2 读解特训
   *   【单元】第一单元
   *
   *   【标题】心の問題との向き合い
   *   【正文】
   *   自分は心の問題とは無縁（1）と高を括っている人もいるでしょう。
   *   （正文可多行、可含空行；挖空写作（1）（2）…，连续空括号（　）按顺序自动编号）
   *   【题1选项A】…
   *   【题1选项B】…
   *   【题1选项C】…
   *   【题1选项D】…
   *   【题1答案】B
   *   【题1解析】…（可选）
   *   【题1知识点】～ばかり・～ほど（可选）
   *
   * 题目分两类：
   *   - 挖空题：正文中存在同号（n）标记，挂到正文里；
   *   - 附加题（独立题）：正文中没有对应挖空（语法辨析、读音、阅读选择等），
   *     显示在正文下方；可用【题N题干】写明独立题的题干（可选）。
   * 整篇只要有任意一类完整题目即算有效文章；正文没有挖空也不报错。
   *
   * 返回 [{ index, valid, errors, data:{book, unit, title, text, blanks, extras} }]
   * blanks / extras: [{ no, stem, options:{A,B,C,D}, answer, explanation, points:[] }]
   */
  parseReadingText(text) {
    const lines = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    const FW2HW = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D' };
    const articles = [];
    let curBook = '', curUnit = '', cur = null, inBody = false;

    const flush = () => {
      if (cur) { articles.push(cur); cur = null; }
      inBody = false;
    };

    lines.forEach(raw => {
      const line = raw;
      const head = line.match(/^\s*【([^】]+)】\s*(.*)$/);
      const key = head ? head[1].trim() : '';
      const val = head ? head[2].trim() : '';

      if (head && key === '书名') { curBook = val; inBody = false; return; }
      if (head && key === '单元') { curUnit = val; inBody = false; return; }
      if (head && (key === '标题' || key === '题目')) {
        flush();
        cur = { title: val, book: curBook, unit: curUnit, body: null, fields: {} };
        return;
      }
      if (!cur) return;               // 文章外的杂行忽略
      if (head && (key === '正文' || key === '文章')) {
        inBody = true;
        cur.body = cur.body || [];
        if (val) cur.body.push(val);
        return;
      }
      const qf = head && key.match(/^题?(\d{1,2})\s*(选项([ABCDＡＢＣＤ])|答案|解析|知识点|题干)$/);
      if (qf) {
        inBody = false;
        const no = Number(qf[1]);
        const f = cur.fields[no] = cur.fields[no] || { options: {} };
        if (qf[3]) f.options[FW2HW[qf[3]] || qf[3]] = val;
        else if (qf[2] === '答案') f.answer = val;
        else if (qf[2] === '解析') f.explanation = val;
        else if (qf[2] === '题干') f.stem = val;
        else f.points = val;
        return;
      }
      if (head) { inBody = false; return; }   // 文章内未知字段，跳过
      if (inBody && cur.body) cur.body.push(line);
    });
    flush();

    /* 逐篇校验并规范化挖空编号 */
    return articles.map((a, i) => {
      const errors = [];
      let text = (a.body || []).join('\n').replace(/^\s+|\s+$/g, '');
      if (!a.title) errors.push('缺少【标题】内容');
      if (!text) errors.push('缺少【正文】');

      /* 已显式编号的挖空：统一改写成全角（n） */
      const used = new Set();
      text = text.replace(/[（(]\s*(\d{1,2})\s*[）)]/g,
        (m, n) => { used.add(Number(n)); return '（' + Number(n) + '）'; });
      /* 连续空括号（　）/（ ）/() 按出现顺序补号 */
      let next = 1;
      text = text.replace(/（[ 　]*）|\([ 　]*\)/g, () => {
        while (used.has(next)) next++;
        used.add(next);
        return '（' + next + '）';
      });

      const buildQ = (no, f, label) => {
        const o = f.options || {};
        if (!o.A || !o.B || !o.C || !o.D) {
          errors.push(label + '缺少完整的【题' + no + '选项A-D】');
        }
        const answer = this.normAnswer(f.answer);
        if (!answer) errors.push(label + '【题' + no + '答案】缺失或不是 A-D');
        return {
          no,
          stem: f.stem || '',
          options: { A: o.A || '', B: o.B || '', C: o.C || '', D: o.D || '' },
          answer,
          explanation: f.explanation || '',
          points: String(f.points || '').split(/[・、,，／\/]/).map(s => s.trim()).filter(Boolean)
        };
      };

      /* 挖空题：正文里有（n）标记的，挂到正文 */
      const blanks = [];
      const nos = Array.from(used).sort((x, y) => x - y);
      nos.forEach(no => {
        const f = a.fields[no];
        if (!f) { errors.push('挖空（' + no + '）缺少对应的【题' + no + '…】字段'); return; }
        blanks.push(buildQ(no, f, '第 ' + no + ' 空'));
      });

      /* 附加题（独立题）：有【题N…】字段但正文里没有对应挖空，显示在正文下方 */
      const extras = [];
      Object.keys(a.fields).sort((x, y) => Number(x) - Number(y)).forEach(k => {
        const no = Number(k);
        if (used.has(no)) return;
        extras.push(buildQ(no, a.fields[no], '第 ' + no + ' 题（附加题）'));
      });

      /* 两类题都没有才算无效；正文无挖空不再报错 */
      if (text && !blanks.length && !extras.length) {
        errors.push('没有任何题目：既无挖空题（1），也无正文外的附加题');
      }

      return {
        index: i + 1,
        valid: errors.length === 0,
        errors,
        data: { book: a.book, unit: a.unit, title: a.title, text, blanks, extras }
      };
    });
  }
};
