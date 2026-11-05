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

  // 模型约定：视觉识别用 4.6V，纯文本用低倍率 flash，压测可换 hy4free（0 积分）
  models: {
    vision: 'glm-4.6v',
    text: 'glm-5.3-flash',
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
