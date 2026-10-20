/**
 * 00-config.js —— 常量、命名空间与共享状态（content 世界）
 *
 * 职责：建立 window.AR 命名空间，集中所有常量与运行期状态。
 * 为什么不用 ESM：content script 不支持 `import`，写了就是
 *   `Uncaught SyntaxError: Cannot use import statement outside a module`，加载即失败。
 *   因此本目录全部是 IIFE，靠 manifest 的 js 数组顺序保证依赖（00 → 99）。
 * 为什么常量复制了一份：content 不能 import shared/*.js，只能复制同值常量，
 *   一致性由 tools/verify.mjs 校验。
 * 边界：本文件只放常量与状态容器，不放逻辑。
 */

(function () {
  'use strict';

  // 若站点已占用 window.AR，按规范 1.3 退让到 __AR__，避免与站点变量互相污染
  const NS = window.AR && !window.AR.__ours ? '__AR__' : 'AR';
  window[NS] = window[NS] || {};
  const AR = window[NS];
  AR.__ours = true;

  /** 常量：禁止在业务代码里出现裸数字（规范 5.5） */
  AR.const = Object.freeze({
    TICK_MS: 1000,
    WAKE_DETECT_MS: 30000,
    RELOAD_PROBE_MS: 3000,
    ACTIVITY_THROTTLE_MS: 10000,
    MIN_EXEC_INTERVAL_MS: 30000,
    MAX_PROMPT_SEC: 120,
    MIN_IDLE_MIN: 1,
    MAX_IDLE_MIN: 180,

    /* storage key，与 src/shared/storage-keys.js 保持一致 */
    K_RULES: 'ar:rules',
    K_SETTINGS: 'ar:settings',

    /* 与 src/shared/messages.js 保持一致 */
    MSG: {
      HELLO: 'ar:content:hello',
      ACTIVITY: 'ar:content:activity',
      EXEC: 'ar:content:exec',
      BYE: 'ar:content:bye',
      DIAG: 'ar:content:diag',
      BROADCAST: 'ar:sw:broadcast',
      TAB_COMMAND: 'ar:tab:command',
      FRAME_ACTIVITY: 'ar:sw:frameActivity',
    },

    /* 与 src/shared/messages.js 的 DIAG_EVENT 保持一致 */
    EV: {
      NO_MATCH: 'no-match',
      MULTI_MATCH: 'multi-match-longest-win',
      IDLE_TIMEOUT: 'idle-timeout',
      PROMPT_SHOWN: 'prompt-shown',
      SNOOZE: 'snooze',
      RELOAD_START: 'reload-start',
      RELOAD_BLOCKED: 'reload-blocked',
      PING_OK: 'ping-ok',
      PING_FALLBACK: 'ping-fallback',
      EXEC_ERROR: 'exec-error',
      DEBOUNCED: 'debounced',
      RESYNC: 'resync',
    },

    /* 到点动作枚举：三处必须一致（此处 / registrar 规则 schema / options 下拉框） */
    EXECUTORS: ['reload', 'ping'],

    /* 滚动位置的 sessionStorage 前缀（规范 2.3 的唯一例外） */
    SCROLL_KEY_PREFIX: 'ar:scroll:',

    BRAND: '[AR]',
  });

  /** 运行期状态：只由 99-main.js 初始化，各模块读写各自字段 */
  AR.state = {
    isTop: true,
    booted: false,
    ready: false,
    /** 规则与生效参数 */
    rule: null,
    settings: null,
    idleMs: 0,
    mode: 'reload',
    promptSeconds: 0,
    keepScroll: true,
    allowPingFallback: true,
    /** 判决相关时间戳 */
    lastActivityAt: 0,
    lastTickAt: 0,
    wakeAt: 0,
    lastExecAt: 0,
    /** 控制位 */
    enabled: true,
    paused: false,
    promptShown: false,
    execInFlight: false,
    reportTimer: 0,
    lastReportAt: 0,
    tickTimer: 0,
    /** 最近一次匹配原因，供诊断使用 */
    matchReason: '',
  };

  /**
   * 分级日志（规范 8.1）：[AR] {event} {detail}
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} event
   * @param {any} [detail]
   */
  AR.log = function log(level, event, detail) {
    const dbg = !!(AR.state.settings && AR.state.settings.debug);
    if (level === 'debug' && !dbg) return;
    if (level === 'info' && !dbg) return; // info 只在调试期开，避免刷屏
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (detail === undefined) fn(`${AR.const.BRAND} ${event}`);
    else fn(`${AR.const.BRAND} ${event}`, detail);
  };

  /**
   * 日志脱敏：去掉 query 与 hash（可能含工单号 / token，规范 8.1）
   * @param {string} u
   * @returns {string}
   */
  AR.safeUrl = function safeUrl(u) {
    try {
      const x = new URL(u);
      return `${x.origin}${x.pathname}`;
    } catch {
      return '(invalid)';
    }
  };
})();
