/**
 * 70-telemetry.js —— 上报与诊断（content 世界）
 *
 * 职责：把"页面里发生了什么"告诉 SW，用于会话登记与诊断流水。
 * 为什么必须 catch：页面卸载 / 扩展被重载 / SW 未唤醒时 sendMessage 会抛
 *   `Could not establish connection` 或 `Extension context invalidated`，
 *   未捕获会把控制台刷满，用户会以为插件坏了（规范 3.2）。
 * 边界：只上报状态，不上报任何页面内容；URL 已在 SW 侧脱敏（去掉 query/hash）。
 */

(function () {
  'use strict';

  const AR = window.AR && window.AR.__ours ? window.AR : window.__AR__;
  if (!AR) return;

  const C = AR.const;
  const st = AR.state;

  /**
   * 统一发送入口，永不 reject。
   * @param {{type:string, payload?:any}} msg
   * @returns {Promise<any>}
   */
  function send(msg) {
    try {
      // 扩展上下文失效（更新 / 卸载）时 chrome.runtime.id 会变成 undefined
      if (!chrome.runtime || !chrome.runtime.id) return Promise.resolve(null);
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      // 静默：Extension context invalidated，属于开发期最常见且无需修复的现象
      return Promise.resolve(null);
    }
  }

  /**
   * 启动登记：告诉 SW "这个标签在按这条规则计时"。
   * @param {boolean} [fresh] true = 页面刚真正加载（SW 据此重开时间轴）；
   *   false/省略 = 仅元数据同步（resync 触发），SW 必须保留现有计时基准。
   */
  function hello(fresh) {
    if (!st.isTop) return Promise.resolve(null);
    return send({
      type: C.MSG.HELLO,
      payload: {
        url: location.href,
        ruleId: st.rule ? st.rule.id : null,
        idleMs: st.idleMs,
        mode: st.mode,
        allowPingFallback: st.allowPingFallback,
        lastActivityAt: st.lastActivityAt || Date.now(),
        fresh: fresh === true,
      },
    });
  }

  /**
   * 活动上报（节流）。节流只影响"告诉 SW"的频率，不影响本地计时精度。
   * 采用"尾随"策略：即使节流窗口内，也会在窗口结束时补发一次最新时间戳，
   * 否则 SW 侧的 lastActivityAt 会长期滞后，兜底巡检可能误刷。
   */
  function activity(extra) {
    const gap = Math.max(1000, Number((st.settings && st.settings.activityReportThrottleMs) || C.ACTIVITY_THROTTLE_MS));
    const now = Date.now();

    if (now - st.lastReportAt >= gap) {
      st.lastReportAt = now;
      flush(extra);
      return;
    }
    if (st.reportTimer) return;
    st.reportTimer = setTimeout(() => {
      st.reportTimer = 0;
      st.lastReportAt = Date.now();
      flush(extra);
    }, Math.max(0, gap - (now - st.lastReportAt)));
  }

  /**
   * @param {any} extra
   */
  function flush(extra) {
    send({
      type: C.MSG.ACTIVITY,
      payload: Object.assign(
        {
          lastActivityAt: st.lastActivityAt || Date.now(),
          visible: document.visibilityState === 'visible',
        },
        extra || {},
      ),
    });
  }

  /**
   * 即时同步（绕过节流）：把当前权威时间戳立刻告诉 SW。
   * 只在"副本可能与判决方脱节"的关键节点调用——目前是页面恢复可见时，
   * 让弹窗 / 角标立即显示真实剩余时间，而不是等下一个节流窗口。
   */
  function sync() {
    if (!st.isTop) return Promise.resolve(null);
    return flush();
  }

  /**
   * 关键事件上报（刷新开始 / 被拦截 / 保活结果…）。
   * @param {string} event 见 00-config.js 的 AR.const.EV
   * @param {string} [detail]
   */
  function event(eventName, detail) {
    return send({
      type: C.MSG.EXEC,
      payload: { event: eventName, detail: detail || undefined, mode: st.mode },
    });
  }

  /** 页面卸载前告别（仅诊断用） */
  function bye(reason) {
    return send({ type: C.MSG.BYE, payload: { reason: reason || 'pagehide' } });
  }

  AR.telemetry = { send, hello, activity, sync, event, bye };
})();
