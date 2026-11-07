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

  // 2026-11-07 改版：认领核验已搬到聊天框（寻物官·阿寻）完成，
  // maxAttempts（3 次机会）由人设文件里的规则接管，网页不再判答，这个值仅作历史保留。
  ai: {
    timeoutMs: 25000,   // 单次调用超时
    limitPerMinute: 5,  // 同一浏览器 60 秒内最多调用次数（防刷额度）
    maxAttempts: 3      // 认领确认最多回答次数（已移至人设，网页不再使用）
  },

  /* 网页降级为只读看板后，所有登记 / 查找 / 核验都要用户回到聊天框找阿寻。
     这里放统一的入口文案，横幅、认领按钮、提示都从这里取，避免各处写死。 */
  agent: {
    name: '寻物官 · 阿寻',
    where: 'WorkBuddy 聊天框',
    bannerTitle: '登记和认领都在聊天框里跟「寻物官 · 阿寻」完成',
    bannerDesc: '网页现在只做展示，不能发布、不能搜索、不能核验。',
    claimText: '🔍 去聊天框核验',
    bindHint: '绑定后补照片、收留言、确认找回都算你自己那条'
  },

  // 数据表名
  table: 'lost_items',
  messageTable: 'item_messages',  // 认领留言线程

  /* ============================================================
   * 公开信息分级（防止 AI 解读泄露独特征 → 冒领）
   * 规则：公开页面上只出现「用户自己写的 / 自己选的」内容，
   *      AI 只在后台做检索与核验，绝不在前台生成描述。
   * ============================================================ */

  /* 类别枚举 —— 必须与人设文件（agents/lost-found-assistant.md）里的 category 完全一致，
     否则阿寻写进来的记录在广场上会显示成「📦 其他」+ 无颜色。
     2026-11-07 对齐：人设独有 wallet（钱包）、glasses（眼镜），网页原缺，已补。 */
  categories: [
    { key: 'headphones', label: '耳机', emoji: '🎧' },
    { key: 'cup',        label: '水杯', emoji: '🥤' },
    { key: 'umbrella',   label: '雨伞', emoji: '☂️' },
    { key: 'card',       label: '证件卡', emoji: '💳' },
    { key: 'keys',       label: '钥匙', emoji: '🔑' },
    { key: 'bag',        label: '书包/背包', emoji: '🎒' },
    { key: 'phone',      label: '手机/电子设备', emoji: '📱' },
    { key: 'wallet',     label: '钱包', emoji: '👛' },
    { key: 'glasses',    label: '眼镜', emoji: '👓' },
    { key: 'book',       label: '书/笔记本', emoji: '📚' },
    { key: 'clothes',    label: '衣物', emoji: '🧥' },
    { key: 'other',      label: '其他', emoji: '📦' }
  ],

  /* 主色调枚举 —— 同样必须与人设里的 color_tone 完全一致。
     2026-11-07 对齐：人设独有 brown（棕）、purple（紫）、clear（透明），网页原缺，已补。 */
  colorTones: [
    { key: 'black',  label: '黑色', hex: '#2f3542' },
    { key: 'white',  label: '白色', hex: '#e8eaed' },
    { key: 'gray',   label: '灰色', hex: '#9aa3ad' },
    { key: 'brown',  label: '棕色', hex: '#8d6e63' },
    { key: 'blue',   label: '蓝色', hex: '#4a9eff' },
    { key: 'red',    label: '红色', hex: '#ff6b6b' },
    { key: 'pink',   label: '粉色', hex: '#ff9ff3' },
    { key: 'purple', label: '紫色', hex: '#a55eea' },
    { key: 'green',  label: '绿色', hex: '#51cf66' },
    { key: 'yellow', label: '黄色', hex: '#ffd43b' },
    { key: 'clear',  label: '透明', hex: '#dfe6ec' },
    { key: 'other',  label: '其他颜色', hex: '#b2bec3' }
  ]
};
