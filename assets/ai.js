/**
 * assets/ai.js —— AI 能力层（A 拥有）
 * 走 WorkBuddy 云服务免密钥通道：前端没有任何模型密钥。
 *
 * 对外契约（B/C 只调这些）：
 *   LF.ai.describeImage(dataURL)                       -> {desc, tags[], ok}
 *   LF.ai.expandQuery(text)                            -> {keywords[]}
 *   LF.ai.makeQuestion(item)                           -> {question, ok}
 *   LF.ai.judgeAnswer(item, question, answer, img?)    -> {pass, reason, ok}
 *
 * 设计要点：
 * 1. SDK 强制 stream:true，且 messages[0] 必须是 system 消息；
 * 2. 同一浏览器 60 秒内限流（config.ai.limitPerMinute），超限自动降级到本地规则；
 * 3. 任何一次 AI 失败都不阻断业务流程，一律回退本地算法并 toast 提示。
 */
(function () {
  'use strict';
  LF.ai = {};

  var AI = LF.config.ai;

  /* ---------------- 限流 ---------------- */
  var STAMP_KEY = 'lf_ai_stamps';

  function throttleOk() {
    var now = Date.now();
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem(STAMP_KEY) || '[]'); } catch (e) { arr = []; }
    arr = arr.filter(function (t) { return now - t < 60000; });
    if (arr.length >= AI.limitPerMinute) {
      localStorage.setItem(STAMP_KEY, JSON.stringify(arr));
      return false;
    }
    arr.push(now);
    localStorage.setItem(STAMP_KEY, JSON.stringify(arr));
    return true;
  }

  /* ---------------- 底层调用 ---------------- */
  var busyCount = 0;
  LF.ai.busy = function () { return busyCount > 0; };

  /**
   * 单次流式调用，返回完整文本
   * opts: { model, system, user, image, json, temperature }
   */
  async function callLLM(opts) {
    if (!throttleOk()) {
      var err = new Error('AI 调用过于频繁，请稍后再试');
      err.code = 'local_throttle';
      throw err;
    }
    var userContent;
    if (opts.image) {
      userContent = [
        { type: 'text', text: opts.user },
        { type: 'image_url', image_url: { url: opts.image } }
      ];
    } else {
      userContent = opts.user;
    }

    var body = {
      model: opts.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: userContent }
      ],
      stream: true,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, AI.timeoutMs);
    body.signal = controller.signal;

    var text = '';
    var reasoning = '';
    busyCount++;
    try {
      var cloud = LF.api.getCloud();
      for await (var chunk of cloud.llm.chat.completions.create(body)) {
        var delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (!delta) continue;
        if (delta.content) text += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
      }
    } finally {
      busyCount--;
      clearTimeout(timer);
    }
    // 部分思考模型把答案放在 reasoning_content 里，双通道兜底
    return (text || reasoning || '').trim();
  }

  /** 从模型输出里抠 JSON（容忍 ```json 包裹、前后废话、多个花括号） */
  function parseJSON(raw) {
    if (!raw) return null;
    var s = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();

    // 先按最外层括号直接试
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { /* 继续找平衡括号 */ }
    }
    // 再按括号配对找第一个完整对象
    for (var i = 0; i < s.length; i++) {
      if (s[i] !== '{') continue;
      var depth = 0, inStr = false, esc = false;
      for (var j = i; j < s.length; j++) {
        var ch = s[j];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(s.slice(i, j + 1)); } catch (e2) { break; }
          }
        }
      }
    }
    return null;
  }

  function failed(e) {
    if (e && e.code === 'local_throttle') return 'local_throttle';
    if (e && e.name === 'AbortError') return 'timeout';
    console.warn('[ai] call failed', e && (e.code || e.message));
    return 'error';
  }

  function notifyFallback(reason) {
    if (typeof LF.ui !== 'undefined' && LF.ui.toast) {
      var msg = reason === 'local_throttle'
        ? 'AI 调用太频繁，本次使用本地规则'
        : 'AI 暂不可用，已使用本地规则';
      LF.ui.toast(msg, 'info', 2200);
    }
  }

  /* ---------------- 视觉打标签 ---------------- */
  LF.ai.describeImage = async function (dataURL) {
    if (!dataURL) return { desc: '', tags: [], ok: false };
    try {
      var raw = await callLLM({
        model: LF.config.models.vision,
        system: '你是失物招领系统的图像标注助手。只输出 JSON，不解释、不寒暄。',
        user: '描述这张图片里的物品，用于失物检索。输出 JSON：' +
          '{"desc":"30-80 字中文描述，含品类、主色、材质、品牌标识、显著特征（磨损/贴纸/挂件/破损/图案）",' +
          '"tags":["3-6 个中文关键词"]}。只写看得见的特征，不确定的不要编造。',
        image: dataURL,
        json: true,
        temperature: 0.3
      });
      var obj = parseJSON(raw);
      if (!obj || !obj.desc) throw new Error('bad json');
      var tags = Array.isArray(obj.tags) ? obj.tags.slice(0, 8) : [];
      return { desc: String(obj.desc).slice(0, 200), tags: tags, ok: true };
    } catch (e) {
      failed(e);
      return { desc: '', tags: [], ok: false };
    }
  };

  /* ---------------- 检索词扩展 ---------------- */
  LF.ai.expandQuery = async function (text) {
    if (!text) return { keywords: [], ok: false };
    try {
      var raw = await callLLM({
        model: LF.config.models.text,
        system: '你是中文检索词扩展助手。只输出 JSON。',
        user: '用户要找的物品描述：「' + String(text).slice(0, 200) + '」。' +
          '输出 JSON：{"keywords":["4-8 个与原意相关的中文词，含同义词、别称、上位词、颜色材质词"]}。' +
          '不要输出无关词，不要重复原句。',
        json: true,
        temperature: 0.2
      });
      var obj = parseJSON(raw);
      var kws = obj && Array.isArray(obj.keywords) ? obj.keywords.filter(Boolean).slice(0, 8) : [];
      return { keywords: kws, ok: kws.length > 0 };
    } catch (e) {
      failed(e);
      return { keywords: [], ok: false };
    }
  };

  /* ---------------- 出题 ---------------- */
  // 本地兜底：从细节里挑一个关键词做模糊提问
  function localQuestion(item) {
    var detail = item.detail || '';
    var keys = ['贴纸', '图案', '颜色', '品牌', '标记', '破损', '挂件', '胶带', '名字', '标签', '座位', '刻字'];
    for (var i = 0; i < keys.length; i++) {
      var idx = detail.indexOf(keys[i]);
      if (idx >= 0) {
        return '这件「' + item.title + '」上，' + keys[i] + '相关的部分是什么样的？';
      }
    }
    return '请描述一下这件「' + item.title + '」的独有特征（颜色、标记、破损处等）？';
  }

  LF.ai.makeQuestion = async function (item) {
    var detail = (item.detail || '').slice(0, 400);
    if (!detail) return { question: localQuestion(item), ok: false };
    try {
      var raw = await callLLM({
        model: LF.config.models.text,
        system: '你是失物认领的核验员。只输出 JSON。绝不能把失主写的细节原句照抄给认领者，也绝不能出是非题、选择题。',
        user: '失物名称：' + item.title + '\n失主填写的隐藏细节：' + detail + '\n' +
          '请生成一个只有真正失主才答得上来的核实问题。要求：' +
          '1) 必须是开放式提问，让回答者去「描述」细节（是什么样的／具体在哪里／上面写了什么内容），' +
          '绝不能出是非题或选择题（是不是／有没有／能不能／可不可以／A还是B）——' +
          '这类题只有两个答案，冒领者三次机会里猜两次就能命中，等于没有核验；' +
          '2) 隐藏细节里如果有「二值型」特征（比如"衣服可以脱下来""有没有划痕"这种答案只有是与非的），' +
          '不要直接问这个属性本身，改问它的具体展开（如脱下来的是什么衣服、有哪些配件、划痕具体在哪个位置什么样），' +
          '或换用细节里其他开放特征；' +
          '3) 指向细节里的某个具体特征，但用模糊说法，不直接说出答案，也不给出候选答案；' +
          '4) 只能问隐藏细节里明确写了的特征——细节里没写的一律不能问，不要自己臆测缝线、内衬、粘扣、内部结构这类登记人没提供的特征；' +
          '5) 一句话，口语化，不超过 40 字。' +
          '输出 JSON：{"question":"..."}',
        json: true,
        temperature: 0.8
      });
      var obj = parseJSON(raw);
      if (!obj || !obj.question) throw new Error('bad json');
      var question = String(obj.question).slice(0, 120);
      // 硬过滤：题目里出现细节片段 → 题目本身在泄题，退回本地模板题
      if (leaksSecret(question, secretGrams(item))) {
        return { question: localQuestion(item), ok: false };
      }
      return { question: question, ok: true };
    } catch (e) {
      notifyFallback(failed(e));
      return { question: localQuestion(item), ok: false };
    }
  };

  /* ---------------- 判答 ---------------- */
  function ngrams(text, n) {
    n = n || 2;
    var t = String(text || '').toLowerCase().replace(/[\s，。,.!?！？、；;：:"'（）()【】\[\]]/g, '');
    var set = new Set();
    if (t.length < n) { if (t) set.add(t); return set; }
    for (var i = 0; i <= t.length - n; i++) set.add(t.slice(i, i + n));
    return set;
  }

  function dice(a, b) {
    var A = ngrams(a), B = ngrams(b);
    if (!A.size || !B.size) return 0;
    var inter = 0;
    A.forEach(function (x) { if (B.has(x)) inter++; });
    return (2 * inter) / (A.size + B.size);
  }

  function localJudge(item, answer) {
    var sim = dice(answer, item.detail || '');
    return {
      pass: sim >= 0.18,
      reason: sim >= 0.18 ? '特征描述与细节吻合' : '回答里没有出现可核实的特征',
      ok: false
    };
  }

  /* ---------------- 细节泄漏防线 ----------------
   * 核验的目的是防冒领：任何返回给认领者的文字（问题、拒绝理由）里
   * 都不允许出现隐藏细节的片段，否则 AI 会把答案"说"给冒领者。
   * 做法：把细节切成 2 字滑窗（剔除公开信息里也有的词），只要出现在
   * 返回文本里就判定泄漏，整体替换成无信息量的话术。
   */
  function secretGrams(item) {
    var pub = ((item.title || '') + (item.notice || '')).toLowerCase();
    var segs = String(item.detail || '').split(/[，。,.、；;：:！!？?\s（）()「」『』·\-—_/\\]+/);
    var grams = [];
    segs.forEach(function (s) {
      if (s.length < 2) return;
      for (var j = 0; j + 2 <= s.length; j++) {
        var g = s.slice(j, j + 2).toLowerCase();
        if (pub.indexOf(g) >= 0) continue;   // 标题/公开说明里也有 → 不算机密
        if (grams.indexOf(g) < 0) grams.push(g);
      }
    });
    return grams;
  }

  function leaksSecret(text, grams) {
    text = String(text || '').toLowerCase();
    if (!text) return false;
    for (var i = 0; i < grams.length; i++) {
      if (text.indexOf(grams[i]) >= 0) return true;
    }
    return false;
  }

  LF.ai.judgeAnswer = async function (item, question, answer, answerImage) {
    var detail = (item.detail || '').slice(0, 400);
    if (!detail || !answer) return localJudge(item, answer || '');
    var grams = secretGrams(item);
    var prompt = '失物名称：' + item.title + '\n' +
      '失主填写的隐藏细节：' + detail + '\n' +
      '刚才的提问：' + question + '\n' +
      '认领者的回答：' + String(answer).slice(0, 300) + '\n' +
      (answerImage ? '（认领者还上传了一张照片，请看图判断是否与描述相符）\n' : '') +
      '请判断回答是否与隐藏细节中的关键特征吻合。判断只以隐藏细节为依据：' +
      '细节里明确写了的特征，回答吻合就算通过——不许因为「照片里本来拍得到」而否决，登记人把它设为细节，它就是核验依据；' +
      '细节里没写的特征，回答说得再具体也不能作为通过依据（你无从核实真伪），也不要围绕它追问；' +
      '回答必须「描述」出具体内容才算通过；' +
      '如果回答只是答对了一个是非题级别的属性（能不能／是不是／有没有，哪怕答对了），' +
      '那只是猜中了一个二选一，不能算通过，一律按未通过处理并要求给出具体描述；' +
      '允许表达不同但意思一致；含糊、绕开、只复述问题、只讲礼貌话的一律不通过。' +
      '⚠️ 保密要求：reason 只能说明不通过的方面（如"颜色不符""细节不足""未答出关键特征"），' +
      '绝对不能出现隐藏细节中的任何词、正确答案或示例，否则就是泄题。' +
      '输出 JSON：{"pass":true 或 false,"reason":"20 字内中文说明"}';
    try {
      var raw = await callLLM({
        model: LF.config.models.vision,
        system: '你是失物认领核验员，严格但不刁难。只输出 JSON。reason 里绝不能泄露正确答案。',
        user: prompt,
        image: answerImage || null,
        json: true,
        temperature: 0.2
      });
      var obj = parseJSON(raw);
      if (!obj || typeof obj.pass !== 'boolean') throw new Error('bad json');
      var reason = String(obj.reason || '').slice(0, 60);
      // 硬过滤：理由里出现细节片段 → 整体替换，绝不把答案带给冒领者
      if (leaksSecret(reason, grams)) {
        reason = obj.pass ? '特征吻合' : '回答与隐藏细节不符，请再试试';
      }
      return { pass: obj.pass, reason: reason, ok: true };
    } catch (e) {
      notifyFallback(failed(e));
      return localJudge(item, answer);
    }
  };
})();
