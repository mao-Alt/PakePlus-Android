/* =====================================================================
 * article.js —— 文章精读：日语文章导入、语法高亮、自动出题
 *
 * 路由：
 *   #/articles        文章列表（标题 / 时间 / 语法点数）
 *   #/article/new     粘贴导入 + 分析
 *   #/article/<id>    精读页（高亮原文 + 语法点清单 + 本文练习）
 *
 * 数据：localStorage key jp_articles_v1
 *   { id, text, title, createdAt, pointCount, newCount, difficulty, questionIds }
 *
 * 语法识别：把题库中每张卡片的名称转成正则（～→通配、（）→可选、・／→变体），
 * 在文章中匹配定位；题库没有的常见语法走 EXTRA_GRAMMAR 探测表，标记为"新语法点"。
 *
 * 误判防护（纯本地规则 + 分词器，不调用 AI）：
 *   ① 短核心词边界——きる/なり 等两假名核心右侧再贴平假名即视为词的一部分；
 *   ② 单汉字防护——際/上 这类单汉字核心两侧贴汉字时判为汉语词（国際・売上）；
 *   ③ LEXICAL_BLOCK 常见词排除表——できる(含きる)、かなり(含なり) 等整体排除；
 *   ④ 词性过滤（kuromoji）——命中区间戳进 名詞/動詞-自立/形容詞/副詞 内部即拒绝，
 *      如 手紙の「て」、増す→ます；词典未加载时自动回退到 ①-③ 规则引擎。
 *   命中区间再按「长者优先 + 优先级」消重叠，避免把一个词拆成两个语法点。
 * =================================================================== */

(function () {
  'use strict';

  /* ---------- 题库外常见语法探测表（命中即"新语法点"） ---------- */
  const EXTRA_GRAMMAR = [
    { name: '～にほかならない', re: 'にほかなら(?:ない|ぬ|なりません)', summary: '强调"正是……、无非是……"，书面语。' },
    { name: '～とは限らない', re: 'とは限(?:らない|りません)', summary: '未必……、不一定……。' },
    { name: '～ばかりか', re: 'ばかりか', summary: '不仅……而且……。' },
    { name: '～わけがない', re: 'わけが(?:ない|ありません)', summary: '不可能……、绝不会……。' },
    { name: '～てばかりいる', re: 'てばかり(?:いる|いた)', summary: '净……、老是……（含不满语气）。' },
    { name: '～かのようだ', re: 'かのよう(?:だ|な|に)', summary: '好像……一样（实际并非如此）。' },
    { name: '～どころか', re: 'どころか', summary: '别说……反而……、岂止……。' },
    { name: '～に関して', re: 'に関(?:して|する)', summary: '关于……、有关……。' },
    { name: '～にわたって', re: 'にわた(?:って|る|り)', summary: '跨越……、历时……（范围/时间）。' },
    { name: '～をめぐって', re: 'をめぐ(?:って|る|り)', summary: '围绕……、就……（争议/问题）。' },
    { name: '～ないまでも', re: 'ないまでも', summary: '即使不……也……、至少……。' },
    { name: '～と相まって', re: 'と相まって', summary: '与……相结合、加上……。' }
  ];

  /* ---------- 模块状态 ---------- */
  let current = null;        // { article, analysis }
  let detailTab = 'points';  // points | exercise
  let aiText = '';           // AI 出题粘贴文本
  let aiPreview = null;      // AI 题目解析预览
  let popEl = null;

  const LV = { '易': 1, '中': 2, '难': 3 };
  const DIFF_TO_Q = { '基础': '易', '进阶': '中', '高频': '难' };
  const DIFF_BADGE = { '基础': 'diff-易', '进阶': 'diff-中', '高频': 'diff-难' };

  /* ================= 语法匹配引擎 ================= */

  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* 假名 / 日文词字符类（词边界判定用，含半角假名） */
  const KANA_CHAR = /[ぁ-んァ-ヶｦ-ﾟ]/;
  const HIRA_CHAR = /[ぁ-ん]/;
  const KANJI_CHAR = /[一-龯㐀-䶿々〆〤]/;
  const JP_WORD_CHAR = /[ぁ-んァ-ヶｦ-ﾟ一-龯㐀-䶿々〆〤ーｰ]/;
  /* 短语法命中后，允许紧跟的助词 / 接续成分（其余平假名一律视为仍在词内）
     こ＝こと・こそ、そ＝そうだ、ん＝んだ、て＝ても、だ＝判断助动词、
     わ＝わけだ、す＝たりする 等紧跟的轻动词 する */
  const PARTICLE_AFTER = /^[かがさたなはまやらわとでにのをもねよぜぞばぱこそんてだわす]$/;
  /* 两假名核心但右侧需要直接接动词的（さえあれば），不做右侧词边界约束 */
  const RIGHT_ATTACH = { 'さえ': 1 };

  /*
   * 常见词误判排除表：词内恰好包含某语法核心，命中区间落在这些词上时直接丢弃。
   *   できる→きる、かなり→なり、はっきり/すっきり/まるきり→きり、
   *   いたる/あたる/ほたる→たる、うつつ→つつ、ふたり/まったり→たり、
   *   みたい/もったいない/たいする→たい、ありがたい→がたい、
   *   もてる→てる、とくに→とく、なりすます→なり
   * 以后再发现类似误判词，直接往这个数组里加即可（写平假名原形）。
   */
  const LEXICAL_BLOCK = [
    'できる', 'もてる', 'とくに',
    'かなり', 'なりすます',
    'はっきり', 'すっきり', 'まるきり',
    'いたる', 'あたる', 'ほたる',
    'うつつ',
    'まったり', 'ふたり',
    'みたい', 'もったいない', 'たいする',
    'ありがたい'
  ];

  /* ================= 词性过滤层（kuromoji 分词器，可选增强） =================
   * 词典（dict/ 目录）加载成功后启用；加载失败（如 file:// 直接打开）静默回退规则引擎。
   * 核心原则：命中区间不得「戳进」内容词 token 内部——
   *   手紙(名詞)里的 て、空手(名詞)里的 から、増す(動詞-自立)里的 ます 都会被拒绝；
   * 例外：～きる / ～がたい 等复合动词后缀语法允许命中 動詞-自立 的词尾（食べきる→きる）。
   */
  const POS_BLOCK = { '名詞': 1, '副詞': 1, '連体詞': 1, '感動詞': 1, '接続詞': 1, '形容詞': 1 };

  /* 允许作为「动词词尾后缀」命中的语法核心（其余命中 動詞-自立 内部的一律拒绝） */
  const SUFFIX_CORES = {
    'きる': 1, 'きれる': 1, 'ぬく': 1, 'かける': 1, 'かねる': 1,
    'がたい': 1, 'にくい': 1, 'やすい': 1, 'づらい': 1, 'がち': 1,
    'っぱなし': 1, 'すぎる': 1, 'おわる': 1, 'はじめる': 1, 'つづける': 1,
    'だす': 1, 'あがる': 1, 'あう': 1, 'がる': 1
  };

  /* 模式级词性约束：语法核心 → 命中区间必须整体覆盖该词性的 token。
     敬体 ます 必须是助動詞（行き→ます），不能是动词 増す（においがます）；
     单助词语法必须是助詞，防止分词异常时把名词残片当助词。 */
  const POS_REQUIRED = {
    'ます': ['助動詞'], 'ました': ['助動詞'], 'ません': ['助動詞'], 'ませんでした': ['助動詞'],
    'ましょう': ['助動詞'],
    'て': ['助詞'], 'で': ['助詞'], 'と': ['助詞'], 'から': ['助詞'], 'まで': ['助詞'],
    'に': ['助詞'], 'が': ['助詞'], 'を': ['助詞'], 'は': ['助詞'], 'も': ['助詞'],
    'へ': ['助詞'], 'の': ['助詞'], 'よ': ['助詞'], 'ね': ['助詞'], 'ば': ['助詞'],
    'や': ['助詞'], 'な': ['助詞'], 'ぞ': ['助詞'], 'ぜ': ['助詞'], 'わ': ['助詞'],
    'だ': ['助動詞'], 'です': ['助動詞']
  };

  let posTokenizer = null;   // 分词器实例，就绪后 analyze 自动启用词性过滤
  let posLoading = false;
  let posFailed = false;
  let posWaiters = [];

  function posReady() { return !!posTokenizer; }

  function flushPosWaiters(ok) {
    const ws = posWaiters; posWaiters = [];
    ws.forEach(function (f) { try { f(ok); } catch (e) { } });
  }

  /** 懒加载分词器；cb(ok) 在就绪/失败时回调（已就绪或已失败则立即回调） */
  function ensureTokenizer(cb) {
    if (posTokenizer) { if (cb) cb(true); return; }
    if (posFailed) { if (cb) cb(false); return; }
    if (cb) posWaiters.push(cb);
    if (posLoading) return;
    if (typeof kuromoji === 'undefined') { posFailed = true; flushPosWaiters(false); return; }
    posLoading = true;
    try {
      kuromoji.builder({ dicPath: 'dict' }).build(function (err, t) {
        posLoading = false;
        if (err || !t) { posFailed = true; flushPosWaiters(false); return; }
        posTokenizer = t;
        flushPosWaiters(true);
      });
    } catch (e) {
      posLoading = false;
      posFailed = true;
      flushPosWaiters(false);
    }
  }

  /** 该语法名是否为动词后缀型（～きる 等），决定动词词尾命中是否放行 */
  function isSuffixGrammar(name) {
    const cores = normCores(name);
    for (let i = 0; i < cores.length; i++) {
      if (SUFFIX_CORES[cores[i]]) return true;
    }
    return false;
  }

  /** 单个命中区间 vs 分词结果：戳进内容词内部 → false */
  function posHitOK(toks, h) {
    const hs = h.start, he = h.end;
    let reqOk = !h.posRequired;
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.e <= hs) continue;
      if (tk.s >= he) break;
      const whole = hs <= tk.s && he >= tk.e;
      if (whole) {   // 整体覆盖：复合语法本就由这些 token 组成（てから／ことは…）
        if (!reqOk && h.posRequired.indexOf(tk.pos) !== -1) reqOk = true;
        continue;
      }
      /* 部分覆盖（命中戳进 token 内部） */
      if (POS_BLOCK[tk.pos]) return false;                 // 名詞・副詞・形容詞等内部 → 误判
      if (tk.pos === '動詞' && tk.d1 === '自立') {
        /* 动词词尾后缀语法放行；増す→ます 因 ます∉SUFFIX_CORES 被拦截 */
        if (he === tk.e && hs > tk.s && h.suffixOK) continue;
        return false;
      }
      return false;   // 助詞/助動詞/非自立被部分覆盖：异常分词，保守拒绝
    }
    /* 模式级词性约束：敬体ます→助動詞、单助词语法→助詞（拦截 増す→ます 这类整体覆盖误判） */
    return reqOk;
  }

  /** 词性过滤主入口：分词器未就绪时原样返回（规则引擎兜底） */
  function posFilterHits(text, hits) {
    if (!posTokenizer) return hits;
    let raw;
    try { raw = posTokenizer.tokenize(text); } catch (e) { return hits; }
    const toks = raw.map(function (tk) {
      const s = tk.word_position - 1;
      return { s: s, e: s + tk.surface_form.length, pos: tk.pos, d1: tk.pos_detail_1 };
    });
    return hits.filter(function (h) { return posHitOK(toks, h); });
  }

  /* 括号配对表：全角/半角圆括号、［］、【】、{} */
  const BRACKET_CLOSE = {
    '（': '）', '(': ')',
    '［': '］', '[': ']',
    '【': '】', '{': '}'
  };

  /**
   * 常见音便・缩略别名表（key 已归一化：去～、去空格、括号统一成全角（））
   * variantsOf() 优先查此表，命中则直接用显式形式，不走括号解析。
   */
  const ALIAS_TABLE = [
    { key: 'ている', forms: ['ている', 'てる'] },
    { key: 'ておく', forms: ['ておく', 'とく'] },
    { key: 'てしまう', forms: ['てしまう', 'ちゃう', 'じゃう'] },
    { key: '（よ）うではないか', forms: ['うではないか', 'ようではないか', 'よではないか'] }
  ];

  /** 假名扩展：括号内出现这些假名时追加常见变体（原形式始终保留） */
  const KANA_VARIANTS = {
    'よ': ['よう', 'う']
  };

  /** 顶层「・／」变体切分（不切括号内部的 ・／） */
  function splitTopVariants(name) {
    const out = [];
    let buf = '', depth = 0;
    String(name).split('').forEach(function (ch) {
      if (BRACKET_CLOSE[ch]) { depth++; buf += ch; return; }
      if (ch === '）' || ch === ')' || ch === '］' || ch === ']' ||
        ch === '】' || ch === '}') {
        depth = Math.max(0, depth - 1);
        buf += ch;
        return;
      }
      if (depth === 0 && (ch === '・' || ch === '／')) { out.push(buf); buf = ''; return; }
      buf += ch;
    });
    if (buf.trim()) out.push(buf);
    return out;
  }

  /**
   * 归一化核心骨架集合：去～、去空格、去掉括号组（连同括号内内容），
   * 按顶层变体展开。用于 EXTRA_GRAMMAR 与题库卡片之间的同语法点判定。
   */
  function normCores(name) {
    const set = {};
    splitTopVariants(name).forEach(function (v) {
      const s = v
        .replace(/[〜～]/g, '')
        .replace(/[\s　]+/g, '')
        .replace(/[（(\[【{][^（）()\[\]【】{}]*[）)\]】}]/g, '');
      if (s) set[s] = 1;
    });
    return Object.keys(set);
  }

  /** 语法点身份键：归一化核心相同即视为同一语法点 */
  function gramKeyOf(name) {
    const cores = normCores(name);
    return cores.length ? cores.slice().sort().join('∣') : String(name);
  }

  /** 括号内容 → 候选集合：原内容（・／拆分、去空格）+ 假名变体；空串由整组 (...)? 表达 */
  function bracketCandidates(inner) {
    const set = {};
    inner.split(/[・／]/).forEach(function (piece) {
      const p = piece.replace(/[\s　]+/g, '');
      if (!p) return;
      set[p] = 1;
      (KANA_VARIANTS[p] || []).forEach(function (v2) { set[v2] = 1; });
    });
    return Object.keys(set).map(escRe);
  }

  /** 别名表查询：命中返回 RegExp，否则返回 null */
  function lookupAlias(variant) {
    const key = variant.trim()
      .replace(/[\s　]+/g, '')
      .replace(/[〜～]/g, '')
      .replace(/[（(\[【{]/g, '（')
      .replace(/[）)\]】}]/g, '）');
    for (let i = 0; i < ALIAS_TABLE.length; i++) {
      if (ALIAS_TABLE[i].key !== key) continue;
      const forms = ALIAS_TABLE[i].forms.slice()
        .sort(function (a, b) { return b.length - a.length; });
      const re = new RegExp('(?:' + forms.map(escRe).join('|') + ')', 'g');
      re._hasTilde = /[〜～]/.test(variant);
      re._hasBracket = key.indexOf('（') !== -1;
      re._brkPos = re._hasBracket ? '前' : '';
      re._core = forms[0];
      re._boundary = false;
      re._kanaShort = false;
      re._kanjiOne = false;
      return re;
    }
    return null;
  }

  /**
   * 单个变体 → 骨架精确匹配 RegExp：
   *  - 括号外骨架逐字精确；括号组 → (?:候选1|候选2|...)? （整组可空）
   *  - 首尾～不参与匹配；中间～折叠后 → 不跨句通配 [^。！？!?\n]{0,10}?
   * 元数据挂在正则对象上：_hasTilde / _hasBracket / _brkPos / _core / _boundary
   */
  function compileVariant(variant) {
    const hasTilde = /[〜～]/.test(variant);
    const s = variant.trim()
      .replace(/^[\s　]*[〜～]+[\s　]*/, '')
      .replace(/[\s　]*[〜～]+[\s　]*$/, '')
      .replace(/[〜～]+/g, '～');

    const parts = [], kinds = [];
    let buf = '', core = '', hasBracket = false;
    const flush = function () {
      if (buf) { parts.push(escRe(buf)); kinds.push('L'); core += buf; buf = ''; }
    };

    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      const close = BRACKET_CLOSE[ch];
      if (close) {
        const end = s.indexOf(close, i + 1);
        if (end > i) {
          flush();
          const cands = bracketCandidates(s.slice(i + 1, end));
          parts.push(cands.length ? '(?:' + cands.join('|') + ')?' : '');
          kinds.push('B');
          hasBracket = true;
          i = end + 1;
          continue;
        }
      }
      if (ch === '～') {
        flush();
        parts.push('[^。！？!?\\n]{0,10}?');
        kinds.push('W');
        i++;
        continue;
      }
      buf += ch;
      i++;
    }
    flush();
    if (!core) return null;

    /* 括号位置：首个字面之前=前，末个字面之后=後，其余=中 */
    const firstL = kinds.indexOf('L'), lastL = kinds.lastIndexOf('L');
    const pos = [];
    kinds.forEach(function (k, idx) {
      if (k === 'B') pos.push(idx < firstL ? '前' : idx > lastL ? '後' : '中');
    });

    let re;
    try { re = new RegExp(parts.join(''), 'g'); } catch (e) { return null; }
    re._hasTilde = hasTilde;
    re._hasBracket = hasBracket;
    re._brkPos = pos.join(',');
    re._core = core;
    /* 单假名短语法加词边界（如 ～う 不得命中 思う） */
    re._boundary = core.length === 1 && KANA_CHAR.test(core);
    /* 两假名核心（きる/なり/がち/ほど…）右侧再贴平假名多半是词的延续，
       如 できる 尾 きる、ほどける 头 ほど；含中间通配符的长模板不做此约束，
       さえ 类右侧需要直接接动词，放行 */
    const hasWild = kinds.indexOf('W') !== -1;
    re._kanaShort = !re._boundary && !hasWild && core.length === 2 &&
      HIRA_CHAR.test(core[0]) && HIRA_CHAR.test(core[1]) && !RIGHT_ATTACH[core];
    /* 单汉字核心（際/上）：两侧再贴汉字即 国際・売上 这类汉语词，不是语法 */
    re._kanjiOne = core.length === 1 && KANJI_CHAR.test(core);
    return re;
  }

  /**
   * 考点名称 → 正则数组（保持 RegExp[] 返回类型，元数据挂在正则对象上）
   * 流程：顶层・／变体 → 别名表优先 → 括号骨架解析
   */
  function variantsOf(name) {
    const out = [];
    splitTopVariants(String(name)).forEach(function (v) {
      if (!v.replace(/[〜～\s　]/g, '')) return;
      let re = null;
      try { re = lookupAlias(v) || compileVariant(v); } catch (e) { re = null; }
      if (re) out.push(re);
    });
    return out;
  }

  /**
   * 命中位置的词边界约束（元数据挂在正则对象上）：
   *  - _boundary  单假名语法：前不接词字符，后只跟助词（思う 不命中 ～う）
   *  - _kanaShort 两假名核心：右侧紧跟平假名且不是助词/接续成分 → 词的一部分
   *  - _kanjiOne  单汉字核心：两侧贴汉字即汉语词（国際・売上・実際）
   */
  function boundaryOK(text, start, end, re) {
    const p = text.charAt(start - 1);
    const q = text.charAt(end);
    if (re._boundary) {
      if (p && JP_WORD_CHAR.test(p)) return false;
      if (q && KANA_CHAR.test(q) && !PARTICLE_AFTER.test(q)) return false;
    }
    if (re._kanaShort && q && HIRA_CHAR.test(q) && !PARTICLE_AFTER.test(q)) return false;
    if (re._kanjiOne) {
      if (p && KANJI_CHAR.test(p)) return false;
      /* 右侧汉字检查只在匹配面以汉字收尾时生效：上達・上手 是汉语词，
         而「際は／上で」已带出助词は・で，后面的汉字是下一个词（際は発言） */
      if (q && KANJI_CHAR.test(q) && KANJI_CHAR.test(text.charAt(end - 1))) return false;
    }
    return true;
  }

  /**
   * 命中区间是否落在 LEXICAL_BLOCK 常见排除词上。
   * 先把区间向两侧扩成完整的「日文词串」，再找与命中区间真正重叠的排除词
   *（はっきりしている 中的 ている 不能被 はっきり 连累）。
   */
  function lexicalBlocked(text, start, end) {
    let s = start, e = end;
    while (s > 0 && JP_WORD_CHAR.test(text.charAt(s - 1))) s--;
    while (e < text.length && JP_WORD_CHAR.test(text.charAt(e))) e++;
    for (let i = 0; i < LEXICAL_BLOCK.length; i++) {
      const w = LEXICAL_BLOCK[i], wlen = w.length;
      let p = s;
      while ((p = text.indexOf(w, p)) !== -1 && p < e) {
        if (p + wlen > start && p < end) return true;
        p += wlen;
      }
    }
    return false;
  }

  /** 用户显式标记为重点的卡片（字段预留）；冲突时优先于普通卡片 */
  function isKeyPoint(card) {
    return !!(card && (card.star || card.starred || card.important ||
      card.keyPoint || card.marked));
  }

  /** 扫描文章，返回 { hits:[{start,end,surface,card,extra,key,pri}], points:[...] } */
  function analyze(text) {
    const cards = Store.getCards();
    const matchers = [];
    const knownCores = {};   // 题库已覆盖的归一化核心骨架（长度 >= 2）

    /* 题库卡片：内部也按归一化核心去重，同骨架卡片不重复建匹配器 */
    cards.forEach(function (c) {
      const cores = normCores(c.name);
      if (cores.some(function (v) { return v.length >= 2 && knownCores[v]; })) return;
      cores.forEach(function (v) { if (v.length >= 2) knownCores[v] = 1; });
      const key = gramKeyOf(c.name);
      /* 模式级词性约束：核心命中 POS_REQUIRED 表时，命中必须覆盖对应词性的 token */
      let posReq = null;
      cores.forEach(function (v) { if (!posReq && POS_REQUIRED[v]) posReq = POS_REQUIRED[v]; });
      variantsOf(c.name).forEach(function (re) {
        matchers.push({ card: c, extra: null, re: re, key: key, posRequired: posReq });
      });
    });

    /* EXTRA_GRAMMAR 与题库按归一化核心去重（不再按 name 全等判断） */
    EXTRA_GRAMMAR.forEach(function (x) {
      const cores = normCores(x.name);
      if (cores.some(function (v) { return v.length >= 2 && knownCores[v]; })) return;
      try {
        let posReq = null;
        cores.forEach(function (v) { if (!posReq && POS_REQUIRED[v]) posReq = POS_REQUIRED[v]; });
        matchers.push({ card: null, extra: x, re: new RegExp(x.re, 'g'), key: gramKeyOf(x.name), posRequired: posReq });
      } catch (e) { }
    });

    /* ---- 扫描全部原始命中 ---- */
    const hits = [];
    const seen = {};   // 语法点层面去重：key#start-end
    matchers.forEach(function (m) {
      const re = m.re;
      re.lastIndex = 0;
      let mt;
      while ((mt = re.exec(text))) {
        if (re.lastIndex === mt.index) re.lastIndex++;
        if (!mt[0]) continue;
        const start = mt.index, end = start + mt[0].length;
        /* 词边界约束（单假名 / 两假名短核心 / 单汉字） */
        if (!boundaryOK(text, start, end, re)) continue;
        /* 常见词排除：できる 不当 ～きる、かなり 不当 ～なり … */
        if (lexicalBlocked(text, start, end)) continue;
        /* 第一层（语法点层面）去重：同一语法点同一区间只保留一个 */
        const dk = m.key + '#' + start + '-' + end;
        if (seen[dk]) continue;
        seen[dk] = 1;
        /* 冲突优先级：长语法（区间长度，排序时体现）＞ 带～ ＞ 带括号 ＞ 重点标记 ＞ 题库卡片 */
        let pri = 0;
        if (re._hasTilde) pri += 8;
        if (re._hasBracket) pri += 4;
        if (isKeyPoint(m.card)) pri += 2;
        if (m.card) pri += 1;
        hits.push({
          start: start, end: end, surface: mt[0],
          card: m.card, extra: m.extra, key: m.key, pri: pri,
          suffixOK: m.card ? isSuffixGrammar(m.card.name) : false,
          posRequired: m.posRequired || null
        });
      }
    });

    /* ---- 第二层（区间层面）去重叠：起点升序、同起点长度降序、再按优先级 ---- */
    hits.sort(function (a, b) {
      return a.start - b.start ||
        (b.end - b.start) - (a.end - a.start) ||
        b.pri - a.pri;
    });
    const accepted = [];
    hits.forEach(function (h) {
      for (let i = accepted.length - 1; i >= 0; i--) {
        const a = accepted[i];
        if (a.end <= h.start) break;        // 不重叠；更早接受的区间也不可能重叠
        const hl = h.end - h.start, al = a.end - a.start;
        if (hl > al || (hl === al && h.pri > a.pri)) {
          accepted.splice(i, 1);           // 当前更长（或等长更优）→ 替换短匹配
        } else {
          return;                          // 当前不够长 → 丢弃，长匹配保留
        }
      }
      accepted.push(h);                    // 与已接受区间不重叠 → 直接接受
    });

    /* ---- 词性过滤（kuromoji 就绪时启用）：剔除戳进名词/动词内部的误判 ---- */
    const finalHits = posFilterHits(text, accepted);

    /* 汇总语法点（按出现次数降序）；同一身份键只出一个点，有卡片时以卡片为代表 */
    const pmap = {};
    finalHits.forEach(function (h) {
      let p = pmap[h.key];
      if (!p) {
        p = pmap[h.key] = {
          name: h.card ? h.card.name : h.extra.name,
          card: h.card, extra: h.extra,
          isNew: !h.card, count: 0, surfaces: []
        };
      } else if (!p.card && h.card) {
        p.card = h.card;
        p.name = h.card.name;
        p.isNew = false;
      }
      p.count++;
      if (p.surfaces.indexOf(h.surface) === -1) p.surfaces.push(h.surface);
    });
    const points = Object.keys(pmap).map(function (k) { return pmap[k]; })
      .sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); });

    return { hits: finalHits, points: points };
  }

  /* ================= 难度判定 =================
   * 文章长度(25%) + 平均句长(35%) + 语法点平均等级(40%)
   * → 基础 / 进阶 / 高频（对应题目难度 易 / 中 / 难） */
  function assessDifficulty(text, points) {
    const questions = Store.getQuestions();
    const chars = text.length;
    const sents = text.split(/[。！？!?\n]+/).filter(function (s) { return s.trim(); });
    const avgLen = sents.length ? chars / sents.length : chars;
    const lenScore = chars < 150 ? 1 : chars < 350 ? 2 : 3;
    const sentScore = avgLen < 20 ? 1 : avgLen < 35 ? 2 : 3;

    const known = points.filter(function (p) { return !p.isNew; });
    let gram = 2;
    if (known.length) {
      gram = known.reduce(function (sum, p) {
        const qs = questions.filter(function (q) { return q.point === p.name; });
        if (!qs.length) return sum + 2;
        return sum + qs.reduce(function (s, q) { return s + (LV[q.difficulty] || 2); }, 0) / qs.length;
      }, 0) / known.length;
    }

    const total = lenScore * 0.25 + sentScore * 0.35 + gram * 0.4;
    return total <= 1.7 ? '基础' : total <= 2.3 ? '进阶' : '高频';
  }

  /* ================= 自动出题 ================= */

  function shuffleArr(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** 无通配的简单字面量（干扰项池用）；含通配/变体则返回 null */
  function simpleCore(name) {
    const s = String(name).replace(/^[〜～]+/, '').replace(/[〜～]+$/, '');
    return /[〜～・／（）()]/.test(s) ? null : s;
  }

  /** 题库没有该考点的题时，用卡片例句模板生成一道填空题 */
  function genFromCard(card, targetDiff, analysis) {
    if (!card || !card.examples || !card.examples.length) return null;
    const res = variantsOf(card.name);
    for (let e = 0; e < card.examples.length; e++) {
      const ex = card.examples[e];
      for (let r = 0; r < res.length; r++) {
        const re = res[r];
        re.lastIndex = 0;
        const m = re.exec(ex.jp);
        if (!m || !m[0] || m[0].length < 2) continue;
        const correct = m[0];

        /* 干扰项：优先本文其他语法点的匹配面，其次其他卡片字面量 */
        const pool = [];
        analysis.points.forEach(function (p) {
          if (p.name === card.name) return;
          p.surfaces.forEach(function (sf) {
            if (sf !== correct && sf.length >= 2 && pool.indexOf(sf) === -1) pool.push(sf);
          });
        });
        if (pool.length < 3) {
          Store.getCards().forEach(function (c) {
            if (c.name === card.name) return;
            const core = simpleCore(c.name);
            if (core && core !== correct && core.length >= 2 && pool.indexOf(core) === -1) {
              pool.push(core);
            }
          });
        }
        if (pool.length < 3) return null;

        const opts = shuffleArr([correct].concat(shuffleArr(pool).slice(0, 3)));
        return {
          id: Store.uid('artq'),
          category: card.category || '文章精读',
          point: card.name,
          type: '单选题',
          stem: ex.jp.replace(correct, '（　）'),
          options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] },
          answer: 'ABCD'[opts.indexOf(correct)],
          explanation: card.summary || '',
          difficulty: targetDiff
        };
      }
    }
    return null;
  }

  /**
   * 针对本文出题：考点全部来自文章实际出现的语法点；
   * 优先选题库中与文章难度一致的题，每考点最多 2 题，共最多 12 题；
   * 某考点题库无题时，用卡片例句自动生成。
   */
  function buildExercise(article, analysis) {
    const target = DIFF_TO_Q[article.difficulty] || '中';
    const all = Store.getQuestions();
    const picked = [], used = {}, genNew = [];

    analysis.points.forEach(function (p) {
      if (p.isNew) return;
      const qs = all.filter(function (q) { return q.point === p.name; });
      if (qs.length) {
        const same = qs.filter(function (q) { return q.difficulty === target; });
        shuffleArr(same.length ? same : qs).slice(0, 2).forEach(function (q) {
          if (!used[q.id] && picked.length < 12) { used[q.id] = 1; picked.push(q); }
        });
      } else if (p.card) {
        const g = genFromCard(p.card, target, analysis);
        if (g && picked.length < 12) { genNew.push(g); picked.push(g); used[g.id] = 1; }
      }
    });

    if (genNew.length) Store.addQuestions(genNew);
    return picked;
  }

  /* ================= 渲染：文章列表 ================= */

  function fmtDate(ts) {
    const d = new Date(ts);
    const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderList() {
    current = null;
    aiText = '';
    aiPreview = null;
    closePop();
    const B = window.AppBridge;
    const arts = Store.getArticles();

    const listHTML = arts.length ? arts.map(function (a) {
      /* 语法点数随卡片库增长而变化：每次打开列表都用当前题库重新识别一次，
         卡片导入得越多，识别越全；并把最新结果回写到文章记录 */
      const live = analyze(a.text);
      const pointCount = live.points.length;
      const newCount = live.points.filter(function (p) { return p.isNew; }).length;
      if (pointCount !== a.pointCount || newCount !== a.newCount) {
        a.pointCount = pointCount;
        a.newCount = newCount;
        a.difficulty = assessDifficulty(a.text, live.points);
        Store.updateArticle(a);
      }
      return '<div class="art-item" data-art="open" data-id="' + a.id + '">' +
        '<div class="ai-main">' +
        '<div class="ai-title">' + B.esc(a.title) + '</div>' +
        '<div class="ai-meta">' +
        '<span>' + fmtDate(a.createdAt) + '</span>' +
        '<span class="badge ' + DIFF_BADGE[a.difficulty] + '">' + B.esc(a.difficulty) + '</span>' +
        '<span class="badge todo">' + pointCount + ' 个语法点</span>' +
        (newCount ? '<span class="badge new-pt">新 ' + newCount + '</span>' : '') +
        (a.questionIds && a.questionIds.length
          ? '<span class="badge done">练习 ' + a.questionIds.length + ' 题</span>' : '') +
        '</div></div>' +
        '<button class="btn-mini danger ai-del" data-art="del" data-id="' + a.id + '">删除</button>' +
        '</div>';
    }).join('') :
      '<div class="empty"><span class="e-ico">📖</span>' +
      '<div class="e-txt">还没有导入过文章<br>粘贴一段日语文章，自动标出里面的语法点</div></div>';

    B.setHTML(
      '<header class="page-head"><h1>文章精读</h1>' +
      '<div class="sub">粘贴日语文章 → 语法高亮 → 自动出题，共 ' + arts.length + ' 篇</div></header>' +
      '<a class="btn btn-ink" href="#/article/new" style="margin-bottom:16px">＋ 导入新文章</a>' +
      listHTML
    );
  }

  /* ================= 渲染：导入页 ================= */

  function renderNew() {
    current = null;
    aiText = '';
    aiPreview = null;
    closePop();
    const B = window.AppBridge;
    B.setHTML(
      '<a class="back-link" href="#/articles">‹ 返回</a>' +
      '<header class="page-head"><h1>导入文章</h1>' +
      '<div class="sub">粘贴一段日语文章，系统自动识别其中的语法点</div></header>' +
      '<div class="import-card">' +
      '<label>日语文章（纯文本）</label>' +
      '<textarea id="artText" placeholder="在此粘贴日语文章…&#10;&#10;例：日本の少子高齢化が進むにつれて、労働力不足が深刻になっている。…"></textarea>' +
      '<div class="fmt-hint">识别依据：各语法点的核心接续形式。' +
      '题库中暂未收录的语法会标记为「新语法点」，可一键补充到题库。</div>' +
      '</div>' +
      '<button class="btn btn-ink" data-art="analyze">分析文章</button>'
    );
  }

  function doAnalyze() {
    const B = window.AppBridge;
    const ta = document.getElementById('artText');
    const text = (ta ? ta.value : '').trim();
    if (text.length < 10) { B.toast('文章太短，至少 10 个字符'); return; }

    const analysis = analyze(text);
    const article = {
      id: Store.uid('a'),
      text: text,
      title: text.replace(/\s+/g, ' ').slice(0, 20),
      createdAt: Date.now(),
      pointCount: analysis.points.length,
      newCount: analysis.points.filter(function (p) { return p.isNew; }).length,
      difficulty: assessDifficulty(text, analysis.points),
      questionIds: []
    };
    Store.addArticle(article);
    aiText = '';
    aiPreview = null;
    B.toast('识别出 ' + article.pointCount + ' 个语法点 · 难度：' + article.difficulty);
    location.hash = '#/article/' + article.id;
  }

  /* ================= 渲染：精读页 ================= */

  function renderDetail(id) {
    const B = window.AppBridge;
    const a = Store.getArticleById(id);
    if (!a) {
      B.setHTML('<div class="empty"><span class="e-ico">🔍</span>' +
        '<div class="e-txt">文章不存在或已删除</div>' +
        '<a class="btn btn-primary back-link" href="#/articles">‹ 返回</a></div>');
      return;
    }
    if (!current || !current.article || current.article.id !== id) {
      detailTab = 'points';
      aiText = '';
      aiPreview = null;
    }
    closePop();

    /* 首次进入精读页时懒加载分词器；词典就绪后若当前 hits 有变化则自动刷新 */
    if (typeof kuromoji !== 'undefined' && !posReady() && !posFailed) {
      ensureTokenizer(function (ok) {
        if (!ok) return;
        const fresh = analyze(a.text);
        if (fresh.points.length !== current.analysis.points.length ||
            fresh.hits.length !== current.analysis.hits.length) {
          current.analysis = fresh;
          renderDetail(id);
        }
      });
    }

    const analysis = analyze(a.text);
    current = { article: a, analysis: analysis };

    /* ---- 高亮原文 ---- */
    let bodyHTML = '', pos = 0;
    analysis.hits.forEach(function (h, i) {
      bodyHTML += B.esc(a.text.slice(pos, h.start));
      bodyHTML += '<span class="hl' + (h.card ? '' : ' new') +
        '" data-art="hl" data-idx="' + i + '">' + B.esc(h.surface) + '</span>';
      pos = h.end;
    });
    bodyHTML += B.esc(a.text.slice(pos));

    /* ---- 语法点清单 ---- */
    const pointsHTML = analysis.points.length ? analysis.points.map(function (p) {
      let body;
      if (p.card) {
        const c = p.card;
        const subChips = (Array.isArray(c.subPoints) && c.subPoints.length)
          ? '<div class="pt-sec-t">🔖 用法</div><div class="pt-subs">' +
          c.subPoints.map(function (sp) {
            return '<a class="pt-sub-chip" href="#/card/' + encodeURIComponent(c.name) + '">' +
              B.esc(sp.title) + '</a>';
          }).join('') + '</div>'
          : '';
        body =
          '<div class="pt-sec-t">📌 摘要</div><div class="pt-sec-b">' + B.esc(c.summary || '暂无') + '</div>' +
          subChips +
          (c.lecture ? '<div class="pt-sec-t">📖 讲解</div><div class="pt-sec-b">' + B.esc(c.lecture) + '</div>' : '') +
          (c.examples && c.examples.length ?
            '<div class="pt-sec-t">💬 例句</div>' +
            c.examples.slice(0, 2).map(function (ex) {
              return '<div class="example-item"><div class="ex-jp">' + B.esc(ex.jp) +
                '</div><div class="ex-cn">' + B.esc(ex.cn) + '</div></div>';
            }).join('') : '') +
          multiSourceHTML(B, c) +
          '<a class="pt-link" href="#/card/' + encodeURIComponent(c.name) + '">查看完整卡片 ›</a>';
      } else {
        body =
          '<div class="pt-sec-b">' + B.esc(p.extra.summary || '') + '</div>' +
          '<div class="pt-new-tip">题库中暂未收录该语法点</div>' +
          '<button class="btn-mini" data-art="pt-add" data-name="' + B.esc(p.name) + '">＋ 补充到题库</button>';
      }
      return '<div class="pt-item">' +
        '<div class="pt-head" data-art="pt-toggle">' +
        '<span class="pt-name">' + B.esc(p.name) + '</span>' +
        (p.isNew ? '<span class="badge new-pt">新语法点</span>'
          : '<span class="badge cat">' + B.esc(p.card.category) + '</span>') +
        '<span class="badge todo">×' + p.count + '</span>' +
        '<span class="pt-arrow">›</span>' +
        '</div>' +
        '<div class="pt-body" hidden>' + body + '</div>' +
        '</div>';
    }).join('') :
      '<div class="empty"><span class="e-ico">🧐</span>' +
      '<div class="e-txt">没有识别出已知的语法点</div></div>';

    /* ---- 本文练习 ---- */
    const qids = a.questionIds || [];
    const exSecs = aiSectionsHTML(B);
    let exHTML;
    if (qids.length) {
      const qs = qids.map(function (qid) { return Store.getQuestionById(qid); })
        .filter(Boolean);
      exHTML =
        '<div class="ex-sec">' +
        '<div class="ex-sec-t">练习已就绪 · ' + qs.length + ' 题</div>' +
        '<div class="ex-sec-d">难度 ' + B.esc(a.difficulty) + ' · 答错自动进错题本</div>' +
        qs.map(function (q) {
          return '<div class="ai-pv-item"><b>' + B.esc(q.point) + '</b>' + B.esc(q.stem) + '</div>';
        }).join('') +
        '<button class="btn btn-ink" data-art="start" style="margin-top:12px">▶ 开始练习</button>' +
        '</div>' +
        '<div class="ex-div">更 多 出 题</div>' + exSecs;
    } else {
      exHTML =
        '<div class="fmt-hint" style="margin-bottom:12px">考点全部来自本文实际出现的语法点，' +
        '题目难度与文章难度（' + B.esc(a.difficulty) + '）一致；答题记录与错题本完全打通。</div>' +
        exSecs;
    }

    const newCount = analysis.points.filter(function (p) { return p.isNew; }).length;

    B.setHTML(
      '<a class="back-link" href="#/articles">‹ 返回</a>' +
      '<header class="page-head"><h1>文章精读</h1>' +
      '<div class="art-meta-row">' +
      '<span class="badge ' + DIFF_BADGE[a.difficulty] + '">' + B.esc(a.difficulty) + '难度</span>' +
      '<span class="badge todo">' + analysis.points.length + ' 个语法点</span>' +
      (newCount ? '<span class="badge new-pt">新语法点 ' + newCount + '</span>' : '') +
      '<span class="badge todo">' + fmtDate(a.createdAt) + '</span>' +
      '</div></header>' +

      '<div class="art-body">' + bodyHTML + '</div>' +
      '<div class="hl-hint">— 点击高亮处查看语法说明 —</div>' +

      '<div class="import-tabs">' +
      '<div class="import-tab' + (detailTab === 'points' ? ' active' : '') +
      '" data-art="tab" data-tab="points">语法点清单 (' + analysis.points.length + ')</div>' +
      '<div class="import-tab' + (detailTab === 'exercise' ? ' active' : '') +
      '" data-art="tab" data-tab="exercise">本文练习' + (qids.length ? ' (' + qids.length + ')' : '') + '</div>' +
      '</div>' +
      (detailTab === 'points' ? pointsHTML : exHTML)
    );
  }

  /* ================= AI 出题：提示词 + 粘贴导入 ================= */

  /** 根据本文语法点与难度，生成可复制的出题提示词 */
  function buildPrompt() {
    const a = current.article, an = current.analysis;
    const qDiff = DIFF_TO_Q[a.difficulty] || '中';
    const pts = an.points.map(function (p) { return '・' + p.name; }).join('\n');
    return '你是一名日语语法老师。请针对下面的日语文章出 10 道语法单选题，要求：\n' +
      '1. 考点只能从「文中出现的语法点」列表中选，每题聚焦一个考点；\n' +
      '2. 题目难度为「' + qDiff + '」，与文章难度（' + a.difficulty + '）一致；\n' +
      '3. 四个选项考察同一考点的近似形式，干扰项要有迷惑性；\n' +
      '4. 题干地道自然，挖空处用（　）标出；\n' +
      '5. 严格按下面的格式输出，题目之间用空行分隔，不要输出任何其他内容：\n\n' +
      '【门类】文章精读\n【考点名称】考点名称\n【题型】单选题\n【题干】……（　）……\n' +
      '【选项A】…\n【选项B】…\n【选项C】…\n【选项D】…\n【答案】A\n【解析】中文解析\n【难度】' + qDiff + '\n\n' +
      '文中出现的语法点：\n' + pts + '\n\n【文章】\n' + a.text;
  }

  function aiSectionsHTML(B) {
    return '<div class="ex-sec">' +
      '<div class="ex-sec-t">🤖 AI 精准出题 · 推荐</div>' +
      '<div class="ex-sec-d">① 复制提示词发给任意 AI（豆包 / ChatGPT 等）<br>' +
      '② 把 AI 回复的题目粘贴到下面，解析后一键入库</div>' +
      '<button class="btn btn-ink" data-art="ai-prompt">📋 一键复制出题提示词</button>' +
      '<textarea id="aiPaste" placeholder="把 AI 生成的题目粘贴到这里…">' +
      B.esc(aiText) + '</textarea>' +
      '<button class="btn btn-ink-line" data-art="ai-parse">解析预览</button>' +
      renderAIPreview(B) +
      '</div>' +
      '<div class="ex-sec">' +
      '<div class="ex-sec-t">✨ 本地快速出题</div>' +
      '<div class="ex-sec-d">离线用卡片例句挖空生成，方便但质量有限</div>' +
      '<button class="btn btn-ink-line" data-art="gen">自动生成</button>' +
      '</div>';
  }

  function renderAIPreview(B) {
    if (!aiPreview) return '';
    const valid = aiPreview.filter(function (p) { return p.valid; });
    const invalid = aiPreview.length - valid.length;
    return '<div class="ai-preview">' +
      '<div class="ai-pv-sum">解析出 ' + aiPreview.length + ' 道题：有效 ' + valid.length +
      (invalid ? '，无效 ' + invalid : '') + '</div>' +
      valid.slice(0, 5).map(function (p) {
        return '<div class="ai-pv-item"><b>' + B.esc(p.data.point) + '</b>' +
          B.esc(p.data.stem) + '</div>';
      }).join('') +
      (valid.length > 5 ? '<div class="ai-pv-more">…共 ' + valid.length + ' 道</div>' : '') +
      (valid.length
        ? '<button class="btn btn-ink" data-art="ai-confirm" style="margin-top:12px">确认导入 ' +
        valid.length + ' 题</button>'
        : '<div class="ai-pv-err">没有可导入的有效题目，请检查格式是否与提示词一致</div>') +
      '</div>';
  }

  function doAIParse() {
    if (!current) return;
    const B = window.AppBridge;
    const ta = document.getElementById('aiPaste');
    aiText = ta ? ta.value : '';
    if (!aiText.trim()) { B.toast('请先粘贴 AI 生成的题目'); return; }
    aiPreview = Parser.parseQuestionsText(aiText);
    renderDetail(current.article.id);
  }

  function doAIConfirm() {
    if (!current || !aiPreview) return;
    const B = window.AppBridge;
    const valid = aiPreview.filter(function (p) { return p.valid; });
    const dup = new Set(Store.getQuestions().map(function (q) {
      return q.point + '||' + q.stem;
    }));
    const fresh = [];
    valid.forEach(function (p) {
      const key = p.data.point + '||' + p.data.stem;
      if (dup.has(key)) return;
      dup.add(key);
      fresh.push(Object.assign({}, p.data, { id: Store.uid('artq') }));
    });
    if (!fresh.length) { B.toast('没有可导入的新题目（可能全部重复）'); return; }
    Store.addQuestions(fresh);
    const a = Store.getArticleById(current.article.id) || current.article;
    a.questionIds = (a.questionIds || []).concat(fresh.map(function (q) { return q.id; }));
    Store.updateArticle(a);
    aiText = '';
    aiPreview = null;
    B.toast('已导入 ' + fresh.length + ' 道题，可以开始练习了');
    renderDetail(a.id);
  }

  /* ================= 高亮弹卡 ================= */

  function closePop() {
    if (popEl) { popEl.remove(); popEl = null; }
  }

  /** 来源（书·章节）显示名 */
  function scopeLabel(bookId, chapterId) {
    if (!bookId) return '未分类';
    const book = Store.getBookById(bookId);
    let t = book ? book.name : '未知书籍';
    if (chapterId && book && Array.isArray(book.chapters)) {
      const ch = book.chapters.find(c => c.id === chapterId);
      if (ch) t += ' · ' + ch.name;
    }
    return t;
  }

  /**
   * 多来源摘要块：一个主考点挂了多个来源（书）时，
   * 列出各来源书名 + 摘要首句（最多3条），精读只按主考点匹配一次。
   */
  function multiSourceHTML(B, card) {
    const srcs = (card.sources && card.sources.length)
      ? card.sources
      : [{ bookId: card.bookId || '', chapterId: card.chapterId || '', summary: card.summary || '' }];
    if (srcs.length <= 1) return '';
    const rows = srcs.slice(0, 3).map(function (s) {
      const first = (s.summary || '').split(/[。．.\n]/)[0].slice(0, 40);
      return '<div class="ms-src-row">📖《' + B.esc(scopeLabel(s.bookId, s.chapterId)) + '》：' +
        B.esc(first || '（无摘要）') + '</div>';
    }).join('');
    const more = srcs.length > 3
      ? '<div class="ms-src-more">其余 ' + (srcs.length - 3) + ' 个来源见完整卡片</div>' : '';
    return '<div class="ms-src-box"><div class="ms-src-tip">📚 这个语法点有 ' +
      srcs.length + ' 个来源讲解（各书讲解独立保留，不合并）</div>' + rows + more + '</div>';
  }

  function showPop(idx, x, y) {
    closePop();
    if (!current) return;
    const h = current.analysis.hits[idx];
    if (!h) return;
    const B = window.AppBridge;

    popEl = document.createElement('div');
    popEl.className = 'hl-pop';
    if (h.card) {
      popEl.innerHTML =
        '<div class="hp-name">' + B.esc(h.card.name) + '</div>' +
        '<div class="hp-cat">' + B.esc(h.card.category) + '</div>' +
        '<div class="hp-sum">' + B.esc(h.card.summary || '暂无摘要') + '</div>' +
        multiSourceHTML(B, h.card) +
        '<a class="hp-link" href="#/card/' + encodeURIComponent(h.card.name) + '">查看完整卡片 ›</a>';
    } else {
      popEl.innerHTML =
        '<div class="hp-name">' + B.esc(h.extra.name) +
        ' <span class="badge new-pt">新语法点</span></div>' +
        '<div class="hp-sum">' + B.esc(h.extra.summary || '') + '</div>' +
        '<div class="hp-tip">题库暂未收录，可在下方清单中一键补充</div>';
    }
    document.body.appendChild(popEl);
    const w = popEl.offsetWidth, ht = popEl.offsetHeight;
    let left = Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8);
    let top = y - ht - 12;
    if (top < 8) top = y + 16;
    popEl.style.left = left + 'px';
    popEl.style.top = top + 'px';
  }

  /* ================= 动作 ================= */

  function doGenerate() {
    const B = window.AppBridge;
    if (!current) return;
    const qs = buildExercise(current.article, current.analysis);
    if (!qs.length) { B.toast('本文语法点暂无可用题目'); return; }
    current.article.questionIds = qs.map(function (q) { return q.id; });
    Store.updateArticle(current.article);
    B.toast('已生成 ' + qs.length + ' 道练习');
    renderDetail(current.article.id);
  }

  function doStart() {
    const B = window.AppBridge;
    if (!current) return;
    const qs = (current.article.questionIds || [])
      .map(function (id) { return Store.getQuestionById(id); })
      .filter(Boolean);
    if (!qs.length) { B.toast('练习不存在，请重新生成'); return; }
    B.startSession('article', '本文练习', qs, '', current.article.id);
  }

  function doAddPoint(name) {
    const B = window.AppBridge;
    const extra = EXTRA_GRAMMAR.filter(function (x) { return x.name === name; })[0];
    if (!extra) return;
    const r = Store.importCards([{
      id: Store.uid('c'),
      name: extra.name,
      category: '文章精读·新语法',
      summary: extra.summary,
      lecture: extra.summary,
      examples: []
    }]);
    B.toast(r.added ? '已补充到题库' : '题库已存在该卡片');
    if (current) renderDetail(current.article.id);
  }

  /* ================= 事件（独立委托，action 前缀 data-art） ================= */

  document.addEventListener('click', function (e) {
    const hl = e.target.closest('[data-art="hl"]');
    if (hl) {
      showPop(Number(hl.dataset.idx), e.clientX, e.clientY);
      return;
    }
    if (e.target.closest('.hl-pop')) return;
    closePop();

    const el = e.target.closest('[data-art]');
    if (!el) return;
    const B = window.AppBridge;

    switch (el.dataset.art) {
      case 'analyze': doAnalyze(); break;
      case 'open': location.hash = '#/article/' + el.dataset.id; break;
      case 'del':
        e.stopPropagation();
        if (confirm('确定删除这篇文章？已生成的练习题会保留在题库中。')) {
          Store.deleteArticle(el.dataset.id);
          B.toast('已删除');
          renderList();
        }
        break;
      case 'tab':
        detailTab = el.dataset.tab;
        if (current) renderDetail(current.article.id);
        break;
      case 'pt-toggle': {
        const body = el.parentNode.querySelector('.pt-body');
        if (body) {
          body.hidden = !body.hidden;
          el.classList.toggle('open', !body.hidden);
        }
        break;
      }
      case 'pt-add': doAddPoint(el.dataset.name); break;
      case 'gen': case 'regen': doGenerate(); break;
      case 'start': doStart(); break;
      case 'ai-prompt': {
        if (!current) break;
        B.copyText(buildPrompt()).then(
          function () { B.toast('提示词已复制，发给任意 AI 即可'); },
          function () { B.toast('复制失败，请长按手动选择'); }
        );
        break;
      }
      case 'ai-parse': doAIParse(); break;
      case 'ai-confirm': doAIConfirm(); break;
    }
  });

  window.addEventListener('hashchange', closePop);

  /* ---------- 对外接口（app.js 路由调用） ---------- */
  window.ArticlePage = {
    renderList: renderList,
    renderNew: renderNew,
    renderDetail: renderDetail,
    analyze: analyze,
    assessDifficulty: assessDifficulty,
    ensureTokenizer: ensureTokenizer,
    posReady: posReady
  };
})();
