/**
 * background/session-store.js —— 标签会话与诊断流水（AR-TD-001 5.5 / 5.6）
 *
 * 职责：`chrome.storage.session` 中 `ar:session:{tabId}` 与 `ar:diag` 的唯一写者。
 * 为什么用 storage.session：MV3 的 SW 随时被回收，跨事件的状态不能放内存变量；
 *   而这个状态的生命周期与"浏览器会话"一致（重启即清），正好匹配标签会话语义。
 * 边界：content 侧不直接读写这里——accessLevel 默认 TRUSTED_CONTEXTS，
 *   内容脚本本就读不到，这样也避免两个世界双写同一状态。
 */

import { K_DIAG, SESSION_PREFIX, kSession } from '../shared/storage-keys.js';

/** 诊断流水保留条数（环形缓冲） */
export const DIAG_LIMIT = 50;

/* 单键写：只写自己那一条，避免 get(null) 后整表 set 造成并发覆盖（规范 4.3） */

/**
 * 局部更新某标签的会话。
 * @param {number} tabId
 * @param {Record<string, any>} patch
 * @returns {Promise<Record<string, any>>} 更新后的完整会话
 */
export async function patchSession(tabId, patch) {
  const key = kSession(tabId);
  const got = await chrome.storage.session.get(key).catch(() => ({}));
  const cur = got?.[key] || { tabId, registeredAt: Date.now() };
  const next = { ...cur, ...patch, tabId };
  await chrome.storage.session.set({ [key]: next }).catch(() => {});
  return next;
}

/**
 * @param {number} tabId
 * @returns {Promise<Record<string, any> | null>}
 */
export async function getSession(tabId) {
  const key = kSession(tabId);
  const got = await chrome.storage.session.get(key).catch(() => ({}));
  return got?.[key] || null;
}

/**
 * 列出全部会话。
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function listSessions() {
  const all = await chrome.storage.session.get(null).catch(() => ({}));
  return Object.entries(all || {})
    .filter(([k]) => k.startsWith(SESSION_PREFIX))
    .map(([, v]) => v)
    .filter((v) => v && typeof v === 'object');
}

/**
 * 删除某标签的会话（标签关闭 / 页面卸载时）。
 * @param {number} tabId
 */
export async function clearSession(tabId) {
  await chrome.storage.session.remove(kSession(tabId)).catch(() => {});
}

/**
 * 标签被预渲染替换时迁移会话（tabs.onReplaced）。
 * @param {number} addedTabId
 * @param {number} removedTabId
 */
export async function moveSession(addedTabId, removedTabId) {
  const old = await getSession(removedTabId);
  if (!old) return null;
  const next = await patchSession(addedTabId, { ...old, tabId: addedTabId });
  await clearSession(removedTabId);
  return next;
}

/* ------------------------------------------------------------------ */
/* 诊断流水                                                            */
/* ------------------------------------------------------------------ */

let diagChain = Promise.resolve();

/**
 * 追加一条诊断。串行写入，避免并发下丢条目。
 * @param {{event:string, detail?:string, tabId?:number}} entry
 */
export function pushDiag(entry) {
  const run = async () => {
    const got = await chrome.storage.session.get(K_DIAG).catch(() => ({}));
    const list = Array.isArray(got?.[K_DIAG]) ? got[K_DIAG] : [];
    list.push({
      t: Date.now(),
      tabId: typeof entry.tabId === 'number' ? entry.tabId : null,
      event: String(entry.event || 'unknown'),
      detail: entry.detail ? String(entry.detail).slice(0, 200) : undefined,
    });
    // 环形缓冲：只留最近 DIAG_LIMIT 条，保证 storage.session 不会被流水撑大
    const trimmed = list.slice(-DIAG_LIMIT);
    await chrome.storage.session.set({ [K_DIAG]: trimmed }).catch(() => {});
    return trimmed;
  };
  const next = diagChain.then(run, run);
  diagChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function getDiag() {
  const got = await chrome.storage.session.get(K_DIAG).catch(() => ({}));
  return Array.isArray(got?.[K_DIAG]) ? got[K_DIAG] : [];
}
