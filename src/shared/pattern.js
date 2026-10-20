/**
 * shared/pattern.js —— match pattern 规范化与正则化（AR-TD-001 5.3）
 *
 * 职责：把用户随手输入的 URL 变成合法的 Chrome match pattern，并提供一个"本地判定"用的
 *   正则实现（content 侧用同一套逻辑判断当前页命中了哪条规则）。
 * 为什么必须做规范化：`chrome.scripting.registerContentScripts` 对 `matches` 的校验极严，
 *   用户输入 `https://oa.example.com`（无路径）会直接抛 `Invalid value for matches`。
 * 边界：纯函数、无副作用、不访问 chrome.*，可在 SW / 扩展页 / 单测里直接调用。
 * 已知限制：Chrome 的 match pattern 不支持端口号，这里会把端口剥离并给出 warning。
 */

const SCHEMES = new Set(['http', 'https', '*']);
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

/**
 * @typedef {Object} NormalizeOk
 * @property {true} ok
 * @property {string} pattern 规范化后的 match pattern
 * @property {string[]} warnings 需要提示给用户的降级说明
 * @property {boolean} broad 是否为"全站"级宽泛规则
 *
 * @typedef {Object} NormalizeFail
 * @property {false} ok
 * @property {string} error 面向用户的中文说明
 */

/**
 * 规范化用户输入。
 * @param {string} input 用户输入的 URL 或 match pattern
 * @returns {NormalizeOk | NormalizeFail}
 */
export function normalizePattern(input) {
  const warnings = [];
  let raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: '请填写要监控的网址。' };

  // 用户常直接粘贴整条浏览器地址栏内容，去掉 query / hash 后再判断
  if (raw.startsWith('file://')) {
    return { ok: false, error: '不支持本地文件页（file://），请填写 http 或 https 开头的网址。' };
  }
  if (/^(chrome|edge|about|moz-extension|chrome-extension):/i.test(raw)) {
    return { ok: false, error: '不支持浏览器内部页面，请填写 http 或 https 开头的网址。' };
  }

  if (!raw.includes('://')) {
    raw = `https://${raw}`;
    warnings.push('已自动补全为 https:// 开头。');
  }

  const sep = raw.indexOf('://');
  let scheme = raw.slice(0, sep).toLowerCase();
  let rest = raw.slice(sep + 3);

  if (!SCHEMES.has(scheme)) {
    return { ok: false, error: `不支持的协议 "${scheme}"，只能是 http、https 或 *。` };
  }

  // 去掉 query / hash：match pattern 里不允许出现它们，且绝大多数用户并不想按参数区分
  const cut = rest.search(/[?#]/);
  if (cut >= 0) {
    rest = rest.slice(0, cut);
    warnings.push('已忽略网址中的 ? 参数与 # 锚点（规则按路径匹配）。');
  }

  const slash = rest.indexOf('/');
  let host = slash >= 0 ? rest.slice(0, slash) : rest;
  let path = slash >= 0 ? rest.slice(slash) : '';

  if (!host) return { ok: false, error: '缺少域名，请填写形如 https://oa.example.com/app 的网址。' };

  // 端口：match pattern 不支持，剥离后提示（内网系统常见 :8443 / :8080）
  if (host.includes(':')) {
    const [h, port] = host.split(':');
    if (!/^\d+$/.test(port || '')) {
      return { ok: false, error: `域名中的 "${port}" 不是合法端口。` };
    }
    host = h;
    warnings.push('规则不支持指定端口，已忽略端口号（Chrome 的匹配规则会覆盖该域名下的所有端口）。');
  }

  host = host.toLowerCase();
  if (host.includes('@')) return { ok: false, error: '网址中不允许包含账号信息（@ 之前的部分）。' };

  const hostCheck = validateHost(host);
  if (!hostCheck.ok) return { ok: false, error: hostCheck.error };

  if (!path) {
    path = '/*';
  } else {
    if (!path.startsWith('/')) return { ok: false, error: '路径必须以 / 开头。' };
    if (!path.includes('*')) {
      // `/app` → `/app*`（覆盖 /app/x），`/app/` → `/app/*`
      path = `${path}*`;
    }
  }

  const pattern = `${scheme}://${host}${path}`;
  if (!hostCheck.wildcard && !pattern.includes('*')) {
    // 理论上不会发生：path 一定带 *；保留防御避免未来重构出现无通配的 pattern
    return { ok: false, error: '规则必须包含通配符。' };
  }

  const broad = host === '*' || (scheme === '*' && host === '*');
  if (broad) {
    warnings.push('这条规则会作用于所有网站，权限提示会是"读取和更改您在所有网站上的数据"，请确认确实需要。');
  }

  return { ok: true, pattern, warnings, broad };
}

/**
 * 校验 host 段落（match pattern 的 host 通配符只能出现在最左一段）。
 * @param {string} host
 * @returns {{ ok: true, wildcard: boolean } | { ok: false, error: string }}
 */
function validateHost(host) {
  if (host === '*') return { ok: true, wildcard: true };

  if (host.startsWith('*.')) {
    const tail = host.slice(2);
    if (tail.includes('*')) {
      return { ok: false, error: '通配符 * 只能出现在域名最左侧（如 *.example.com）。' };
    }
    if (!HOST_RE.test(tail) || !tail.includes('.')) {
      return { ok: false, error: `域名 "${tail}" 不合法。` };
    }
    return { ok: true, wildcard: true };
  }

  if (host.includes('*')) {
    return { ok: false, error: '通配符 * 只能出现在域名最左侧（如 *.example.com），不能写在中间。' };
  }
  if (!HOST_RE.test(host) || !host.includes('.')) {
    return { ok: false, error: `域名 "${host}" 不合法，请填写完整域名，如 oa.example.com。` };
  }
  return { ok: true, wildcard: false };
}

/**
 * 把 match pattern 编译成正则，用于"当前页是否命中该规则"的本地判定。
 * 与 Chrome 的匹配语义保持一致：scheme `*` = http + https；host 的 `*.` 也匹配裸域名本身。
 * @param {string} pattern 已规范化的 match pattern
 * @returns {RegExp | null} 非法 pattern 返回 null（调用方必须处理）
 */
export function patternToRegExp(pattern) {
  const p = String(pattern ?? '');
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
  if (host === '*') {
    hostRe = '[^/]+';
  } else if (host.startsWith('*.')) {
    // `*.example.com` 同时匹配 example.com 与 a.example.com
    hostRe = `(?:[^/]+\\.)?${escapeRe(host.slice(2))}`;
  } else {
    hostRe = escapeRe(host);
  }

  const pathRe = escapeRe(path).replace(/\*/g, '.*');

  try {
    return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, 'i');
  } catch {
    return null;
  }
}

/**
 * 在一组规则里挑出命中的那条。
 * 多规则命中时：路径更长（更具体）优先；同长取 idleMinutes 更小（更保守）者。
 * @param {string} href 当前页 location.href
 * @param {Array<{id:string,pattern:string,enabled:boolean,idleMinutes:number}>} rules
 * @returns {{ rule: object|null, reason: string }} reason 直接作为诊断原因码
 */
export function matchRule(href, rules) {
  const list = Array.isArray(rules) ? rules : [];
  const hits = list.filter((r) => {
    if (!r || !r.enabled) return false;
    const re = patternToRegExp(r.pattern);
    return re ? re.test(href) : false;
  });

  if (!hits.length) return { rule: null, reason: 'no-match' };

  hits.sort((a, b) => b.pattern.length - a.pattern.length || (a.idleMinutes || 0) - (b.idleMinutes || 0));
  return { rule: hits[0], reason: hits.length > 1 ? 'multi-match-longest-win' : 'matched' };
}

/**
 * 正则转义，只转义 `.` 与正则元字符，保留 `*` 给上层替换。
 * @param {string} s
 */
function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把带路径的规则收敛成"域名级"pattern（`scheme://host/*`）。
 *
 * 为什么需要：host 权限在 Chrome 里是按域名授予的，`chrome.permissions.request`
 * 传带路径的 pattern 在部分版本会直接抛错（"Invalid value for origins"），
 * 一旦抛错，用户添加规则就会卡在授权环节、且难以自救。
 * 因此统一"按域名申请权限，按路径注册脚本"：脚本的 matches 仍用精确路径，
 * 权限只要覆盖到域名即可。
 *
 * @param {string} pattern 已规范化的 match pattern
 * @returns {string} 域名级 pattern
 */
export function toOriginPattern(pattern) {
  const p = String(pattern ?? '');
  const sep = p.indexOf('://');
  if (sep < 0) return p;
  const scheme = p.slice(0, sep);
  const rest = p.slice(sep + 3);
  const slash = rest.indexOf('/');
  const host = slash >= 0 ? rest.slice(0, slash) : rest;
  return `${scheme}://${host}/*`;
}

/**
 * 日志脱敏：去掉 query 与 hash（可能含工单号 / token，规范 8.1）。
 * @param {string} u
 * @returns {string}
 */
export function safeUrl(u) {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return '(invalid)';
  }
}
