/**
 * shared/storage-keys.js —— 存储 key 常量（扩展页与 SW 共用）
 *
 * 职责：把 storage 的 key 收敛到一处。规范 4.2：禁止在业务代码里写字符串字面量 key，
 *   拼错 `ar:sessions` 不会报错，只会表现为"功能莫名不生效"。
 * 边界：content script 不能 import 本文件（规范 2.1），它在 00-config.js 里复制了一份
 *   同值常量，由 tools/verify.mjs 做一致性校验。
 */

/** 规则列表（数组），storage.local */
export const K_RULES = 'ar:rules';
/** 全局设置（对象），storage.local */
export const K_SETTINGS = 'ar:settings';
/** 诊断流水（环形缓冲，最近 50 条），storage.session */
export const K_DIAG = 'ar:diag';
/** 迁移失败时的规则备份，storage.local */
export const K_RULES_BACKUP = 'ar:rules:backup';

/** 标签会话 key 前缀 */
export const SESSION_PREFIX = 'ar:session:';

/** @param {number} tabId @returns {string} 该标签的会话 key */
export function kSession(tabId) {
  return `${SESSION_PREFIX}${tabId}`;
}
