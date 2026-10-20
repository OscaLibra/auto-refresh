/**
 * background/service-worker.js —— 装配入口（AR-TD-001 4.4 / 规范 2.7）
 *
 * 职责：只做"装配 + 事件绑定"，业务全部下沉到各模块。
 * 为什么所有 addListener 都写在顶层同步位置：SW 随时会被回收又随时被事件唤醒，
 *   如果先 await 初始化再注册监听器，冷启动瞬间到达的事件没有订阅者，直接丢掉。
 *   因此初始化统一走 bootstrap()，由 handler 内部懒执行（幂等）。
 * 边界：顶层只允许"常量 / 纯函数 / 可重建的 Promise 缓存"，不存业务状态。
 */

import { MSG } from '../shared/messages.js';
import { findHandler } from './message-router.js';
import { ensureInitialized, listRules } from './rules-store.js';
import { rebuild } from './registrar.js';
import { ensureAlarm, patrol, PATROL_ALARM } from './patrol.js';
import { clearSession, moveSession, patchSession } from './session-store.js';
import { updateBadge } from './badge.js';
import { matchRule, safeUrl } from '../shared/pattern.js';

/* ------------------------------------------------------------------ */
/* 初始化（幂等 + 可重建缓存）                                          */
/* ------------------------------------------------------------------ */

/**
 * 这里跨事件存活，但它是"可重建的 Promise 缓存"而非业务状态：
 * 丢了重新算一次即可，因此不违反"SW 禁止持有持久状态"（规范 2.2 的显式例外）。
 * @type {Promise<void> | null}
 */
let bootstrapped = null;

/**
 * @param {string} reason 触发来源，仅用于日志
 * @returns {Promise<void>}
 */
function bootstrap(reason) {
  bootstrapped ??= (async () => {
    await ensureInitialized();
    await ensureAlarm();
    await rebuild();
    console.info(`[AR] sw bootstrapped (${reason})`);
  })().catch((e) => {
    // 失败后允许下次事件重试，避免一次异常让 SW 永久处于半初始化状态
    bootstrapped = null;
    console.error('[AR] bootstrap failed', e);
  });
  return bootstrapped;
}

/* ------------------------------------------------------------------ */
/* 消息                                                               */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = findHandler(msg);
  if (!handler) return false; // 关键：不认识的类型不占用通道，让其他监听器有机会处理

  Promise.resolve()
    .then(() => bootstrap('message'))
    .then(() => handler(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      if (err?.code !== 'no-session') {
        console.warn('[AR] handler error', msg?.type, err?.code || '', err?.message || err);
      }
      sendResponse({
        ok: false,
        error: { code: err?.code || 'internal', message: err?.message || String(err) },
      });
    });

  return true; // 关键：保持异步回包，漏写会表现为"popup 一直转圈 + message port closed"
});

/* ------------------------------------------------------------------ */
/* 定时与生命周期                                                      */
/* ------------------------------------------------------------------ */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== PATROL_ALARM) return;
  bootstrap('alarm')
    .then(() => patrol())
    .catch((e) => console.warn('[AR] patrol failed', e?.message || e));
});

chrome.runtime.onInstalled.addListener(() => {
  // 扩展更新会丢失动态注册记录（R-10），必须在这里幂等重建
  bootstrapped = null;
  bootstrap('installed');
});

chrome.runtime.onStartup.addListener(() => {
  bootstrapped = null;
  bootstrap('startup');
});

/* ------------------------------------------------------------------ */
/* 标签事件                                                           */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  clearSession(tabId).catch(() => {});
});

/**
 * URL 变化（含 SPA 的降级处理，R-12）：让 content 重新匹配规则。
 * 关键：绝不在这里重置 lastActivityAt——
 *  - 真导航：content 会重新注入并 hello(fresh)，时间轴自然重开；
 *  - SPA 路由变化 / 后台页面的重定向：resync（非 fresh）只同步元数据。
 * 曾有无条件 `lastActivityAt: now` 的写法，任何后台 URL 抖动都会把倒计时归满。
 * 本期不做 MAIN world 劫持 pushState——那会与站点脚本耦合，代价高于收益。
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) {
    if (changeInfo.status === 'complete' && tab?.active) {
      updateBadge(tabId).catch(() => {});
    }
    return;
  }

  bootstrap('tabs.onUpdated')
    .then(async () => {
      const url = safeUrl(changeInfo.url);
      const rules = await listRules();
      const hit = matchRule(changeInfo.url, rules);
      if (!hit.rule) {
        // 新地址已不在监控范围：会话必须清掉，否则兜底巡检会按旧规则
        // 去刷一个根本不该刷的页面（旧会话里的 idleMs 还在生效）
        await clearSession(tabId).catch(() => {});
      } else {
        await patchSession(tabId, { url });
      }
      await chrome.tabs
        .sendMessage(tabId, { type: MSG.TAB_COMMAND, payload: { cmd: 'resync' } }, { frameId: 0 })
        .catch(() => {
          // 静默：新页面还没注入 content（或已不匹配规则）
        });
      if (tab?.active) await updateBadge(tabId);
    })
    .catch(() => {});
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  moveSession(addedTabId, removedTabId).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId).catch(() => {});
});

/* ------------------------------------------------------------------ */
/* 权限变化（R-07）                                                    */
/* ------------------------------------------------------------------ */

chrome.permissions.onRemoved.addListener(() => {
  rebuild().catch(() => {});
});

chrome.permissions.onAdded.addListener(() => {
  rebuild().catch(() => {});
});

/* ------------------------------------------------------------------ */
/* 启动即自检                                                          */
/* ------------------------------------------------------------------ */

bootstrap('sw-start').then(async () => {
  // 冷启动时补一次角标，避免图标停留在旧状态
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (active?.id != null) await updateBadge(active.id);
});
