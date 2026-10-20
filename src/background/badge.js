/**
 * background/badge.js —— 工具栏角标（AR-TD-001 4.4）
 *
 * 职责：在扩展图标上显示当前标签的剩余分钟数。
 * 为什么要有：用户最常问的是"它到底有没有在跑"，角标是最省事的可见反馈。
 * 约束：只在分钟数变化时更新，减少无意义重绘；tab 已被关闭时静默失败。
 */

import { getSession } from './session-store.js';

const COLOR_NORMAL = '#2563eb';
const COLOR_PAUSED = '#bf8700';
const COLOR_URGENT = '#cf222e';

/**
 * 更新指定标签的角标。
 * @param {number} tabId
 */
export async function updateBadge(tabId) {
  if (typeof tabId !== 'number') return;
  const s = await getSession(tabId);

  if (!s || !s.idleMs) {
    await setText(tabId, '');
    return;
  }

  if (s.paused) {
    await setText(tabId, '||', COLOR_PAUSED);
    return;
  }

  const remain = Math.max(0, s.idleMs - (Date.now() - (s.lastActivityAt || 0)));
  const minutes = Math.ceil(remain / 60000);
  // 少于 1 分钟用 "<1"，比 "0" 更符合直觉（0 会让人以为停摆了）
  const text = remain < 60000 ? '<1' : String(minutes);
  await setText(tabId, text, remain < 60000 ? COLOR_URGENT : COLOR_NORMAL);
}

/**
 * @param {number} tabId
 */
export async function clearBadge(tabId) {
  await setText(tabId, '');
}

/**
 * @param {number} tabId
 * @param {string} text
 * @param {string} [color]
 */
async function setText(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // 静默：标签已关闭或尚未完成加载时设置角标会抛错，属预期行为
  }
}
