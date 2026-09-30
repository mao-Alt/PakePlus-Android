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

  /**
   * 考点名称 → 正则数组
   * 「～／〜」首尾是装饰，中间是通配；「（）」可选；「・／」多变体
   * 例：～際（は） → /際(?:は)?/ ；～さえ～ば → /さえ.{0,10}?ば/
   */
  function variantsOf(name) {
    return String(name).split(/[・／]/).map(function (v) {
      const s = v.trim().replace(/^[〜～]+/, '').replace(/[〜～]+$/, '');
      if (!s) return null;
      let re = '', core = '', buf = '';
      const optionals = [];
      const flush = function () {
        if (buf) { re += escRe(buf); core += buf; buf = ''; }
      };
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '（' || ch === '(') {
          const close = s.indexOf(ch === '（' ? '）' : ')', i);
          if (close > i) {
            flush();
            const inner = s.slice(i + 1, close);
            re += '(?:' + escRe(inner) + ')?';
            optionals.push(inner);
            i = close + 1;
            continue;
          }
        }
        if (ch === '～' || ch === '〜') { flush(); re += '.{0,10}?'; i++; continue; }
        buf += ch; i++;
      }
      flush();
      if (core.length < 2) {
        // 核心太短易误报（如 ～上（で）），把可选部分并入必选再试
        if (optionals.length) {
          const merged = core + optionals.join('');
          if (merged.length >= 2) {
            try { return new RegExp(escRe(merged), 'g'); } catch (e) { return null; }
          }
        }
        return null;
      }
      try { return new RegExp(re, 'g'); } catch (e) { return null; }
    }).filter(Boolean);
  }

  /** 扫描文章，返回 { hits:[{start,end,surface,card,extra}], points:[...] } */
  function analyze(text) {
    const cards = Store.getCards();
    const matchers = [];
    cards.forEach(function (c) {
      variantsOf(c.name).forEach(function (re) { matchers.push({ card: c, re: re }); });
    });
    EXTRA_GRAMMAR.forEach(function (x) {
      if (cards.some(function (c) { return c.name === x.name; })) return;
      try { matchers.push({ extra: x, re: new RegExp(x.re, 'g') }); } catch (e) { }
    });

    const hits = [];
    matchers.forEach(function (m) {
      m.re.lastIndex = 0;
      let mt;
      while ((mt = m.re.exec(text))) {
        if (!mt[0]) { m.re.lastIndex++; continue; }
        hits.push({
          start: mt.index, end: mt.index + mt[0].length, surface: mt[0],
          card: m.card || null, extra: m.extra || null
        });
        if (m.re.lastIndex === mt.index) m.re.lastIndex++;
      }
    });

    /* 去重叠：按起点排序，同起点取最长，跳过与已接受区间重叠的 */
    hits.sort(function (a, b) {
      return a.start - b.start || (b.end - b.start) - (a.end - a.start);
    });
    const accepted = [];
    let lastEnd = -1;
    hits.forEach(function (h) {
      if (h.start >= lastEnd) { accepted.push(h); lastEnd = h.end; }
    });

    /* 汇总语法点（按出现次数降序） */
    const pmap = {};
    accepted.forEach(function (h) {
      const name = h.card ? h.card.name : h.extra.name;
      if (!pmap[name]) {
        pmap[name] = {
          name: name, card: h.card, extra: h.extra,
          isNew: !h.card, count: 0, surfaces: []
        };
      }
      pmap[name].count++;
      if (pmap[name].surfaces.indexOf(h.surface) === -1) pmap[name].surfaces.push(h.surface);
    });
    const points = Object.keys(pmap).map(function (k) { return pmap[k]; })
      .sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); });

    return { hits: accepted, points: points };
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
      return '<div class="art-item" data-art="open" data-id="' + a.id + '">' +
        '<div class="ai-main">' +
        '<div class="ai-title">' + B.esc(a.title) + '</div>' +
        '<div class="ai-meta">' +
        '<span>' + fmtDate(a.createdAt) + '</span>' +
        '<span class="badge ' + DIFF_BADGE[a.difficulty] + '">' + B.esc(a.difficulty) + '</span>' +
        '<span class="badge todo">' + a.pointCount + ' 个语法点</span>' +
        (a.newCount ? '<span class="badge new-pt">新 ' + a.newCount + '</span>' : '') +
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
      '<a class="back-link" href="#/articles">‹ 返回文章列表</a>' +
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
        '<a class="btn btn-primary" href="#/articles">返回文章列表</a></div>');
      return;
    }
    if (!current || !current.article || current.article.id !== id) {
      detailTab = 'points';
      aiText = '';
      aiPreview = null;
    }
    closePop();
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
        body =
          '<div class="pt-sec-t">📌 摘要</div><div class="pt-sec-b">' + B.esc(c.summary || '暂无') + '</div>' +
          (c.lecture ? '<div class="pt-sec-t">📖 讲解</div><div class="pt-sec-b">' + B.esc(c.lecture) + '</div>' : '') +
          (c.examples && c.examples.length ?
            '<div class="pt-sec-t">💬 例句</div>' +
            c.examples.slice(0, 2).map(function (ex) {
              return '<div class="example-item"><div class="ex-jp">' + B.esc(ex.jp) +
                '</div><div class="ex-cn">' + B.esc(ex.cn) + '</div></div>';
            }).join('') : '') +
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
      '<a class="back-link" href="#/articles">‹ 返回文章列表</a>' +
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
    const r = Store.upsertCards([{
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
    renderDetail: renderDetail
  };
})();
