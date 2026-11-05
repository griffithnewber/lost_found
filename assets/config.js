/**
 * assets/config.js —— 全局配置（A 拥有）
 * 这里的 endpoint / publishableKey 是应用公开配置，前端可持有；
 * 真正的模型密钥由云服务后端保管，前端永远拿不到。
 */
window.LF = window.LF || {};

LF.config = {
  endpoint: 'https://lost-found-75068.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_lmzAUiNMSssVs6mpvimKsP_rbYHVaDjHjeefagx8HdBFj0s5Cvd1a5l',

  // 模型约定：
  //   vision 用于看图打标签与看图判答；
  //   text 用同一视觉模型的文本能力——它稳定走 content 通道，
  //   而部分纯思考模型只输出 reasoning_content，解析 JSON 更易出错。
  //   压测想省积分可临时换成 cheap（hy4free，0 积分）。
  models: {
    vision: 'glm-4.6v',
    text: 'glm-4.6v',
    cheap: 'hy4free'
  },

  ai: {
    timeoutMs: 25000,   // 单次调用超时
    limitPerMinute: 5,  // 同一浏览器 60 秒内最多调用次数（防刷额度）
    maxAttempts: 3      // 认领确认最多回答次数
  },

  // 数据表名
  table: 'lost_items'
};
