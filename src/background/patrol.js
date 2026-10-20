/**
 * background/patrol.js —— alarms 兜底巡检（AR-TD-001 2.2 / 4.4）
 *
 * 职责：每 30 秒扫一遍标签会话，处理"content script 已经失联"的标签。
 * 为什么必须有它：页面被冻结、标签被 discard、content 崩溃时，页面里没有任何代码在跑，
 *   只有 SW 还活着。没有兜底，这些标签的会话就会静默失效。
 *
 * 两级宽限（1.0.3）：
 *  - 前台 90 秒：content 是 1 秒精度、必然先到点，SW 只在 content 明显失联时才动手，
 *    避免"content 刚刷完、SW 又刷一次"的双刷；
 *  - 隐藏 10 秒（仅 reload 模式）：最小化 / 后台标签的定时器被降频到 1 次/分钟，
 *    甚至被 Chrome 整页冻结——定时器完全停摆，content 到点**根本不会自己执行**。
 *    这曾是"最小化后到 0 也不刷新，恢复窗口才刷新"的根源（见 CHANGELOG 1.0.3）。
 *    chrome.tabs.reload 不依赖页面里的代码，由 SW 亲自执法。
 *    双刷风险可忽略：SW 刷新后页面重载、旧 content 随之销毁，新页面 hello(fresh)
 *    重置会话，下一轮巡检自然跳过；SW 侧还有 minExecIntervalMs 防抖。
 *  - ping 模式保持 90 秒：保活请求只能在页面里发（同源 Cookie 语义），
 *    SW 无法代为 ping；冻结的极端情况 90 秒后按 allowPingFallback 决定是否降级刷新。
 */

import { listSessions, patchSession, pushDiag, clearSession } from './session-store.js';
import { getSettings } from './rules-store.js';
import { updateBadge } from './badge.js';
import { DIAG_EVENT } from '../shared/messages.js';

/** alarm 名称 */
export const PATROL_ALARM = 'ar:patrol';
/** 巡检周期（分钟）。Chromium 120+ 支持 0.5 的下限 */
export const PATROL_PERIOD_MIN = 0.5;
/** 前台宽限：content 1 秒精度，只在 content 明显失联时才兜底 */
export const PATROL_GRACE_MS = 90000;
/** 隐藏 + reload 模式宽限：页面定时器已降频 / 冻结，SW 直接执行 */
export const PATROL_HIDDEN_GRACE_MS = 10000;

/**
 * 建立巡检 alarm（幂等）。不能用 setInterval——SW 30 秒后就被回收，定时器会消失。
 */
export async function ensureAlarm() {
  const cur = await chrome.alarms.get(PATROL_ALARM).catch(() => null);
  if (cur) return;
  await chrome.alarms
    .create(PATROL_ALARM, {
      delayInMinutes: PATROL_PERIOD_MIN,
      periodInMinutes: PATROL_PERIOD_MIN,
    })
    .catch(() => {
      // 静默：alarm 已存在时 create 会抛错，下一次巡检仍会正常触发
    });
}

/**
 * 判断标签是否处于"隐藏"状态（定时器被降频或冻结，content 未必能自行执行）。
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<boolean>}
 */
async function isHidden(tab) {
  // 非激活标签必然隐藏；frozen 为 M132+ 提供的字段，向后兼容地探测
  if (!tab.active || tab.frozen === true) return true;
  // 激活但所在窗口最小化：整窗隐藏，同样降频 / 冻结
  if (typeof tab.windowId === 'number' && chrome.windows && chrome.windows.get) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (!win || win.state === 'minimized') return true;
  }
  return false;
}

/**
 * 执行一次巡检。
 * @returns {Promise<{scanned:number, reloaded:number}>}
 */
export async function patrol() {
  const settings = await getSettings();
  const sessions = await listSessions();
  let reloaded = 0;

  for (const s of sessions) {
    if (!s || typeof s.tabId !== 'number') continue;
    if (!settings.globalEnabled || s.paused || !s.idleMs) continue;
    // ping 且禁止降级：SW 无法代为保活，也不允许刷新
    if (s.mode === 'ping' && s.allowPingFallback === false) continue;

    const now = Date.now();
    // 粗筛：连最小宽限都没到，不必查标签状态
    if (now - (s.lastActivityAt || 0) < s.idleMs + PATROL_HIDDEN_GRACE_MS) continue;

    const tab = await chrome.tabs.get(s.tabId).catch(() => null);
    if (!tab) {
      await clearSession(s.tabId);
      continue;
    }
    // 正在加载的页面不重复刷新；discarded 的标签则正好需要一次 reload 把内容拉回来
    if (tab.status === 'loading') continue;

    const hidden = await isHidden(tab);
    const grace = hidden && s.mode === 'reload' ? PATROL_HIDDEN_GRACE_MS : PATROL_GRACE_MS;
    if (now - (s.lastActivityAt || 0) < s.idleMs + grace) continue;
    // 防抖：与 content 共用同一条底线，避免"刷完立刻又判超时"
    if (now - (s.lastExecAt || 0) < settings.minExecIntervalMs) continue;

    try {
      await chrome.tabs.reload(s.tabId);
      await patchSession(s.tabId, {
        lastActivityAt: now,
        lastExecAt: now,
        lastExecResult: 'patrol-reload',
        reloadCount: (s.reloadCount || 0) + 1,
      });
      await pushDiag({
        event: DIAG_EVENT.PATROL_RELOAD,
        tabId: s.tabId,
        detail: `idle=${Math.round((now - (s.lastActivityAt || now)) / 1000)}s${hidden ? ' hidden' : ''}`,
      });
      reloaded += 1;
    } catch {
      // 静默：标签在巡检过程中被关闭（Unchecked runtime.lastError: The tab was closed）
      await clearSession(s.tabId);
    }
  }

  // 角标跟随当前激活标签刷新
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (active?.id != null) await updateBadge(active.id);

  return { scanned: sessions.length, reloaded };
}
