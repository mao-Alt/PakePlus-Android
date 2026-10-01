/* =====================================================================
 * games.js —— 训练场：语法 Boss 战 + 长难句拆弹（+ 首页薄弱点数据源）
 *
 * 路由：
 *   #/games           训练场首页（模式入口 + 战绩）
 *   #/boss            Boss 列表
 *   #/boss/<考点>     Boss 战斗（血条 / 掉血 / 回血 / 星级）
 *   #/bomb            拆弹选关
 *   #/bomb/<1|2|3>    拆弹进行（贴标签 / 判定 / 重组高亮）
 *
 * 数据（storage.js 提供）：
 *   jp_boss_v1     { 考点: {stars, tries} }
 *   jp_bomblog_v1  [{ts, tag, chunk, chose, correct, reason}]
 * =================================================================== */

(function () {
  'use strict';

  function B() { return window.AppBridge; }
  function esc(s) { return B().esc(s); }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ================= 成分角色体系（v2 细分标签） =================
   * 大类（role）：SUB 主语 / PRED 谓语 / OBJ 宾语 / MOD 修饰语 / COMP 补语
   * 细分标签（lab，展示用）：主题、动作主体、判定、称谓、引用、条件、原因、
   *   时间、场所、手段、目的、对象、方向、程度、对比、接续、判断结果、宾语（能力对象）等
   * chunk 数据模型（v2）：
   *   t  文本 | r 角色（兼容旧中文值，内部归一为大类码）
   *   m  修饰目标：下标 / 下标数组（仅修饰语，支持多目标） | null
   *   x  块讲解 | c 子块数组（嵌套 chunk） | cl 从句/主题/引用 等细分
   */
  const ROLE_CODE = {
    'SUB': '主语', 'PRED': '谓语', 'OBJ': '宾语', 'MOD': '修饰语', 'COMP': '补语'
  };
  const ROLE_TO_CODE = {
    '主语': 'SUB', '谓语': 'PRED', '宾语': 'OBJ', '修饰语': 'MOD', '补语': 'COMP',
    'SUB': 'SUB', 'PRED': 'PRED', 'OBJ': 'OBJ', 'MOD': 'MOD', 'COMP': 'COMP',
    '主题': 'SUB', '话题': 'SUB', '主題': 'SUB',
    '判定主语': 'SUB', '称谓': 'SUB', '称谓主语': 'SUB', '引用主语': 'SUB', '主体': 'SUB',
    '动作主体': 'SUB', '动作执行者': 'SUB',
    '宾语': 'OBJ', '对象': 'OBJ', '能力对象': 'OBJ',
    '引用': 'OBJ', '内容': 'OBJ',
    '条件': 'MOD', '原因': 'MOD', '理由': 'MOD',
    '时间': 'MOD', '场所': 'MOD', '地点': 'MOD',
    '手段': 'MOD', '方式': 'MOD', '目的': 'MOD', '程度': 'MOD',
    '对比': 'MOD', '伴随': 'MOD', '让步': 'MOD', '转折': 'MOD',
    '连体修饰': 'MOD', '连用修饰': 'MOD', '引用修饰': 'MOD',
    '定语': 'MOD', '状语': 'MOD',
    '方向': 'COMP', '目标': 'COMP', '着落点': 'COMP', '结果': 'COMP',
    '接续': 'MOD',
    '判定': 'PRED', '存在': 'PRED', '动作': 'PRED', '状态': 'PRED'
  };
  const ROLE_COLOR = {
    SUB: '#6366f1', PRED: '#e5484d', OBJ: '#22a06b',
    MOD: '#d98a1f', COMP: '#8b5cf6'
  };
  /* 旧代码里按中文查色，保留一层映射兼容 */
  const ROLE_TO_COLOR = ROLE_COLOR;
  Object.keys(ROLE_TO_CODE).forEach(function (k) {
    if (!ROLE_TO_COLOR[k]) ROLE_TO_COLOR[k] = ROLE_COLOR[ROLE_TO_CODE[k]];
  });
  /* 贴标按钮里提供的可点角色（大类） */
  const ROLES = ['主语', '谓语', '宾语', '修饰语', '补语'];
  /* 细分标签选项（贴标二级选择用）。默认内置 + 可由导入 JSON 的 labels 字段扩展 */
  const LABEL_OPTIONS = {
    SUB: ['主题', '动作主体', '判定主语', '称谓主语', '引用主语', '主体', '（自动）'],
    PRED: ['判定', '存在', '动作', '状态', '（自动）'],
    OBJ: ['对象', '内容', '引用', '（自动）'],
    MOD: ['连体修饰', '连用修饰', '条件', '原因', '理由', '时间', '场所', '手段', '目的', '程度', '对比', '伴随', '让步', '转折', '接续', '引用修饰', '（自动）'],
    COMP: ['方向', '目标', '着落点', '结果', '对象', '（自动）']
  };

  /** 读取当前生效的细分标签：内置 + 导入 JSON 里 labels 扩展 */
  function getLabelOptions() {
    const custom = (Store.getBombLabels && Store.getBombLabels()) || {};
    const out = {};
    ['SUB', 'PRED', 'OBJ', 'MOD', 'COMP'].forEach(function (code) {
      const base = LABEL_OPTIONS[code].slice();
      const extra = Array.isArray(custom[code]) ? custom[code] : [];
      const merged = base.concat(extra.filter(function (x) {
        return x && base.indexOf(x) === -1 && x !== '（自动）';
      }));
      out[code] = merged;
    });
    return out;
  }

  /** 细分标签 → 所属大类；未知标签按 COMP 处理（保证不阻塞） */
  function roleOfLabel(lab) {
    if (!lab) return null;
    const k = String(lab).trim();
    return ROLE_TO_CODE[k] || null;
  }

  /** 把任意 chunk 输入（数组/对象、旧/新字段）归一化为 v2 结构 */
  function normChunk(raw) {
    const c = Array.isArray(raw)
      ? {
        t: raw[0], r: raw[1],
        m: (raw[2] == null) ? null : raw[2],
        x: raw[3] || '', c: raw[4], cl: raw[5] || '',
        acc: Array.isArray(raw[6]) ? raw[6] : []
      }
      : {
        t: raw.t, r: raw.r, m: raw.m == null ? null : raw.m,
        x: raw.x || '', c: raw.c, cl: raw.cl || '',
        acc: Array.isArray(raw.acc) ? raw.acc : []
      };
    c.t = String(c.t == null ? '' : c.t).trim();
    c.r = String(c.r == null ? '' : c.r).trim();
    /* cl 仅作展示细分，绝不回推覆盖 r（判定大类以 r 为准，见 majorCode） */
    if (!c.r && c.cl && roleOfLabel(c.cl)) c.r = c.cl;  /* r 缺失才用 cl 兜底 */
    /* 多解可接受角色：归一化为细分或大类的原样字符串，判定按大类比 */
    c.acc = (Array.isArray(c.acc) ? c.acc : []).map(function (a) {
      return String(a == null ? '' : a).trim();
    }).filter(Boolean);
    /* 递归归一子块 */
    if (Array.isArray(c.c)) c.c = c.c.map(normChunk);
    else c.c = undefined;
    return c;
  }

  /** 角色大类码（供判定/配色），未识别返回 null */
  function codeOf(r) { return roleOfLabel(r); }

  /** 展示标签：优先细分 cl，其次原值 */
  function displayLab(c) { return c.cl || c.r || ''; }

  /** 修饰目标数组化：null→[]，单值→[v]，数组→自身 */
  function targetsOf(m) {
    if (m == null) return [];
    return Array.isArray(m) ? m.slice() : [m];
  }

  /** 展平嵌套 chunk 为顺序数组（深度优先，返回 {flat,parentIdx} 映射） */
  function flattenChunks(chunks) {
    const flat = [];
    (function walk(list, parentPath) {
      list.forEach(function (c, i) {
        const path = parentPath ? parentPath + '.' + i : String(i);
        c.__path = path;
        flat.push(c);
        if (Array.isArray(c.c) && c.c.length) walk(c.c, path);
      });
    })(chunks, '');
    return flat;
  }

  /** 清除 flatten 注入的 __path（避免污染存储） */
  function stripPaths(chunks) {
    chunks.forEach(function (c) {
      delete c.__path;
      if (Array.isArray(c.c)) stripPaths(c.c);
    });
  }

  /* 拆弹句子库 = 用户批量导入的句子（storage.js 的 jp_bombcustom_v1，导入时已归一化）。
   * v5.8 起不再内置句库，window.BOMB_BANK 仅作旧文件残留时的兼容兜底（通常为空）。
   * chunk: t=文本 r=正确角色 m=修饰对象下标(修饰语用) x=判定后讲解
   * 内置句块讲解 x 缺省时由 autoX 按句尾助词生成模板讲解。 */

  /** 自动生成块讲解（真题句库未手写 x 时的兜底）；r 可为细分标签 */
  function autoX(t, r) {
    const end = t.slice(-1);
    const end2 = t.slice(-2);
    const code = codeOf(r) || '';
    const lab = String(r || '');
    /* 细分标签优先给专门讲解 */
    const SUB_LAB = {
      '主题': '「は」提示全句主题，背景已知信息',
      '动作主体': '「が」标记动作/状态的执行主体',
      '判定主语': '「が」标记新信息或判断对象',
      '称谓主语': '作为称谓/呼格的主语',
      '引用主语': '引用小句内部的主语',
      '主体': '动作或状态的主体'
    };
    const MOD_LAB = {
      '条件': '条件小句：假定/既定前提',
      '原因': '原因小句：说明前因',
      '理由': '理由小句：说明依据',
      '时间': '时间状语：说明何时',
      '场所': '场所状语：说明何地',
      '手段': '手段/方式状语',
      '目的': '目的状语',
      '程度': '程度状语',
      '对比': '对比状语',
      '伴随': '伴随状态',
      '让步': '让步小句',
      '转折': '转折小句',
      '接续': '接续成分，承上启下',
      '连体修饰': '定语：修饰后续名词',
      '连用修饰': '状语：修饰后续用言',
      '引用修饰': '引用/内容修饰'
    };
    const COMP_LAB = {
      '方向': '「へ/に」表示动作方向',
      '目标': '「に/を」表示动作目标',
      '着落点': '「に」表示动作着落点',
      '结果': '「に/と」表示变化结果',
      '对象': '补语对象'
    };
    if (code === 'SUB' && SUB_LAB[lab]) return SUB_LAB[lab];
    if (code === 'MOD' && MOD_LAB[lab]) return MOD_LAB[lab];
    if (code === 'COMP' && COMP_LAB[lab]) return COMP_LAB[lab];

    if (code === 'SUB') {
      if (end === 'は') return '「は」提示全句主题';
      if (end === 'が') return '「が」标记动作主体';
      if (end === 'も') return '「も」提示主语，含“也”的语气';
      return '名词化成分作全句主题';
    }
    if (code === 'OBJ') {
      if (end === 'を') return '「を」标记他动词的对象';
      if (end === 'が') return '「が」标记能力/好恶动词的对象';
      return '动作涉及的对象';
    }
    if (code === 'COMP') {
      const MAP = {
        'に': '「に」补充动作的时间、地点、对象或结果',
        'で': '「で」补充动作的场所、手段或状态',
        'と': '「と」引用内容或表示共同动作',
        'から': '「から」表示起点或原因',
        'まで': '「まで」表示终点',
        'へ': '「へ」表示动作方向',
        'より': '「より」表示比较基准'
      };
      return MAP[end] || MAP[end2] || '补充说明动作的相关信息';
    }
    if (code === 'MOD') {
      if (end === 'て' || end === 'で') return '连用形中顿，连接后项动作';
      if (end === 'と') return '「と」连接后项，表示条件或引用';
      if (end === 'ば') return '「ば」表假定条件';
      return '连体/连用修饰：说明后项的属性、状态或条件';
    }
    if (code === 'PRED') return '谓语核心，决定时态、肯否与语气';
    return '';
  }

  /** 把内置紧凑格式 [lv,tag,note,chunks] 归一化；chunk 走 normChunk，支持嵌套与多目标 */
  function normalizeBuiltin(s) {
    return {
      lv: s[0],
      tag: s[1],
      note: s[2] || '',
      chunks: s[3].map(function (c0) {
        const c = normChunk(c0);
        if (!c.x) c.x = autoX(c.t, c.cl || c.r);
        return c;
      })
    };
  }

  /** 全部拆弹句：即用户导入的句子（window.BOMB_BANK 仅为旧内置文件残留时的兜底，正常为空） */
  function allSentences() {
    return (window.BOMB_BANK || []).map(normalizeBuiltin)
      .concat(Store.getBombCustom());
  }

  /* ================= 训练场首页 ================= */

  function renderHub() {
    boss = null; bomb = null;
    const prog = Store.getBossProgress();
    const names = Object.keys(prog);
    const cleared = names.filter(n => prog[n].stars > 0).length;
    const stars = names.reduce((s, n) => s + (prog[n].stars || 0), 0);

    const byRole = {};
    Store.getBombLog().forEach(e => { byRole[e.correct] = (byRole[e.correct] || 0) + 1; });
    const roleRows = Object.keys(byRole).sort((a, b) => byRole[b] - byRole[a]).slice(0, 3)
      .map(r => '<div class="sg-row"><span>常错成 <b>' + esc(r) + '</b> 的成分</span><em>' +
        byRole[r] + ' 次</em></div>').join('');

    B().setHTML(
      '<a class="back-link" href="#/home">‹ 返回</a>' +
      '<header class="page-head"><h1>训练场</h1>' +
      '<div class="sub">Boss 战练语法辨析，拆弹练句子结构</div></header>' +

      '<div class="game-card boss" data-g="go-boss">' +
      '<h3>👾 语法 Boss 战</h3>' +
      '<p>每个语法点一只 Boss：答对掉血，答错回血。<br>已通关 ' + cleared +
      ' 只 · 共攒 ' + stars + ' ★</p></div>' +

      '<div class="game-card bomb" data-g="go-bomb">' +
      '<h3>💣 长难句拆弹</h3>' +
      '<p>把句子切块贴上成分标签，全对才拆弹成功。<br>难度递进：单层修饰 → 嵌套从句 → 省略主语</p></div>' +

      '<div class="weak-hint quiet">薄弱点面板在首页：某考点错满 3 次会自动亮出来</div>' +
      (roleRows ? '<div class="stat-groups"><div class="sg-title">拆弹成分易错统计</div>' +
        roleRows + '</div>' : '')
    );
  }

  /* ================= Boss 战 ================= */

  let boss = null;

  function renderBossList() {
    boss = null;
    const qs = Store.getQuestions();
    const map = {};
    qs.forEach(q => {
      if (!map[q.point]) map[q.point] = { name: q.point, cat: q.category, count: 0 };
      map[q.point].count++;
    });
    const list = Object.values(map).sort((a, b) =>
      a.cat.localeCompare(b.cat, 'zh') || a.name.localeCompare(b.name, 'zh'));
    const prog = Store.getBossProgress();

    const items = list.length ? list.map(b => {
      const st = (prog[b.name] && prog[b.name].stars) || 0;
      return '<div class="boss-item' + (st ? ' cleared' : '') + '" data-g="boss-pick" data-name="' +
        esc(b.name) + '"><div class="bi-info"><div class="bi-name">' + esc(b.name) + '</div>' +
        '<div class="bi-sub">' + esc(b.cat) + ' · ' + b.count + ' 题</div></div>' +
        '<span class="bi-stars">' + '★'.repeat(st) + '<i>' + '☆'.repeat(3 - st) + '</i></span></div>';
    }).join('') :
      '<div class="empty"><span class="e-ico">👾</span>' +
      '<div class="e-txt">还没有题目，无法生成 Boss<br>到「导入」页导入题目后，每个考点会自动成为一个 Boss</div></div>';

    B().setHTML(
      '<a class="back-link" href="#/games">‹ 返回</a>' +
      '<header class="page-head"><h1>选择 Boss</h1>' +
      '<div class="sub">答对掉血 2 格，答错回血 1 格；血空通关，按战绩评星</div></header>' +
      items
    );
  }

  function startBoss(name) {
    const qs = Store.getQuestions().filter(q => q.point === name);
    if (!qs.length) { B().toast('该考点暂无题目'); location.hash = '#/boss'; return; }
    boss = {
      name: name,
      items: shuffle(qs),
      perm: shuffle(['A', 'B', 'C', 'D']),
      idx: 0,
      hp: qs.length * 2, maxHp: qs.length * 2,
      correct: 0, wrong: 0, answered: 0, totalMs: 0,
      chosen: null, qStart: Date.now(), lastHit: ''
    };
    renderBattle();
  }

  function renderBattle() {
    if (!boss) { location.hash = '#/boss'; return; }
    if (boss.hp <= 0) return renderWin();
    if (boss.idx >= boss.items.length) return renderFail();

    const q = boss.items[boss.idx];
    const answered = boss.chosen !== null;
    const ok = answered && boss.chosen === q.answer;
    const pct = Math.round(boss.hp / boss.maxHp * 100);

    const opts = boss.perm.map((k, i) => {
      let cls = 'option';
      let extra = '';
      if (answered) {
        cls += ' locked';
        if (k === q.answer) cls += ' correct';
        else if (k === boss.chosen) cls += ' wrong';
        else cls += ' muted';
      } else {
        extra = ' data-g="boss-answer" data-key="' + k + '"';
      }
      return '<div class="' + cls + '"' + extra + '><span class="opt-key">' +
        String.fromCharCode(65 + i) + '</span><span>' + esc(q.options[k]) + '</span></div>';
    }).join('');

    let bottom = '';
    if (answered) {
      bottom =
        '<div class="explain">' +
        '<div class="ex-result ' + (ok ? 'right' : 'bad') + '">' +
        (ok ? '⚔ 命中！Boss 掉了 2 格血' : '💀 答错了，Boss 回了 1 格血') + '</div>' +
        (q.explanation ? '<div class="ex-body">' + esc(q.explanation) + '</div>' : '') +
        (ok ? '' : '<div class="ex-answer" style="margin-top:6px">稳住：看解析里提到的易混语法，下一发打准它</div>') +
        '</div>' +
        '<button class="btn btn-primary" data-g="boss-next">' +
        (boss.idx >= boss.items.length - 1 ? '最后一击' : '继续进攻') + '</button>';
    }

    B().setHTML(
      '<a class="back-link" href="#/boss">‹ 返回</a>' +
      '<div class="boss-head' + (answered && !ok ? ' shake' : '') + '">' +
      '<div class="boss-name">' + esc(boss.name) + '</div>' +
      '<div class="boss-sub">第 ' + (boss.idx + 1) + ' / ' + boss.items.length +
      ' 问 · 剩余血量 ' + boss.hp + ' / ' + boss.maxHp + '</div>' +
      '<div class="hp-bar' + (boss.lastHit === 'heal' ? ' heal' : '') +
      '"><i style="width:' + pct + '%"></i></div>' +
      '</div>' +
      '<div class="q-panel"><div class="q-stem">' + esc(q.stem) + '</div>' + opts + '</div>' +
      bottom
    );
  }

  function bossAnswer(key) {
    if (!boss || boss.chosen !== null) return;
    const q = boss.items[boss.idx];
    boss.chosen = key;
    boss.answered++;
    boss.totalMs += Date.now() - boss.qStart;
    if (key === q.answer) {
      boss.correct++;
      boss.hp = Math.max(0, boss.hp - 2);
      boss.lastHit = 'hit';
    } else {
      boss.wrong++;
      boss.hp = Math.min(boss.maxHp, boss.hp + 1);
      boss.lastHit = 'heal';
      Store.addWrong(q.id);
    }
    renderBattle();
  }

  function bossNext() {
    if (!boss) return;
    boss.idx++;
    boss.chosen = null;
    boss.perm = shuffle(['A', 'B', 'C', 'D']);
    boss.qStart = Date.now();
    boss.lastHit = '';
    renderBattle();
  }

  function finishBossRecord() {
    const agg = {};
    agg[boss.name] = {
      attempts: boss.answered, wrongs: boss.wrong, timeMs: boss.totalMs
    };
    Store.recordPractice(agg);
  }

  function renderWin() {
    finishBossRecord();
    const qn = boss.items.length;
    const stars = boss.wrong === 0 ? 3 :
      (boss.answered <= Math.round(qn * 1.3) ? 2 : 1);
    const prog = Store.getBossProgress();
    const prev = prog[boss.name] || { stars: 0, tries: 0 };
    prog[boss.name] = { stars: Math.max(prev.stars, stars), tries: prev.tries + 1 };
    Store.saveBossProgress(prog);
    const name = boss.name;

    B().setHTML(
      '<div class="finish-card">' +
      '<div class="f-ico">🏆</div><h2>Boss 讨伐成功！</h2>' +
      '<div class="f-sub">「' + esc(name) + '」血条已清空</div>' +
      '<div class="boss-stars">' +
      '★'.repeat(stars) + '<i>' + '☆'.repeat(3 - stars) + '</i></div>' +
      '<div class="f-detail">' +
      '<div class="row"><span>答对</span><span>' + boss.correct + ' 次</span></div>' +
      '<div class="row"><span>答错</span><span>' + boss.wrong + ' 次</span></div>' +
      '<div class="row"><span>本局用时</span><span>' + Math.round(boss.totalMs / 1000) + ' 秒</span></div>' +
      '<div class="row"><span>错题已收录</span><span>' + boss.wrong + ' 道</span></div>' +
      '</div>' +
      '<div class="btn-row">' +
      '<button class="btn btn-ghost" data-g="boss-again">再战一次</button>' +
      '<a class="btn btn-primary" href="#/boss">换个 Boss</a></div>' +
      '</div>' +
      '<div class="btn-row"><a class="btn btn-ghost" href="#/games">训练场</a>' +
      '<a class="btn btn-ghost" href="#/home">首页</a></div>'
    );
    boss = { name: name };
  }

  function renderFail() {
    finishBossRecord();
    const name = boss.name, hp = boss.hp, maxHp = boss.maxHp;
    B().setHTML(
      '<div class="finish-card">' +
      '<div class="f-ico">😵</div><h2>挑战失败</h2>' +
      '<div class="f-sub">题目答完了，但「' + esc(name) + '」还剩 ' + hp + ' / ' + maxHp + ' 血</div>' +
      '<div class="f-detail">' +
      '<div class="row"><span>答对</span><span>' + boss.correct + ' 次</span></div>' +
      '<div class="row"><span>答错</span><span>' + boss.wrong + ' 次（已全部进错题本）</span></div>' +
      '</div>' +
      '<div class="btn-row">' +
      '<button class="btn btn-primary" data-g="boss-again">再来一次</button>' +
      '<a class="btn btn-ghost" href="#/wrong">去错题本</a></div>' +
      '</div>' +
      '<div class="btn-row"><a class="btn btn-ghost" href="#/boss">换个 Boss</a>' +
      '<a class="btn btn-ghost" href="#/home">首页</a></div>'
    );
    boss = { name: name };
  }

  /* ================= 长难句拆弹 ================= */

  let bomb = null;

  function renderLevelSelect() {
    const all = allSentences();
    const levels = [
      ['1', '入门 · 单层修饰', '一个修饰语 + 主谓宾，找准备语的边界'],
      ['2', '进阶 · 嵌套从句', '小句里套小句，分清大小主语'],
      ['3', '挑战 · 省略主语', '主语藏在空气里，靠谓语倒推']
    ];
    const cards = levels.map(l => {
      const n = all.filter(s => s.lv === Number(l[0])).length;
      return '<div class="game-card lv' + l[0] + '" data-g="bomb-lv" data-lv="' + l[0] + '">' +
        '<h3>难度 ' + l[0] + ' · ' + l[1] + '</h3><p>' + l[2] + ' · ' +
        (n ? '共 ' + n + ' 句' : '未导入句子') + '</p></div>';
    }).join('');

    const byRole = {};
    Store.getBombLog().forEach(e => { byRole[e.correct] = (byRole[e.correct] || 0) + 1; });
    const roleRows = Object.keys(byRole).sort((a, b) => byRole[b] - byRole[a]).slice(0, 4)
      .map(r => '<div class="sg-row"><span>容易错贴成 <b>' + esc(r) + '</b> 的块</span><em>' +
        byRole[r] + ' 次</em></div>').join('');

    B().setHTML(
      '<a class="back-link" href="#/games">‹ 返回</a>' +
      '<header class="page-head"><h1>长难句拆弹</h1>' +
      '<div class="sub">点句子块 → 贴成分标签 → 判定；贴错可反复改</div></header>' +
      (!all.length
        ? '<div class="fmt-hint" style="margin-bottom:12px">还没有任何拆弹句。点下方「批量导入句子」，' +
        '复制提示词发给 AI，把你的日语句子变成训练数据。</div>' : '') +
      cards +
      '<div class="game-card bomb" data-g="bomb-go-import">' +
      '<h3>📥 批量导入句子</h3>' +
      '<p>复制提示词给 AI → 把你的句子变成切块 JSON → 粘贴导入，立刻进入闯关。<br>' +
      '已导入句子 <b>' + Store.getBombCustom().length + '</b> 句</p></div>' +
      '<div class="game-card" data-g="bomb-go-manage" style="--glow:rgba(34,160,107,.14)">' +
      '<h3>🗂️ 管理我的句子</h3>' +
      '<p>查看、删除已导入的句子。</p></div>' +
      (roleRows ? '<div class="stat-groups"><div class="sg-title">你的成分易错统计</div>' +
        roleRows + '</div>' : '')
    );
  }

  function renderBomb(lv) {
    if (lv == null) { bomb = null; renderLevelSelect(); return; }
    if (!bomb || bomb.lv !== lv) {
      bomb = { lv: lv, si: 0, assigns: [], sel: -1, judged: false, wrongs: [], partials: [], recorded: false, startAt: Date.now() };
    }
    renderBombPlay();
  }

  function bombList() { return allSentences().filter(s => s.lv === bomb.lv); }

  /** 判定用：句子的可贴标叶子块（展平后），返回 [{c,path}] */
  function leafChunks(s) {
    const out = [];
    (function walk(list, path) {
      list.forEach(function (c, i) {
        const p = path ? path + '.' + i : String(i);
        if (Array.isArray(c.c) && c.c.length) walk(c.c, p);
        else out.push({ c: c, path: p });
      });
    })(s.chunks, '');
    return out;
  }

  /** 块的大类码：以 r（必为大类）为准，cl 仅展示用；r 缺失时 cl 兜底 */
  function majorCode(c) { return codeOf(c.r) || codeOf(c.cl); }

  /** 构建修饰关系：叶子的 m 指向叶子下标；含子块的父组（如定语从句整体）的 m
   * 同样按叶子下标解释，组源节点键为 'g'+组内首叶子下标（支持多目标）。
   * 返回值：{ leaves, tgtOf:{targetKey:[srcKey,...]}, modsOf:{srcKey:[targetIdx,...]} } */
  function buildModGraph(s) {
    const leaves = leafChunks(s);
    const tgtOf = {}, modsOf = {};
    let n = 0;
    function link(srcKey, c, selfLeaf) {
      if (majorCode(c) !== 'MOD') return;
      targetsOf(c.m).forEach(function (ti) {
        if (ti == null || ti < 0 || ti >= leaves.length || ti === selfLeaf) return;
        (tgtOf[ti] = tgtOf[ti] || []);
        if (tgtOf[ti].indexOf(srcKey) === -1) tgtOf[ti].push(srcKey);
        (modsOf[srcKey] = modsOf[srcKey] || []);
        if (modsOf[srcKey].indexOf(ti) === -1) modsOf[srcKey].push(ti);
      });
    }
    (function walk(list) {
      list.forEach(function (c) {
        if (Array.isArray(c.c) && c.c.length) {
          const gStart = n;            /* 组内首叶子下标，兼作组节点键 */
          walk(c.c);
          link('g' + gStart, c, -1);  /* 父组自身不会等于任一叶下标 */
        } else {
          link(n, c, n);
          n++;
        }
      });
    })(s.chunks);
    return { leaves: leaves, tgtOf: tgtOf, modsOf: modsOf };
  }

  /** 判定后讲解卡：译文 → 整句讲解 → 考研易错点（旧数据仅有 note 也兼容） */
  function sentenceCoachHTML(s) {
    const rows = [];
    if (s.trans) rows.push('<div class="reason-item ok-r">📝 译文：' + esc(s.trans) + '</div>');
    if (s.note) rows.push('<div class="reason-item ok-r">📌 ' + esc(s.note) + '</div>');
    if (s.pitfall) rows.push('<div class="reason-item partial-r">⚠ 易错点：' + esc(s.pitfall) + '</div>');
    return rows.join('');
  }

  /** 拆弹成功后的重组高亮：嵌套树渲染 + 修饰箭头 + 多目标连线 */
  function mergedHTML(s) {
    const g = buildModGraph(s);
    const tgtOf = g.tgtOf;
    let leafSeen = 0;
    /* 递归渲染块树：父块含子块时按 .grp 折叠容器展示 */
    function renderList(list, path, out) {
      list.forEach(function (c, i) {
        const p = path ? path + '.' + i : String(i);
        const col = ROLE_TO_COLOR[c.cl || c.r] || '#999';
        const code = majorCode(c) || '';
        const hasKids = Array.isArray(c.c) && c.c.length;
        if (hasKids) {
          const gKey = 'g' + leafSeen;
          const gMods = g.modsOf[gKey];
          const arrow = gMods
            ? '<span class="mod-arrow" style="color:' + ROLE_TO_COLOR.MOD + '">▸</span>' : '';
          const glab = displayLab(c);
          out.push(arrow);
          out.push(
            '<span class="mc grp' + (gMods ? ' mod' : '') + '" data-path="' + p +
            '" data-gkey="' + gKey + '" data-g="bomb-fold"' +
            (gMods ? ' data-mods="' + gMods.join(',') + '"' : '') +
            ' style="border-color:' + col + '">' +
            '<span class="grp-hd" style="color:' + col + '">' + esc(c.t) +
            (glab ? '<i class="mc-lab">' + esc(glab) + '</i>' : '') +
            '<i class="fold-ic">▾</i></span>' +
            '<span class="grp-bd">'
          );
          renderList(c.c, p, out);
          out.push('</span></span>');
        } else {
          const leafIdx = leafSeen++;
          const arrow = tgtOf[leafIdx]
            ? '<span class="mod-arrow" style="color:' + ROLE_TO_COLOR.MOD + '">▸</span>' : '';
          out.push(arrow);
          const lab = displayLab(c);
          const mods = g.modsOf[leafIdx] ? ' data-mods="' + g.modsOf[leafIdx].join(',') + '"' : '';
          const tgts = (majorCode(c) === 'MOD') ? ' data-tgt="' + leafIdx + '"' : '';
          out.push(
            '<span class="mc leaf' + (code === 'MOD' ? ' mod' : '') + '"' +
            ' data-li="' + leafIdx + '"' + mods + tgts +
            ' style="color:' + col + ';border-bottom-color:' + col + '">' +
            esc(c.t) + (lab ? '<i class="mc-lab">' + esc(lab) + '</i>' : '') +
            '</span>'
          );
        }
      });
    }
    const parts = [];
    renderList(s.chunks, '', parts);
    return '<div class="merged">' + parts.join('') + '</div>' +
      '<div class="legend">▸ 修饰语箭头指向它修饰的块；点击带 ▾ 的块可折叠/展开内部结构；悬停（或轻触）修饰语会同时高亮它修饰的所有目标。<br>主干 = 主语 + 谓语（+ 宾语）</div>' +
      sentenceCoachHTML(s);
  }

  /* ============ 批量导入拆弹句 ============ */

  function renderBombPlay() {
    const list = bombList();
    if (bomb.si >= list.length) {
      /* si=0 且列表空 = 该难度还没导入句子；否则才是真正做完 */
      const empty = bomb.si === 0;
      B().setHTML(
        '<a class="back-link" href="#/bomb">‹ 返回</a>' +
        (empty
          ? '<div class="finish-card"><div class="f-ico">📭</div><h2>难度 ' + bomb.lv + ' 还没有句子</h2>' +
          '<div class="f-sub">复制提示词发给 AI 生成切块 JSON，导入时选这个难度即可</div>' +
          '<div class="btn-row"><a class="btn btn-primary" href="#/bomb-import">去导入句子</a>' +
          '<a class="btn btn-ghost back-link" href="#/bomb">‹ 返回</a></div></div>'
          : '<div class="finish-card"><div class="f-ico">💥</div><h2>本难度拆弹完成！</h2>' +
          '<div class="f-sub">难度 ' + bomb.lv + ' 的句子全部处理完毕</div>' +
          '<div class="btn-row"><a class="btn btn-primary" href="#/bomb">换个难度</a>' +
          '<a class="btn btn-ghost" href="#/games">训练场</a></div></div>')
      );
      return;
    }
    const s = list[bomb.si];
    if (!s) { bomb.si = 0; renderBombPlay(); return; }
    const leaves = leafChunks(s);
    const totalLeaves = leaves.length;
    /* 确保数组长度与叶子块一致，避免旧数据残留 */
    if (bomb.assigns.length !== totalLeaves) {
      bomb.assigns = new Array(totalLeaves).fill('');
    }
    const labeled = bomb.assigns.filter(Boolean).length;
    const done = bomb.judged && bomb.wrongs.length === 0 && !(bomb.partials || []).length;
    /* 折叠状态：键为 path，true=折叠 */
    if (!bomb.fold) bomb.fold = {};

    /* 渲染可贴标的叶子块（嵌套时按层级缩进显示） */
    const chunkHTML = leaves.map(function (L, i) {
      const c = L.c;
      const depth = L.path.split('.').length - 1;
      let cls = 'chunk';
      if (bomb.judged) {
        const jr = judgeChunk(bomb.assigns[i], c);
        cls += jr === 'ok' ? ' ok' : (jr === 'partial' ? ' partial' : ' bad');
      } else if (bomb.sel === i) cls += ' sel';
      const curLab = bomb.assigns[i] || '';
      const curCode = codeOf(curLab) || '';
      const tag = curLab
        ? '<span class="c-tag" style="color:' + (ROLE_TO_COLOR[curCode] || '#666') + '">' + esc(curLab) + '</span>'
        : '<span class="c-tag c-empty">点我贴标签</span>';
      /* 判定后且贴错时显示正解标签提示 */
      const showHint = bomb.judged && c.cl && c.cl !== curLab;
      const hint = showHint ? '<span class="c-hint">正解标签：' + esc(c.cl) + '</span>' : '';
      return '<div class="' + cls + '" data-g="bomb-chunk" data-i="' + i + '" style="margin-left:' + (depth * 18) + 'px">' +
        esc(c.t) + tag + hint + '</div>';
    }).join('');

    /* 大类贴标行 */
    const rolesHTML = '<div class="role-row">' + ROLES.map(function (r) {
      return '<div class="role-chip" data-g="bomb-role" data-r="' + r + '">' +
        '<span class="rc-dot" style="background:' + ROLE_TO_COLOR[r] + '"></span>' + r + '</div>';
    }).join('') + '</div>';

    /* 选中某块后弹出的细分标签选择 */
    let subHTML = '';
    if (bomb.sel >= 0 && !bomb.judged) {
      const curLab = bomb.assigns[bomb.sel] || '';
      const curCode = codeOf(curLab) || '';
      const opts = getLabelOptions();
      if (curCode && opts[curCode]) {
        subHTML = '<div class="sub-row"><span class="sub-t">细分标签（可点）：</span>' +
          opts[curCode].map(function (lab) {
            const on = (lab === '（自动）' && curLab === curCodeToName(curCode)) ||
              (lab === curLab && lab !== '（自动）') ||
              (lab === '（自动）' && !curLab);
            return '<span class="sub-chip' + (on ? ' on' : '') + '" data-g="bomb-lab" data-l="' +
              esc(lab) + '">' + esc(lab) + '</span>';
          }).join('') + '</div>';
      }
    }

    let body;
    if (done) {
      /* 全对，但若有部分正确的块，附上提示 */
      const partialNotes = (bomb.partials || []).map(function (i) {
        const c = leaves[i].c;
        const accTxt = (c.acc || []).join('、');
        return '<div class="reason-item partial-r"><b>' + esc(c.t) + '</b> 你贴「' +
          esc(bomb.assigns[i]) + '」也算通 —— 在部分语法体系里它可归为 ' + esc(accTxt) +
          '；本句更推荐「' + esc(c.cl || c.r) + '」' +
          (c.x ? '<br>' + esc(c.x) : '') + '</div>';
      }).join('');
      body = '<div class="preview-summary">💥 拆弹成功！句子结构如下（点击块可折叠/展开）' +
        (partialNotes ? '<br><span style="color:#c98a2a">含 ' + bomb.partials.length +
          ' 块部分正确，见下方黄色提示</span>' : '') + '</div>' +
        mergedHTML(s) + partialNotes +
        '<button class="btn btn-primary" data-g="bomb-next">下一句</button>';
    } else if (bomb.judged) {
      const reasons = bomb.wrongs.map(function (i) {
        const c = leaves[i].c;
        const rightLab = c.cl || c.r;
        const rightCode = codeOf(rightLab) || '';
        const accTxt = (c.acc && c.acc.length)
          ? '<br><span style="color:#c98a2a">其他可接受：' + esc(c.acc.join('、')) + '</span>' : '';
        return '<div class="reason-item"><b>' + esc(c.t) + '</b> 应作 <b style="color:' +
          (ROLE_TO_COLOR[rightCode] || '#666') + '">' + esc(rightLab) + '</b>' +
          (c.x ? '<br>' + esc(c.x) : '') + accTxt + '</div>';
      }).join('');
      const partials = (bomb.partials || []).map(function (i) {
        const c = leaves[i].c;
        return '<div class="reason-item partial-r"><b>' + esc(c.t) + '</b> 你贴的「' +
          esc(bomb.assigns[i]) + '」部分正确（可接受），但更推荐「' + esc(c.cl || c.r) + '」' +
          (c.x ? '<br>' + esc(c.x) : '') + '</div>';
      }).join('');
      body = '<div class="preview-summary" style="background:' + (bomb.wrongs.length ? 'var(--danger-bg);color:var(--danger)' : 'rgba(217,138,31,.08);color:#8a6210') + '">' +
        (bomb.wrongs.length ? '有 ' + bomb.wrongs.length + ' 块贴错' + (bomb.partials.length ? '、' + bomb.partials.length + ' 块部分正确' : '') :
          '全部贴对 · 其中 ' + bomb.partials.length + ' 块部分正确') +
        ' · 改完再判定，或直接看答案</div>' +
        '<div class="chunk-row">' + chunkHTML + '</div>' + reasons + partials +
        sentenceCoachHTML(s) +
        '<div class="btn-row">' +
        '<button class="btn btn-ghost" data-g="bomb-reveal">直接看答案</button>' +
        '<button class="btn btn-primary" data-g="bomb-retry">重新贴标</button></div>';
    } else {
      body =
        '<div class="fmt-hint" style="margin-bottom:12px">① 点一块句子 ② 点上面的大类标签贴上；' +
        '选中块后还可点下方出现的细分标签精修。贴错了随时重贴，全部贴完点「判定」。' +
        (s.chunks.some(function (c) { return Array.isArray(c.c) && c.c.length; })
          ? '本句含嵌套从句，缩进表示层级。' : '') + '</div>' +
        '<div class="chunk-row">' + chunkHTML + '</div>' +
        rolesHTML + subHTML +
        '<button class="btn btn-primary" data-g="bomb-judge">判定（' + labeled + ' / ' +
        totalLeaves + '）</button>';
    }

    B().setHTML(
      '<a class="back-link" href="#/bomb">‹ 返回</a>' +
      '<div class="quiz-progress-txt"><span>难度 ' + bomb.lv + ' · 第 ' + (bomb.si + 1) +
      ' / ' + list.length + ' 句' +
      ((s.type && s.type.length) ? ' · ' + esc(s.type.join('/')) : '') +
      '</span><span>考点：' + esc(bombTags(s).join('、')) + '</span></div>' +
      body
    );
  }

  function curCodeToName(code) {
    return ({ SUB: '主语', PRED: '谓语', OBJ: '宾语', MOD: '修饰语', COMP: '补语' })[code] || code;
  }

  /** 判定：每块分三档 —— ok 完全正确 / partial 部分正确(可接受答案) / wrong 错误 */
  function judgeChunk(assignLab, c) {
    const chosenCode = codeOf(assignLab);
    /* 正解大类：优先细分 cl；cl 映射不到（如未注册的自定义标签）回退大类 r */
    const rightCode = majorCode(c);
    if (!chosenCode || !rightCode) return 'wrong';
    if (chosenCode === rightCode) return 'ok';
    /* 部分正确：可接受答案数组里含有同大类的 */
    if ((c.acc || []).some(function (a) { return codeOf(a) === chosenCode; })) return 'partial';
    return 'wrong';
  }

  function bombRecord(s, wrongCount, partialCount) {
    /* 一句多考点：每个 tag 都计入练习统计，薄弱点排序更准 */
    const agg = {};
    const timeMs = Date.now() - (bomb.startAt || Date.now());
    bombTags(s).forEach(function (t) {
      agg[t] = { attempts: 1, wrongs: wrongCount ? 1 : 0, timeMs: timeMs };
    });
    Store.recordPractice(agg);
    if (wrongCount) {
      const leaves = leafChunks(s);
      const tagMain = (bombTags(s)[0]) || '';
      Store.addBombLog(bomb.wrongs.map(function (i) {
        const c = leaves[i].c;
        return {
          ts: Date.now(), tag: tagMain, tags: bombTags(s), chunk: c.t,
          chose: bomb.assigns[i] || '', correct: c.cl || c.r, reason: c.x || '',
          sid: s.id || '', partials: partialCount || 0
        };
      }));
    }
  }

  function bombJudge() {
    const s = bombList()[bomb.si];
    const leaves = leafChunks(s);
    if (bomb.assigns.filter(Boolean).length < leaves.length) {
      B().toast('还有句子块没贴标签'); return;
    }
    bomb.wrongs = [];
    bomb.partials = [];
    leaves.forEach(function (L, i) {
      const r = judgeChunk(bomb.assigns[i], L.c);
      if (r === 'wrong') bomb.wrongs.push(i);
      else if (r === 'partial') bomb.partials.push(i);
    });
    bomb.judged = true;
    bomb.sel = -1;
    if (!bomb.recorded) {
      bomb.recorded = true;
      bombRecord(s, bomb.wrongs.length, bomb.partials.length);
    }
    renderBombPlay();
  }

  function bombNext() {
    bomb.si++;
    bomb.assigns = [];
    bomb.sel = -1;
    bomb.judged = false;
    bomb.wrongs = [];
    bomb.partials = [];
    bomb.recorded = false;
    bomb.fold = {};
    bomb.startAt = Date.now();
    renderBombPlay();
  }

  /* ============ 批量导入拆弹句（v3：多解 / 自定义细分标签 / 嵌套） ============ */

  /** 发给 AI 的提示词（一键复制）：把任意日语句子加工成切块 JSON。
   *  字段：lv / type / tag(数组) / trans / note / pitfall / chunks[{t,r,cl,acc,m,x,c}]。
   *  m 按「顶层 chunks 下标」编号；导入校验时自动转换为内部叶子下标（兼容旧数据）。 */
  const BOMB_IMPORT_PROMPT = [
    '你是一名日语语法教学专家，请把我给出的日语句子制作成「考研日语长难句拆弹」训练数据。',
    '',
    '严格输出一个 JSON，不要输出任何解释文字。输出格式二选一：',
    'A. 裸句子数组 [ {...}, {...} ]；',
    'B. 带自定义细分标签的对象 { "labels": { "SUB": ["主题","动作主体"], "MOD": ["条件","原因"] }, "sentences": [ {...} ] }。',
    '',
    '每个句子对象字段：',
    '- lv：难度 1/2/3（简单短句=1，中等=2，含从句/嵌套/省略的长难句=3）',
    '- type：句子类型数组（单句 / 主从句 / 并列句 / 引用句 / 条件句 / 让步句 / 倒装句 / 省略句，可多选）',
    '- tag：语法考点数组，如 ["～ている", "～のではないでしょうか"]（错题按它归类统计，一个句子可标多个考点）',
    '- trans：整句中文翻译（必须准确、通顺，贴近考研翻译风格，直译与意译兼顾）',
    '- note：中文整句讲解，先写主干，再补句意，再点出考研易错点',
    '- pitfall：易错点（中文，说明学生最容易搞错的地方，如“に容易误判为时间，实际是对象”“被动句里 agent 容易被误判为主语”）',
    '- chunks：按语法边界切成的块数组，叶子块拼起来必须等于原句。每块字段：',
    '    t   块的日语原文',
    '    r   成分大类：主语 / 谓语 / 宾语 / 修饰语 / 补语',
    '    cl  细分标签（可选），如 主题、动作主体、条件、原因、引用修饰、连体修饰、状语、对象、时间、场所、手段、范围、被动、使役、授受、可能、敬语 等；填了会覆盖 r 的显示',
    '    acc 可接受的其他答案（可选数组）：当这个块在别的语法体系里也可成立时填，如 ["补语"]；贴了 acc 里的标签判「部分正确」不给红',
    '    m   修饰语用：它修饰的块下标（按顶层 chunks 数组从 0 数，不展开子块；可数组如 [1,3]）',
    '    x   该块讲解（必填）：说明“为什么是X”，以及和近似成分的区别；如果是格助词，要写清是哪种功能',
    '    c   子块数组（可选）：长定语 / 状语 / 引用小句内部再切，形成嵌套',
    '',
    '切分规则：',
    '1. 谓语不限一个，主句 / 从句 / 并列谓语都标「谓语」；',
    '2. は / が → 主语，を → 宾语，に / で / と / から / まで → 补语；定语、状语、条件、原因、引用小句 → 修饰语；',
    '3. 助词和前面名词同块，切在语法边界；',
    '4. 一个成分可能多解时（如「を」既可宾语又可补语），r 填主答案，acc 填备选；',
    '5. x 里务必讲清“为什么是这个成分，而不是另一个”；',
    '6. 按原文顺序处理全部句子，不遗漏；',
    '7. 格助词要细分功能：に（时间 / 场所 / 对象 / 目的 / 被动 agent）、で（场所 / 手段 / 原因 / 范围）、と（引用 / 共同 / 结果）、から（起点 / 原因 / 材料）、まで（终点 / 范围）；',
    '8. 谓语要标语态：被动 / 使役 / 授受 / 可能 / 敬语 / 时态（过去 / 非过去 / 持续）；',
    '9. m 的下标按顶层 chunks 数组从 0 数，不展开子块；如果修饰语修饰的是子块内部成分，在 x 里说明；',
    '10. 每个 chunks 叶子块的 t 拼起来必须等于原句，不能漏词、不能改写；',
    '11. 如果句子含省略（主语省略、助词省略、谓语省略），必须在 note 或 x 里补出省略内容，并标注「省略」；',
    '12. 考研易错点必须写进 pitfall，包括：格助词误判、被动 agent 误判、使役对象误判、授受方向误判、时态误判、修饰语指向误判、省略成分误补。',
    '',
    '示例：',
    '{',
    '  "labels": { "SUB": ["主题", "动作主体"], "MOD": ["条件", "原因"] },',
    '  "sentences": [',
    '    {',
    '      "lv": 2,',
    '      "type": ["单句"],',
    '      "tag": ["～を（对象/起点）"],',
    '      "trans": "我在公园走。",',
    '      "note": "主干：私は公園を歩く。句意：我在公园走。考研易错点：を在此表示移动经过的场所，不是宾语。",',
    '      "pitfall": "「を」容易误判为宾语，实际是移动经过的场所（补语）。",',
    '      "chunks": [',
    '        { "t": "私は", "r": "主语", "cl": "主题", "x": "は提示主题，表示“我”是后面动作的主体" },',
    '        { "t": "公園を", "r": "补语", "acc": ["宾语"], "cl": "场所", "x": "を表移动经过的场所（补语）；部分语法体系归为宾语，故 acc 收「宾语」" },',
    '        { "t": "歩く", "r": "谓语", "cl": "非过去", "x": "自动词作谓语，非过去时表示习惯性动作" }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '',
    '下面是句子，请逐句输出 JSON：',
    '<在这里粘贴你的日语句子>'
  ].join('\n');

  const FMT_BOMB_JSON =
    '粘贴 JSON 数组即可；AI 输出若带 ```json 代码块外壳会自动剔除。\n' +
    '字段：lv(1/2/3)、type(句型数组)、tag(考点数组)、trans(整句翻译)、note(整句讲解)、pitfall(易错点)、' +
    'chunks[{t 文本, r 大类, cl 细分标签, acc 备选答案, m 修饰下标(顶层基准,可数组), x 讲解, c 子块(嵌套)}]。';

  let bombImp = { text: '', preview: null, fatal: '', message: '' };

  /** 递归校验块数组（嵌套），返回 {errors, chunks, leaves} */
  function validateChunkList(rawList, pathLabel, errs) {
    const chunks = [];
    if (!Array.isArray(rawList)) { errs.push(pathLabel + ' 必须是数组'); return chunks; }
    rawList.forEach(function (c0, i) {
      const where = pathLabel + ' 第 ' + (i + 1) + ' 块';
      let c;
      if (Array.isArray(c0)) {
        c = {
          t: c0[0], r: c0[1],
          m: (c0[2] == null) ? null : c0[2],
          x: c0[3] || '', c: c0[4], cl: c0[5] || '',
          acc: Array.isArray(c0[6]) ? c0[6] : []
        };
      } else {
        c = {
          t: c0 ? c0.t : '', r: c0 ? c0.r : '',
          m: (c0 && c0.m != null) ? c0.m : null,
          x: (c0 && c0.x) || '', c: c0 ? c0.c : undefined, cl: (c0 && c0.cl) || '',
          acc: Array.isArray(c0 && c0.acc) ? c0.acc : []
        };
      }
      c.t = String(c.t == null ? '' : c.t).trim();
      c.r = String(c.r == null ? '' : c.r).trim();
      c.cl = String(c.cl == null ? '' : c.cl).trim();
      c.acc = c.acc.map(function (a) { return String(a == null ? '' : a).trim(); }).filter(Boolean);
      /* cl 仅展示，不回推覆盖 r；r 缺失才用 cl 兜底 */
      if (!c.r && c.cl && roleOfLabel(c.cl)) c.r = c.cl;
      if (!c.t && !(Array.isArray(c.c) && c.c.length)) errs.push(where + ' 文本为空');
      if (!codeOf(c.r)) errs.push(where + ' 成分「' + c.r + '」非法');
      /* 递归子块 */
      if (Array.isArray(c.c)) c.c = validateChunkList(c.c, where + ' 内', errs);
      if (!c.x && c.t) c.x = autoX(c.t, c.cl || c.r);
      chunks.push(c);
    });
    return chunks;
  }

  /** 把任意标签字段归一化为字符串数组（兼容数组 / 字符串 / 逗号・顿号分隔） */
  function toStringList(v) {
    let arr;
    if (Array.isArray(v)) arr = v;
    else if (v == null) arr = [];
    else arr = String(v).split(/[、,，\/\s]+/);
    const out = [];
    arr.forEach(function (x) {
      const s = String(x == null ? '' : x).trim();
      if (s && out.indexOf(s) === -1) out.push(s);
    });
    return out;
  }

  /** 句子的考点数组：新数据用 tags，旧数据/内置句回退 tag 单值 */
  function bombTags(s) {
    if (Array.isArray(s.tags) && s.tags.length) return s.tags;
    return s.tag ? [String(s.tag)] : [];
  }

  /**
   * 统一 m 的下标基准。新提示词：m 按顶层 chunks 编号（不展开子块）；
   * 旧数据/内置紧凑格式：m 按展平后的叶子编号。本函数把顶层基准自动转换为叶子基准。
   * 判别：有嵌套且所有 m 值都 < 顶层块数时按顶层基准转换；否则保持叶子基准。
   * 转换规则：目标顶层块若为含子块的组，映射到组内最后一个叶子
   * （日语修饰语在被修饰语之前，被修饰核心位于组尾）。
   */
  function normalizeMIndices(chunks, errs) {
    const topN = chunks.length;
    /* 每个顶层块覆盖的叶子下标区间 [start, end] */
    const ranges = [];
    let cursor = 0;
    chunks.forEach(function (c) {
      let n = 0;
      (function count(list) {
        list.forEach(function (k) {
          if (Array.isArray(k.c) && k.c.length) count(k.c);
          else n++;
        });
      })([c]);
      ranges.push([cursor, cursor + n - 1]);
      cursor += n;
    });
    const leafN = cursor;

    /* 收集所有块（含子块、含父组）的 m 值，并做顶层空间的自指检查 */
    const allVals = [];
    (function walk(list, topIdx) {
      list.forEach(function (c, i) {
        const selfTop = topIdx == null ? i : topIdx;
        targetsOf(c.m).forEach(function (ti) {
          allVals.push(ti);
          if (ti === selfTop) errs.push('第 ' + (selfTop + 1) + ' 块的 m 不能指向自己');
        });
        if (Array.isArray(c.c)) walk(c.c, selfTop);
      });
    })(chunks, null);

    if (topN !== leafN && allVals.length &&
      allVals.every(function (v) { return typeof v === 'number' && v >= 0 && v < topN; })) {
      /* 顶层基准 → 叶子基准 */
      const mapTi = function (ti) {
        if (typeof ti !== 'number' || ti < 0 || ti >= topN) return ti;
        return ranges[ti][1];
      };
      (function walk(list) {
        list.forEach(function (c) {
          if (c.m != null) c.m = Array.isArray(c.m) ? c.m.map(mapTi) : mapTi(c.m);
          if (Array.isArray(c.c)) walk(c.c);
        });
      })(chunks);
    }

    /* 转换后统一做叶子空间越界校验（父组的 m 同样检查） */
    (function walk(list, where) {
      list.forEach(function (c, i) {
        targetsOf(c.m).forEach(function (ti) {
          if (typeof ti !== 'number' || ti < 0 || ti >= leafN) {
            errs.push(where + '第 ' + (i + 1) + ' 块修饰下标 ' + String(ti) +
              ' 越界（共 ' + leafN + ' 个叶子块）');
          }
        });
        if (Array.isArray(c.c)) walk(c.c, where + '第 ' + (i + 1) + ' 块内');
      });
    })(chunks, '外层');
  }

  /** 校验单句（同时接受对象格式与紧凑数组格式 [lv,tag,note,chunks]），返回 {index,valid,errors,data} */
  function validateBombSentence(item, idx) {
    const errors = [];
    let o;
    if (Array.isArray(item)) o = { lv: item[0], tag: item[1], note: item[2], chunks: item[3] };
    else o = item || {};

    const lv = Number(o.lv);
    if (lv !== 1 && lv !== 2 && lv !== 3) errors.push('难度 lv 必须是 1 / 2 / 3');

    /* tag 新格式为考点数组，旧格式字符串仍兼容 */
    const tags = toStringList(o.tags != null ? o.tags : o.tag);
    if (!tags.length) errors.push('缺少考点 tag');

    const type = toStringList(o.type).slice(0, 8);
    const trans = String(o.trans == null ? '' : o.trans).trim();
    const pitfall = String(o.pitfall == null ? '' : o.pitfall).trim();
    const note = String(o.note == null ? '' : o.note);

    if (!Array.isArray(o.chunks) || !o.chunks.length) errors.push('chunks 至少要 1 个块');
    const chunks = Array.isArray(o.chunks) ? validateChunkList(o.chunks, '外层', errors) : [];

    /* m 下标：顶层基准自动转叶子基准，并做越界/自指校验 */
    if (chunks.length) normalizeMIndices(chunks, errors);

    /* 在展平后的叶子块上校验谓语数量 */
    const leaves = [];
    (function walk(list) {
      list.forEach(function (c) {
        if (Array.isArray(c.c) && c.c.length) walk(c.c);
        else leaves.push(c);
      });
    })(chunks);
    if (leaves.length < 2) errors.push('展平后至少要 2 个叶子块');
    const predN = leaves.filter(c => majorCode(c) === 'PRED').length;
    if (predN === 0) errors.push('至少要标出 1 个谓语块');
    stripPaths(chunks);

    return {
      index: idx + 1, valid: errors.length === 0, errors: errors,
      data: {
        lv: lv, tags: tags, tag: tags[0] || '', type: type,
        trans: trans, pitfall: pitfall, note: note, chunks: chunks
      }
    };
  }

  /** 解析粘贴文本：剔除代码块外壳 → JSON.parse → 支持 {labels, sentences} 或裸数组 → 逐句校验 */
  function parseBombImport(text) {
    let raw = text.trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { fatal: 'JSON 解析失败：' + e.message + '（可点上方按钮重新复制提示词）' };
    }
    /* 支持两种顶层格式：裸句子数组，或 { labels: {...}, sentences: [...] } */
    let labels = null, arr;
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && typeof parsed === 'object') {
      if (parsed.labels && typeof parsed.labels === 'object') labels = parsed.labels;
      arr = Array.isArray(parsed.sentences) ? parsed.sentences
        : (Array.isArray(parsed.chunks) ? [parsed] : null);
    }
    if (!Array.isArray(arr)) return { fatal: '顶层必须是 JSON 数组，或含 sentences 数组的对象' };
    return { items: arr.map(validateBombSentence), labels: labels };
  }

  function bombDoParse() {
    const el = document.getElementById('bombImportText');
    bombImp.text = el ? el.value : '';
    bombImp.message = '';
    bombImp.fatal = '';
    if (!bombImp.text.trim()) { B().toast('请先粘贴 JSON 文本'); return; }
    const r = parseBombImport(bombImp.text);
    if (r.fatal) { bombImp.fatal = r.fatal; bombImp.preview = null; bombImp.labels = null; }
    else { bombImp.preview = r.items; bombImp.labels = r.labels; }
    renderBombImport();
  }

  function bombDoConfirm() {
    const valid = bombImp.preview.filter(p => p.valid).map(p => ({
      id: Store.uid('b'),
      lv: p.data.lv, tags: p.data.tags, tag: p.data.tag, type: p.data.type,
      trans: p.data.trans, pitfall: p.data.pitfall, note: p.data.note, chunks: p.data.chunks
    }));
    if (!valid.length) { B().toast('没有可导入的有效句子'); return; }
    const r = Store.addBombCustom(valid);
    /* 合并自定义细分标签 */
    let labMsg = '';
    if (bombImp.labels && Store.mergeBombLabels) {
      const n = Store.mergeBombLabels(bombImp.labels);
      if (n) labMsg = '；新增细分标签 ' + n + ' 个';
    }
    bombImp.message = '导入成功：新增 ' + r.added + ' 句' +
      (r.dup ? '，跳过重复 ' + r.dup + ' 句' : '') + labMsg +
      '；句库共 ' + r.total + ' 句，已可在难度 ' +
      Array.from(new Set(valid.map(v => v.lv))).sort().join(' / ') + ' 中闯关';
    bombImp.text = '';
    bombImp.preview = null;
    bombImp.labels = null;
    renderBombImport();
  }

  function bombImportPreviewHTML() {
    const preview = bombImp.preview;
    const valid = preview.filter(p => p.valid);
    const invalid = preview.filter(p => !p.valid);
    const items = preview.map(p => {
      const d = p.data;
      const tags = (d.tags && d.tags.length ? d.tags : []).map(esc).join('、');
      const typeTxt = (d.type && d.type.length) ? ' · ' + d.type.map(esc).join('/') : '';
      return '<div class="preview-item' + (p.valid ? '' : ' invalid') + '">' +
        '<div class="pi-title">第' + p.index + '句 · 难度 ' +
        (isNaN(d.lv) ? '?' : d.lv) + typeTxt + ' · ' + (tags || '(无考点)') + '</div>' +
        '<div class="pi-line">' +
        (d.chunks && d.chunks.length ? esc(d.chunks.map(c => c.t).join('')) : '(无切块)') +
        '</div>' +
        (d.trans ? '<div class="pi-opt">📝 ' + esc(d.trans) + '</div>' : '') +
        (d.note ? '<div class="pi-opt">📌 ' + esc(d.note) + '</div>' : '') +
        (d.pitfall ? '<div class="pi-opt" style="color:#b4541a">⚠ ' + esc(d.pitfall) + '</div>' : '') +
        (p.valid ? '' : '<div class="pi-err">⚠ ' + p.errors.map(esc).join('；') + '</div>') +
        '</div>';
    }).join('');

    return '<div class="preview-summary">共解析出 ' + preview.length + ' 句：有效 ' +
      valid.length + ' 句' + (invalid.length ? '，无效 ' + invalid.length + ' 句' : '') + '</div>' +
      items +
      (valid.length
        ? '<button class="btn btn-primary" data-g="bomb-confirm">确认导入 ' +
        valid.length + ' 句有效数据</button>'
        : '<button class="btn btn-primary" disabled>没有可导入的有效句子</button>');
  }

  function renderBombImport() {
    boss = null; bomb = null;
    B().setHTML(
      '<a class="back-link" href="#/bomb">‹ 返回</a>' +
      '<header class="page-head"><h1>批量导入拆弹句</h1>' +
      '<div class="sub">复制提示词 → 发给 AI → 粘贴生成的 JSON → 解析导入</div></header>' +
      (bombImp.message
        ? '<div class="import-success">' + esc(bombImp.message) + '</div>' : '') +
      '<button class="btn btn-ghost" data-g="bomb-copy-prompt" style="margin-bottom:12px">' +
      '📋 复制 AI 提示词（含格式与示例）</button>' +
      '<div class="import-card"><label>句子 JSON</label>' +
      '<textarea id="bombImportText" placeholder="在此粘贴 AI 生成的 JSON 数组…">' +
      esc(bombImp.text) + '</textarea>' +
      '<div class="fmt-hint">' + FMT_BOMB_JSON + '</div></div>' +
      '<button class="btn btn-primary" data-g="bomb-parse" style="margin-bottom:12px">解析并预览</button>' +
      (bombImp.fatal
        ? '<div class="preview-item invalid"><div class="pi-err">⚠ ' + esc(bombImp.fatal) +
        '</div></div>' : '') +
      (bombImp.preview ? bombImportPreviewHTML() : '')
    );
  }

  /** 独立管理页：按难度分组展示自定义句，删除/清空 */
  function renderBombManage() {
    boss = null; bomb = null;
    const list = Store.getBombCustom();
    let body;
    if (!list.length) {
      body = '<div class="empty"><span class="e-ico">📥</span>' +
        '<div class="e-txt">还没有导入句子<br>到「批量导入句子」复制提示词给 AI 生成</div></div>';
    } else {
      const groups = [1, 2, 3].map(function (lv) {
        const items = list.filter(function (s) { return s.lv === lv; });
        if (!items.length) return '';
        return '<div class="sg-title">难度 ' + lv + '（' + items.length + ' 句）</div>' +
          items.map(function (s) {
            const full = s.chunks.map(function (c) { return c.t; }).join('');
            return '<div class="manage-item"><div class="mi-info">' +
              '<div class="mi-name">' + esc(bombTags(s).join('、')) + '</div>' +
              '<div class="mi-sub">' + esc(full.slice(0, 40)) + (full.length > 40 ? '…' : '') + '</div></div>' +
              '<div class="mi-btns"><button class="btn-mini danger" data-g="bomb-custom-del" data-id="' +
              esc(s.id) + '">删除</button></div></div>';
          }).join('');
      }).join('');
      body = '<div class="fmt-hint" style="margin-bottom:12px">句库共 ' + list.length +
        ' 句。</div>' + groups +
        '<button class="btn btn-ghost" data-g="bomb-custom-clear" style="margin-top:10px">清空全部句子</button>';
    }
    B().setHTML(
      '<a class="back-link" href="#/bomb">‹ 返回</a>' +
      '<header class="page-head"><h1>管理我的句子</h1>' +
      '<div class="sub">查看、删除已导入的句子</div></header>' +
      (bombImp.message ? '<div class="import-success">' + esc(bombImp.message) + '</div>' : '') +
      body
    );
  }

  /* ================= 事件委托 ================= */

  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-g]');
    if (!el) return;
    const g = el.dataset.g;

    switch (g) {
      case 'go-boss': location.hash = '#/boss'; break;
      case 'go-bomb': location.hash = '#/bomb'; break;
      case 'bomb-go-import': location.hash = '#/bomb-import'; break;
      case 'bomb-go-manage': location.hash = '#/bomb-manage'; break;
      case 'boss-pick': location.hash = '#/boss/' + encodeURIComponent(el.dataset.name); break;
      case 'boss-answer': bossAnswer(el.dataset.key); break;
      case 'boss-next': bossNext(); break;
      case 'boss-again': startBoss(boss ? boss.name : ''); break;
      case 'bomb-lv': location.hash = '#/bomb/' + el.dataset.lv; break;
      case 'bomb-chunk':
        bomb.sel = Number(el.dataset.i);
        if (bomb.judged) { bomb.judged = false; bomb.wrongs = []; bomb.partials = []; }
        renderBombPlay();
        break;
      case 'bomb-role':
        if (bomb.sel < 0) { B().toast('先点一块句子'); return; }
        bomb.assigns[bomb.sel] = el.dataset.r;
        renderBombPlay();
        break;
      case 'bomb-lab': {
        if (bomb.sel < 0) { B().toast('先点一块句子'); return; }
        const lab = el.dataset.l;
        if (lab === '（自动）') {
          /* 回退到大类名 */
          const cur = bomb.assigns[bomb.sel] || '';
          const cc = codeOf(cur) || '';
          bomb.assigns[bomb.sel] = cc ? curCodeToName(cc) : '';
        } else {
          bomb.assigns[bomb.sel] = lab;
        }
        renderBombPlay();
        break;
      }
      case 'bomb-fold': {
        /* 折叠/展开嵌套块：根据点击的 path 切换 .grp 的折叠态（直接操作 DOM，不重渲染） */
        const grp = el.closest('.grp');
        if (grp) grp.classList.toggle('closed');
        break;
      }
      case 'bomb-judge': bombJudge(); break;
      case 'bomb-retry':
        bomb.judged = false; bomb.wrongs = []; bomb.partials = [];
        renderBombPlay();
        break;
      case 'bomb-reveal':
        /* 直接看答案：强制全对状态并展示重组 */
        {
          const s0 = bombList()[bomb.si];
          if (s0) {
            bomb.assigns = leafChunks(s0).map(function (L) { return L.c.cl || L.c.r; });
          }
          bomb.wrongs = [];
          bomb.partials = [];
          bomb.judged = true;
          bomb.sel = -1;
        }
        renderBombPlay();
        break;
      case 'bomb-next': bombNext(); break;

      case 'bomb-copy-prompt':
        B().copyText(BOMB_IMPORT_PROMPT).then(
          function () { B().toast('提示词已复制，粘贴给 AI 即可'); },
          function () { B().toast('复制失败，请长按文本手动复制'); }
        );
        break;
      case 'bomb-parse': bombDoParse(); break;
      case 'bomb-confirm': bombDoConfirm(); break;
      case 'bomb-custom-del':
        if (confirm('确定删除这句？')) {
          const left = Store.deleteBombCustom(el.dataset.id);
          bombImp.message = '已删除，句库剩余 ' + left + ' 句';
          renderBombManage();
        }
        break;
      case 'bomb-custom-clear':
        if (confirm('确定清空全部已导入的句子？此操作不可恢复。')) {
          Store.clearBombCustom();
          bombImp.message = '已清空全部句子';
          renderBombManage();
        }
        break;
    }
  });

  /* ---------- 悬停/触摸 高亮修饰多目标（仅判定成功页生效） ---------- */
  function clearModHi(root) {
    (root || document).querySelectorAll('.mc.hl-src,.mc.hl-tgt').forEach(function (n) {
      n.classList.remove('hl-src', 'hl-tgt');
    });
  }
  function hiModTargets(srcEl) {
    const root = srcEl.closest('.merged');
    if (!root) return;
    clearModHi(root);
    const mods = (srcEl.dataset.mods || '').split(',').filter(function (x) { return x !== ''; });
    if (!mods.length) return;
    srcEl.classList.add('hl-src');
    mods.forEach(function (key) {
      /* 组节点键以 g 开头（如 g2），其余为叶子下标 */
      const sel = key.charAt(0) === 'g'
        ? '.mc[data-gkey="' + key + '"]'
        : '.mc[data-li="' + key + '"]';
      const t = root.querySelector(sel);
      if (t) t.classList.add('hl-tgt');
    });
  }
  document.addEventListener('mouseover', function (e) {
    const src = e.target.closest && e.target.closest('.mc.mod[data-mods]');
    if (src) hiModTargets(src);
  });
  document.addEventListener('touchstart', function (e) {
    const src = e.target.closest && e.target.closest('.mc.mod[data-mods]');
    if (src) hiModTargets(src);
  }, { passive: true });
  document.addEventListener('mouseout', function (e) {
    if (e.target.closest && e.target.closest('.mc.mod[data-mods]')) {
      const root = e.target.closest('.merged');
      if (root) clearModHi(root);
    }
  });

  /* ---------- 对外接口（app.js 路由调用） ---------- */
  window.GamesPage = {
    renderHub: renderHub,
    renderBossList: renderBossList,
    startBoss: startBoss,
    renderBomb: renderBomb,
    renderBombImport: renderBombImport,
    renderBombManage: renderBombManage
  };
})();
