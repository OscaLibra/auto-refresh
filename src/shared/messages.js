/**
 * shared/messages.js —— 消息契约（AR-TD-001 第 6 节）
 *
 * 职责：消息 type 常量、诊断事件枚举、错误构造器。
 * 为什么单独成文件：SW / options / popup 三处都要用同一批字符串，
 *   写错一个字符的表现是"消息静默丢失"，排查成本极高。
 * 边界：content script 不能 import（规范 2.1），00-config.js 复制了同值常量。
 */

/** 消息类型：ar:{方向}:{动作}（规范 1.2） */
export const MSG = Object.freeze({
  /* content → SW */
  CONTENT_HELLO: 'ar:content:hello',
  CONTENT_ACTIVITY: 'ar:content:activity',
  CONTENT_EXEC: 'ar:content:exec',
  CONTENT_BYE: 'ar:content:bye',
  CONTENT_DIAG: 'ar:content:diag',

  /* popup / options → SW */
  SW_GET_STATE: 'ar:sw:getState',
  SW_REFRESH_NOW: 'ar:sw:refreshNow',
  SW_SET_PAUSED: 'ar:sw:setPaused',
  SW_SET_GLOBAL: 'ar:sw:setGlobal',
  SW_EXPORT_DIAG: 'ar:sw:exportDiag',

  /* options → SW */
  RULES_CHANGED: 'ar:rules:changed',

  /* SW → content */
  SW_BROADCAST: 'ar:sw:broadcast',
  TAB_COMMAND: 'ar:tab:command',
  /** SW → 顶层帧：把子帧的交互时间转给负责计时的顶层帧（见 99-main.js 注释） */
  SW_FRAME_ACTIVITY: 'ar:sw:frameActivity',
});

/** 定向控制指令（ar:tab:command 的 payload.cmd） */
export const CMD = Object.freeze({
  PAUSE: 'pause',
  RESUME: 'resume',
  REFRESH: 'refresh',
  RESYNC: 'resync',
  /** 子帧活动转交（仅 SW → 顶层帧） */
  ACTIVITY: 'activity',
});

/** SW → content 的广播事件（ar:sw:broadcast 的 payload.event） */
export const EVT = Object.freeze({
  RULES_CHANGED: 'rules-changed',
  SETTINGS_CHANGED: 'settings-changed',
});

/**
 * 诊断事件枚举（AR-TD-001 5.6）。
 * 只允许这些值，弹窗与导出功能依赖它做归类。
 */
export const DIAG_EVENT = Object.freeze({
  REGISTERED: 'registered',
  NO_MATCH: 'no-match',
  MULTI_MATCH: 'multi-match-longest-win',
  ACTIVITY: 'activity',
  IDLE_TIMEOUT: 'idle-timeout',
  PROMPT_SHOWN: 'prompt-shown',
  SNOOZE: 'snooze',
  RELOAD_START: 'reload-start',
  RELOAD_BLOCKED: 'reload-blocked',
  PING_OK: 'ping-ok',
  PING_FALLBACK: 'ping-fallback',
  PATROL_RELOAD: 'patrol-reload',
  PAUSED: 'paused',
  PERMISSION_MISSING: 'permission-missing',
  /* 以下为本实现补充的可诊断节点，均属"状态迁移"级别 */
  RESYNC: 'resync',
  URL_CHANGED: 'url-changed',
  EXEC_ERROR: 'exec-error',
  DEBOUNCED: 'debounced',
  /**
   * 计时基准被重置。detail 里带来源（boot / resync-start / resume / snooze / 具体事件名）。
   * 这是排查"倒计时为什么突然归满"的关键线索：只有真实输入、
   * 页面载入、刚转为监控、用户暂停恢复这四类才应该出现。
   */
  RESET: 'reset',
});

/**
 * 构造带 code 的错误（规范 3.4：禁止抛裸 Error）。
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function badRequest(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * 统一信封的成功/失败包装，由 SW 的 onMessage 使用。
 * @param {(msg: any, sender: chrome.runtime.MessageSender) => any} handler
 */
export function wrap(handler) {
  return async (msg, sender) => ({ ok: true, data: await handler(msg, sender) });
}
