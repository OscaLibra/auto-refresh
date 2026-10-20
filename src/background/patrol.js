/**
 * background/patrol.js —— alarms 兜底巡检（AR-TD-001 2.2 / 4.4）
 *
 * 职责：每 30 秒扫一遍标签会话，处理"content script 已经失联"的标签。
 * 为什么必须有它：页面被冻结、标签被 discard、content 崩溃时，页面里没有任何代码在跑，
 *   只有 SW 还活着。没有兜底，这些标签的会话就会静默失效。
 * 为什么阈值是 idleMs + 90s：必须让 content 优先执行（前台精度 1 秒、后台降频后 ≤60 秒），
 *   兜底只在"content 明显没动静"时才动手，否则会出现同一个标签被刷两次。
 */

import { listSessions, patchSession, pushDiag, clearSession } from './session-store.js';
import { getSettings } from './rules-store.js';
import { updateBadge } from './badge.js';
import { DIAG_EVENT } from '../shared/messages.js';

/** alarm 名称 */
export const PATROL_ALARM = 'ar:patrol';
/** 巡检周期（分钟）。Chromium 120+ 支持 0.5 的下限 */
export const PATROL_PERIOD_MIN = 0.5;
/** 兜底宽限：content 超过阈值后再等这么久仍无动作，才由 SW 代劳 */
export const PATROL_GRACE_MS = 90000;

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

    const now = Date.now();
    if (now - (s.lastActivityAt || 0) < s.idleMs + PATROL_GRACE_MS) continue;
    // 防抖：与 content 共用同一条底线，避免"刷完立刻又判超时"
    if (now - (s.lastExecAt || 0) < settings.minExecIntervalMs) continue;

    // 保活模式且规则禁止降级时，不在兜底里强行刷新（会违反"不打断"的承诺）
    if (s.mode === 'ping' && s.allowPingFallback === false) continue;

    const tab = await chrome.tabs.get(s.tabId).catch(() => null);
    if (!tab) {
      await clearSession(s.tabId);
      continue;
    }
    // 正在加载的页面不重复刷新；discarded 的标签则正好需要一次 reload 把内容拉回来
    if (tab.status === 'loading') continue;

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
        detail: `idle=${Math.round((now - (s.lastActivityAt || now)) / 1000)}s`,
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
