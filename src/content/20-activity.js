/**
 * 20-activity.js —— 用户活动监听（content 世界）
 *
 * 职责：把"用户还在不在"翻译成一个时间戳。仅此而已——不判决、不上报、不做 DOM 操作。
 * 为什么 handler 里只有一次 Date.now() 赋值：mousemove 每秒几十次，
 *   任何多余的工作（读 DOM、setTimeout 节流、字符串拼接）都会拖慢页面（规范 5.2）。
 * 为什么全部 capture + passive：capture 避免站点在冒泡阶段 stopPropagation 把我们变瞎；
 *   passive 保证不阻塞滚动（否则 Chrome 会报 non-passive listener 警告）。
 */

(function () {
  'use strict';

  const AR = window.AR && window.AR.__ours ? window.AR : window.__AR__;
  if (!AR) return;

  /**
   * 计入活动的事件（AR-TD-001 4.3）。
   * `scroll` 与 `input` 是可选：默认关闭——日志流 / 轮播 / 无限加载会让 scroll 持续触发
   * 且 isTrusted 仍为 true，无法与真实滚动区分，打开就会"永不刷新"。
   *
   * 这里**没有** `focusin`（规范原表里列了，1.0.1 移除）。两个理由：
   *  1) 冗余：点进输入框有 pointerdown / mousedown，Tab 进来有 keydown，纯聚焦无法脱离这两者发生；
   *  2) 有害：部分浏览器在窗口重新获得焦点时会补发焦点事件，
   *     那会把"最小化再打开"又变回一次伪活动——正是 1.0.1 要修的那类误判。
   */
  const BASE_EVENTS = ['mousemove', 'mousedown', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'touchmove'];

  /** @type {Array<[string, EventListener, AddEventListenerOptions]>} */
  let active = [];
  let bound = false;
  let boundKey = '';

  /**
   * 开始监听。
   * @param {() => void} onSignal 每次活动回调（必须极轻）
   * @param {{countScroll?: boolean, countInput?: boolean}} [opts]
   */
  function start(onSignal, opts) {
    const o = opts || {};
    const key = `${o.countScroll ? 1 : 0}${o.countInput ? 1 : 0}`;
    // 同一份配置重复调用视为幂等，避免双实例导致一份页面被重复计时
    if (bound && key === boundKey) return;
    if (bound) stop();

    const handler = () => onSignal();
    const add = (type, extra) => {
      const options = Object.assign({ passive: true, capture: true }, extra || {});
      window.addEventListener(type, handler, options);
      active.push([type, handler, options]);
    };

    for (const type of BASE_EVENTS) add(type);
    if (o.countScroll) {
      // scroll 不冒泡，必须 capture 才收得到内部容器的滚动（规范 5.2）
      add('scroll');
    }
    if (o.countInput) {
      add('input');
      add('change');
    }

    bound = true;
    boundKey = key;
  }

  /** 解绑（pagehide 时调用，避免 bfcache 恢复后出现双实例） */
  function stop() {
    for (const [type, handler, options] of active) {
      window.removeEventListener(type, handler, options);
    }
    active = [];
    bound = false;
    boundKey = '';
  }

  AR.activity = { start, stop };
})();
