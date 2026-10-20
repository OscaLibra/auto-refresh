/**
 * 10-rule-match.js —— 规则匹配（content 世界）
 *
 * 职责：把 storage.local 里的规则列表与当前 location.href 比对，得出命中的那条。
 * 为什么 content 自己匹配而不是问 SW：页面启动瞬间 SW 可能还在冷启动，
 *   本地匹配是同步的、零往返；SW 侧只做会话登记。
 * 与 shared/pattern.js 的关系：逻辑同源（不能 import，故复制一份精简版），
 *   修改匹配语义时必须两处同步，否则"SW 认为命中、页面认为没命中"。
 */

(function () {
  'use strict';

  const NS = window.AR && window.AR.__ours ? window.AR : window.__AR__;
  if (!NS) return;

  /**
   * 正则转义，保留 `*` 给上层替换
   * @param {string} s
   */
  function escapeRe(s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * match pattern → RegExp，语义与 Chrome 一致：
   *   scheme `*` = http + https；host 的 `*.` 同时匹配裸域名。
   * @param {string} pattern
   * @returns {RegExp | null}
   */
  function patternToRegExp(pattern) {
    const p = String(pattern || '');
    const sep = p.indexOf('://');
    if (sep < 0) return null;
    const scheme = p.slice(0, sep);
    const rest = p.slice(sep + 3);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const host = rest.slice(0, slash);
    const path = rest.slice(slash);
    if (!host) return null;

    let schemeRe;
    if (scheme === '*') schemeRe = 'https?';
    else if (scheme === 'http' || scheme === 'https') schemeRe = scheme;
    else return null;

    let hostRe;
    if (host === '*') hostRe = '[^/]+';
    else if (host.startsWith('*.')) hostRe = `(?:[^/]+\\.)?${escapeRe(host.slice(2))}`;
    else hostRe = escapeRe(host);

    const pathRe = escapeRe(path).replace(/\*/g, '.*');
    try {
      return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, 'i');
    } catch {
      return null;
    }
  }

  /**
   * 多规则命中时：路径更长（更具体）优先；同长取 idleMinutes 更小（更保守）者。
   * @param {string} href
   * @param {Array<Record<string, any>>} rules
   * @returns {{rule: Record<string, any>|null, reason: string}}
   */
  function matchRule(href, rules) {
    const list = Array.isArray(rules) ? rules : [];
    const hits = list.filter((r) => {
      if (!r || !r.enabled) return false;
      const re = patternToRegExp(r.pattern);
      return re ? re.test(href) : false;
    });
    if (!hits.length) return { rule: null, reason: NS.const.EV.NO_MATCH };

    hits.sort((a, b) => b.pattern.length - a.pattern.length || (a.idleMinutes || 0) - (b.idleMinutes || 0));
    return {
      rule: hits[0],
      reason: hits.length > 1 ? NS.const.EV.MULTI_MATCH : 'matched',
    };
  }

  NS.match = { patternToRegExp, matchRule };
})();
