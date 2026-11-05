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

  // 模型约定（2026-11-05 实测）：
  //   glm-5.3-flash 原生多模态：文本与看图都可用，content 通道稳定，倍率低（x0.08）；
  //   glm-4.6v 虽然在目录里，但网关对它的请求返回 request_invalid_parameter，暂不可用；
  //   hy4free 可用且 0 积分，但 reasoning 冗长，适合压测不适合正式演示。
  models: {
    vision: 'glm-5.3-flash',
    text: 'glm-5.3-flash',
    cheap: 'hy4free'
  },

  ai: {
    timeoutMs: 25000,   // 单次调用超时
    limitPerMinute: 5,  // 同一浏览器 60 秒内最多调用次数（防刷额度）
    maxAttempts: 3      // 认领确认最多回答次数
  },

  // 数据表名
  table: 'lost_items',
  messageTable: 'item_messages'   // 认领留言线程
};
