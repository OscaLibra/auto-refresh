/**
 * background/registrar.js —— 动态 content script 注册（AR-TD-001 2.5 / 第 7 节）
 *
 * 职责：把"启用且已授权"的规则同步成 chrome.scripting 的注册记录。
 * 为什么不用静态 content_scripts：规则由用户定义，静态声明只能写死；而写全站通配
 *   （scheme 与 host 都是星号）会在安装时要求"读取和更改您在所有网站上的数据"，
 *   企业内分发会被安全团队直接拦下。
 * 关键约束：
 *   1. 必须幂等——onInstalled / onStartup / 规则变更 / 权限变更都会调它；
 *   2. 必须 diff 而不是"先全注销再全注册"，否则正在运行的页面会短暂失管；
 *   3. matches 超出已授予权限时 registerContentScripts 会抛错，必须 catch 并回写
 *      permissionGranted=false，让设置页显示"需重新授权"。
 */

import { CONTENT_JS } from './content-manifest.js';
import { listRules, updateRule } from './rules-store.js';
import { pushDiag } from './session-store.js';
import { DIAG_EVENT } from '../shared/messages.js';
import { toOriginPattern } from '../shared/pattern.js';

/** 注册记录 id 前缀，用于与其它扩展/其它用途的注册区分 */
export const REG_ID_PREFIX = 'ar-rule-';

let chain = Promise.resolve();

/**
 * 串行化重建，避免 onInstalled 与 rules:changed 并发改注册表。
 * @template T
 * @param {() => Promise<T>} fn
 */
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * 幂等重建所有注册。
 * @returns {Promise<{registered:number, failed:Array<{id:string,message:string}>}>}
 */
export function rebuild() {
  return serial(async () => {
    const rules = await listRules();
    const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
    const mine = existing.filter((s) => s.id.startsWith(REG_ID_PREFIX));

    // 规则里 enabled 但权限已被撤销的，先纠正标记（这样 wanted 里就不会包含它）
    const checked = [];
    for (const r of rules) {
      const granted = await hasPermission(r.pattern);
      if (granted !== r.permissionGranted) {
        const patched = await updateRule(r.id, { permissionGranted: granted }).catch(() => r);
        if (!granted) {
          await pushDiag({ event: DIAG_EVENT.PERMISSION_MISSING, detail: r.pattern });
        }
        checked.push(patched);
      } else {
        checked.push(r);
      }
    }

    const wanted = new Map(
      checked.filter((r) => r.enabled && r.permissionGranted).map((r) => [`${REG_ID_PREFIX}${r.id}`, r]),
    );

    // 1) 注销多余 / 已失效的注册
    const toRemove = mine.filter((s) => !wanted.has(s.id)).map((s) => s.id);
    if (toRemove.length) {
      await chrome.scripting.unregisterContentScripts({ ids: toRemove }).catch(() => {});
    }

    // 2) 补齐缺失 / 匹配规则变了的注册
    const toAdd = [];
    for (const [id, rule] of wanted) {
      const cur = mine.find((s) => s.id === id);
      const sameMatch = !!cur && cur.matches?.[0] === rule.pattern;
      const sameJs = !!cur && Array.isArray(cur.js) && cur.js.join('|') === CONTENT_JS.join('|');
      if (sameMatch && sameJs) continue;
      if (cur) {
        // 规则改了 URL 或脚本清单变了：同 id 直接注册会报重复，必须先注销
        await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
      }
      toAdd.push({
        id,
        matches: [rule.pattern],
        js: CONTENT_JS,
        runAt: 'document_idle',
        // 见 2.8：跨域 iframe 内的交互不会冒泡到顶层，必须注入所有帧
        allFrames: true,
        persistAcrossSessions: true,
        world: 'ISOLATED',
      });
    }

    const failed = [];
    for (const spec of toAdd) {
      try {
        await chrome.scripting.registerContentScripts([spec]);
      } catch (e) {
        failed.push({ id: spec.id, message: e?.message || String(e) });
        const ruleId = spec.id.slice(REG_ID_PREFIX.length);
        // 权限被撤销 / pattern 不合法都会走到这里；标记出来让 UI 可解释
        await updateRule(ruleId, { permissionGranted: false }).catch(() => {});
      }
    }

    return { registered: toAdd.length - failed.length, failed };
  });
}

/**
 * 注销单条规则的注册（删除规则时即时生效，不必等重建）。
 * @param {string} ruleId
 */
export async function unregisterRule(ruleId) {
  await chrome.scripting
    .unregisterContentScripts({ ids: [`${REG_ID_PREFIX}${ruleId}`] })
    .catch(() => {
      // 静默：注册记录本来就不存在时注销会抛错，属于预期
    });
}

/**
 * 查询某条规则所需的 host 权限是否已授予。
 * 用域名级 pattern 判断：host 权限在 Chrome 里本就按域名授予，
 * 用带路径的 pattern 判断会因"未被完全包含"而误判为未授权（进而错误注销规则）。
 * @param {string} pattern 规则里的 match pattern（可能带路径）
 * @returns {Promise<boolean>}
 */
export async function hasPermission(pattern) {
  try {
    return await chrome.permissions.contains({ origins: [toOriginPattern(pattern)] });
  } catch {
    // pattern 非法时 contains 也会抛错，按"未授权"处理，让 UI 提示重新配置
    return false;
  }
}

/**
 * 撤销某个域名级 pattern 的 host 权限。
 * 注意：调用方必须先确认没有其它规则共用同一域名，否则会把别的规则一起弄失效。
 * @param {string} pattern 规则里的 match pattern 或域名级 pattern
 */
export async function dropPermission(pattern) {
  try {
    await chrome.permissions.remove({ origins: [toOriginPattern(pattern)] });
  } catch {
    // 静默：权限本就未授予
  }
}
