/**
 * assets/ai.js —— AI 能力层（A 拥有）
 * 走 WorkBuddy 云服务免密钥通道：前端没有任何模型密钥。
 *
 * 对外契约（B/C 只调这些）：
 *   LF.ai.describeImage(dataURL)                       -> {desc, tags[], ok}
 *   LF.ai.expandQuery(text)                            -> {keywords[]}
 *   （makeQuestion / judgeAnswer 已移除：核验走阿寻，浏览器不再持有 detail。
 *     详见文件末尾说明。）
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

  /* ---------------- 核验：已迁到阿寻，网页端不再持有 detail ----------------
   *
   * 这里原有 makeQuestion / judgeAnswer / localJudge / secretGrams 一整套
   * 「读 item.detail → 出题 → 判答」的浏览器侧核验。删除理由有两条，都不是风格问题：
   *
   * 1) 它们已经**没有调用方**（全仓库 grep 过，核验走的是阿寻对话）；
   * 2) 只要它们还在，api.js 就得继续把 detail 读到浏览器里，
   *    而 detail 是「只有失主才写得出」的核验依据 —— 任何人拿网页里那串
   *    公开密钥就能整列读走（见 db/migrations/2026-11-07_harden_public_columns.sql）。
   *    留一份「需要 detail 才能跑」的死代码，等于给下一个人一个必须把
   *    detail 重新下发的理由。
   *
   * 现在核验的唯一通道：阿寻用 workbuddy_cloudservice_db_exec_sql（库 owner 身份）
   * 按编号查 detail，在服务端出题判答；浏览器从头到尾拿不到。
   * 若将来要在网页里做核验，必须新写一个 SECURITY DEFINER 的判答函数，
   * 只返回 {pass, reason}，不要退回「把 detail 发给前端再本地比对」。
   */
})();
