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
      const optA = this.pick(f, ['选项A', 'A']);
      const optB = this.pick(f, ['选项B', 'B']);
      const optC = this.pick(f, ['选项C', 'C']);
      const optD = this.pick(f, ['选项D', 'D']);
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
          options: { A: optA, B: optB, C: optC, D: optD },
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
        data: { name, category: finalCategory, summary: finalSummary, lecture, examples }
      };
    });
  }
};
