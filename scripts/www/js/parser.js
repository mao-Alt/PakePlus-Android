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

  /* ---------- 考点卡片解析 ---------- */

  parseCardsText(text) {
    return this.splitBlocks(text).map((block, i) => {
      const f = this.parseFields(block);
      const errors = [];

      const name = this.pick(f, ['考点名称', '考点', '知识点']);
      const category = this.pick(f, ['门类', '分类']);
      const summary = this.pick(f, ['摘要', '简介']) || '';
      const lecture = this.pick(f, ['讲解', '详解', '说明']) || '';
      const emphasis = this.pick(f, ['侧重点', '重点', '注意']) || '';
      const examples = this.pickList(f, ['例句', '例子'])
        .map(s => this.splitExample(s))
        .filter(ex => ex.jp);

      if (!name) errors.push('缺少【考点名称】');
      /* 门类可选：未填写时默认归入「自定义语法」，方便快速录入扩充识别库 */
      const finalCategory = category || '自定义语法';
      /* 摘要缺省时用讲解首句兜底，仍无则留空字符串 */
      const finalSummary = summary || (lecture ? lecture.slice(0, 40) : '');

      return {
        index: i + 1,
        valid: errors.length === 0,
        errors,
        data: {
          name, category: finalCategory, summary: finalSummary,
          lecture, emphasis, examples
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
   * 返回 [{ index, valid, errors, data:{book, unit, title, text, blanks} }]
   * blanks: [{ no, options:{A,B,C,D}, answer, explanation, points:[] }]
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
      const qf = head && key.match(/^题?(\d{1,2})\s*(选项([ABCDＡＢＣＤ])|答案|解析|知识点)$/);
      if (qf) {
        inBody = false;
        const no = Number(qf[1]);
        const f = cur.fields[no] = cur.fields[no] || { options: {} };
        if (qf[3]) f.options[FW2HW[qf[3]] || qf[3]] = val;
        else if (qf[2] === '答案') f.answer = val;
        else if (qf[2] === '解析') f.explanation = val;
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

      const blanks = [];
      const nos = Array.from(used).sort((x, y) => x - y);
      if (!nos.length && text) errors.push('正文中没有挖空标记（1）或（　）');
      nos.forEach(no => {
        const f = a.fields[no];
        if (!f) { errors.push('挖空（' + no + '）缺少对应的【题' + no + '…】字段'); return; }
        const o = f.options || {};
        if (!o.A || !o.B || !o.C || !o.D) errors.push('第 ' + no + ' 题缺少完整的【题' + no + '选项A-D】');
        const answer = this.normAnswer(f.answer);
        if (!answer) errors.push('第 ' + no + ' 题【题' + no + '答案】缺失或不是 A-D');
        blanks.push({
          no,
          options: { A: o.A || '', B: o.B || '', C: o.C || '', D: o.D || '' },
          answer,
          explanation: f.explanation || '',
          points: String(f.points || '').split(/[・、,，／\/]/).map(s => s.trim()).filter(Boolean)
        });
      });
      Object.keys(a.fields).forEach(k => {
        if (!used.has(Number(k))) errors.push('【题' + k + '…】在正文中没有对应挖空（' + k + '）');
      });

      return {
        index: i + 1,
        valid: errors.length === 0,
        errors,
        data: { book: a.book, unit: a.unit, title: a.title, text, blanks }
      };
    });
  }
};
