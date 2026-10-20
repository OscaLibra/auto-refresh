/**
 * tools/verify.mjs —— 发布前静态自检（本地可跑的"半个评审"）
 *
 * 覆盖 AR-SPEC-002 第 11 节评审清单里能被机器判定的部分：
 *   · manifest 权限是否越界、是否出现静态 content_scripts
 *   · content 目录有没有 ESM 语法（最常见的 MV3 事故）
 *   · CONTENT_JS 顺序与磁盘文件名前缀是否一致
 *   · 版本号是否与 package.json 同步
 *   · 存储 key 与消息常量是否两处一致
 *   · pattern 规范化 / 匹配语义的单元测试
 * 用法：node tools/verify.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const passes = [];

/** @param {string} name @param {boolean} cond @param {string} [detail] */
function check(name, cond, detail) {
  if (cond) passes.push(name);
  else fails.push(detail ? `${name} —— ${detail}` : name);
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel) => {
  try {
    return statSync(join(ROOT, rel)).isFile();
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ */
/* 1. manifest                                                        */
/* ------------------------------------------------------------------ */

const manifest = JSON.parse(read('manifest.json'));
const ALLOWED = ['storage', 'alarms', 'scripting'];

check('manifest_version 为 3', manifest.manifest_version === 3);
check('minimum_chrome_version ≥ 120', Number(manifest.minimum_chrome_version) >= 120);
check(
  'permissions 未越界',
  Array.isArray(manifest.permissions) && manifest.permissions.every((p) => ALLOWED.includes(p)),
  `实际：${JSON.stringify(manifest.permissions)}`,
);
check('未声明 host_permissions', !manifest.host_permissions, '静态 <all_urls> 会让企业分发被拒');
check('未声明静态 content_scripts', !manifest.content_scripts, '本项目全部走动态注册');
check(
  'optional_host_permissions 已声明',
  Array.isArray(manifest.optional_host_permissions) && manifest.optional_host_permissions.includes('*://*/*'),
);
check('service worker 使用 module 类型', manifest.background?.type === 'module');
check('CSP 显式声明', !!manifest.content_security_policy?.extension_pages);

for (const k of ['16', '48', '128']) {
  check(`图标 icon${k}.png 存在`, exists(manifest.icons[k]), manifest.icons[k]);
}

/* ------------------------------------------------------------------ */
/* 2. content 目录：无 ESM / 无反模式                               */
/* ------------------------------------------------------------------ */

const contentDir = join(ROOT, 'src/content');
const contentFiles = readdirSync(contentDir).filter((f) => f.endsWith('.js')).sort();

for (const f of contentFiles) {
  const src = read(`src/content/${f}`);
  check(`${f} 无 import/export`, !/^\s*(import|export)\s/m.test(src), 'content script 不支持 ESM');
  check(`${f} 无 var`, !/^\s*var\s/m.test(src));
  check(`${f} 无 eval / new Function`, !/\beval\s*\(|new Function\s*\(/.test(src));
  if (f !== '60-scroll-keeper.js') {
    // 只看真实调用（identifier 用法），注释里提到 API 名不算违规
    check(`${f} 未使用 localStorage/sessionStorage`, !/\b(?:local|session)Storage\s*[.[]/.test(src));
  }
  check(`${f} 有文件头注释`, /^\s*\/\*\*/.test(src));
}

/* ------------------------------------------------------------------ */
/* 3. CONTENT_JS 与磁盘一致                                           */
/* ------------------------------------------------------------------ */

const cmSrc = read('src/background/content-manifest.js');
const listed = [...cmSrc.matchAll(/'src\/content\/([^']+)'/g)].map((m) => m[1]);
check(
  'CONTENT_JS 与磁盘文件一致',
  JSON.stringify(listed) === JSON.stringify(contentFiles),
  `注册表：${JSON.stringify(listed)}\n磁盘：  ${JSON.stringify(contentFiles)}`,
);
check('99-main.js 排在最后', listed[listed.length - 1] === '99-main.js');
for (const f of listed) check(`${f} 存在`, exists(`src/content/${f}`));

/* ------------------------------------------------------------------ */
/* 4. 版本同步                                                        */
/* ------------------------------------------------------------------ */

const pkg = JSON.parse(read('package.json'));
check('manifest 与 package.json 版本一致', manifest.version === pkg.version, `${manifest.version} vs ${pkg.version}`);

/* ------------------------------------------------------------------ */
/* 5. 常量两处一致                                                    */
/* ------------------------------------------------------------------ */

const msgs = read('src/shared/messages.js');
const cfg = read('src/content/00-config.js');

const sharedTypes = [...msgs.matchAll(/([A-Z_]+):\s*'(ar:[^']+)'/g)].map((m) => m[2]);
const cfgTypes = [...cfg.matchAll(/'(ar:[^']+)'/g)].map((m) => m[1]);
// content 只参与其中一部分：它发出的 content:* 消息 + 它监听的 SW→content 消息
const NEEDED_BY_CONTENT = new Set(['ar:tab:command', 'ar:sw:broadcast', 'ar:sw:frameActivity']);
const expectedInContent = sharedTypes.filter((t) => t.startsWith('ar:content:') || NEEDED_BY_CONTENT.has(t));
const missing = expectedInContent.filter((t) => !cfgTypes.includes(t));
check('content 侧消息常量覆盖其所需 type', missing.length === 0, `缺少：${missing.join(', ')}`);

check(
  '存储 key 前缀一致 ar:',
  read('src/shared/storage-keys.js').includes("'ar:rules'") && cfg.includes("K_RULES: 'ar:rules'"),
);

/* ------------------------------------------------------------------ */
/* 6. 合规：无外发请求                                                */
/* ------------------------------------------------------------------ */

const allJs = [];
(function walk(dir) {
  for (const f of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${f}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
    else if (f.endsWith('.js')) allJs.push(rel);
  }
})('src');

for (const rel of allJs) {
  const src = read(rel);
  const bad = [...src.matchAll(/fetch\(\s*['"`]https?:/g)];
  check(`${rel} 无外发请求`, bad.length === 0, '只允许请求 location.href（同源）');
}

/* ------------------------------------------------------------------ */
/* 7. pattern 单元测试                                                */
/* ------------------------------------------------------------------ */

const { normalizePattern, patternToRegExp, matchRule, toOriginPattern } = await import('../src/shared/pattern.js');

/** @param {string} input @param {string} expected */
function expectPattern(input, expected) {
  const r = normalizePattern(input);
  check(`normalize("${input}") → ${expected}`, r.ok && r.pattern === expected, r.ok ? `实际：${r.pattern}` : r.error);
}

expectPattern('https://oa.example.com', 'https://oa.example.com/*');
expectPattern('https://oa.example.com/app', 'https://oa.example.com/app*');
expectPattern('https://oa.example.com/app/', 'https://oa.example.com/app/*');
expectPattern('oa.example.com', 'https://oa.example.com/*');
expectPattern('*://*.example.com/*', '*://*.example.com/*');
expectPattern('https://*.example.com/*', 'https://*.example.com/*');
expectPattern('https://example.com/a*b', 'https://example.com/a*b');
expectPattern('oa.example.com:8443/app', 'https://oa.example.com/app*');
expectPattern('https://oa.example.com/app?x=1#h', 'https://oa.example.com/app*');

check('拒绝 file://', normalizePattern('file:///c:/a.html').ok === false);
check('拒绝 host 中间通配 a.*.com', normalizePattern('https://a.*.com/x').ok === false);
check('拒绝无 TLD', normalizePattern('https://localhost').ok === false);
check('拒绝空输入', normalizePattern('   ').ok === false);
check('拒绝 chrome:// ', normalizePattern('chrome://extensions').ok === false);

// 权限申请必须用域名级 pattern：带路径的 origins 在部分 Chrome 版本会直接抛错
check('toOriginPattern 去掉路径', toOriginPattern('https://oa.example.com/app*') === 'https://oa.example.com/*');
check('toOriginPattern 保留通配域名', toOriginPattern('*://*.example.com/*') === '*://*.example.com/*');
check('toOriginPattern 幂等', toOriginPattern('https://a.com/*') === 'https://a.com/*');

/** @param {string} pattern @param {string} url @param {boolean} expected */
function expectMatch(pattern, url, expected) {
  const re = patternToRegExp(pattern);
  const got = !!re && re.test(url);
  check(`match ${pattern} ⟵ ${url} = ${expected}`, got === expected);
}

expectMatch('https://oa.example.com/app/*', 'https://oa.example.com/app/list', true);
expectMatch('https://oa.example.com/app/*', 'https://oa.example.com/app/detail/1?x=1', true);
expectMatch('https://oa.example.com/app/*', 'https://oa.example.com/home', false);
expectMatch('https://oa.example.com/app*', 'https://oa.example.com/app', true);
expectMatch('https://oa.example.com/app*', 'https://oa.example.com/application', true);
expectMatch('*://*.example.com/*', 'http://a.example.com/x', true);
expectMatch('*://*.example.com/*', 'https://example.com/', true);
expectMatch('*://*.example.com/*', 'https://notexample.com/', false);
expectMatch('https://*.example.com/*', 'http://a.example.com/x', false);

const rules = [
  { id: 'a', pattern: 'https://oa.example.com/*', enabled: true, idleMinutes: 10 },
  { id: 'b', pattern: 'https://oa.example.com/app/*', enabled: true, idleMinutes: 12 },
  { id: 'c', pattern: 'https://oa.example.com/home/*', enabled: true, idleMinutes: 5 },
];
const m1 = matchRule('https://oa.example.com/app/list', rules);
check('最长匹配优先（多命中取 /app/*）', m1.rule?.id === 'b', JSON.stringify(m1));
check('多命中原因码正确', m1.reason === 'multi-match-longest-win');
const m2 = matchRule('https://other.example.com/', rules);
check('未命中返回 no-match', m2.rule === null && m2.reason === 'no-match');

/* ------------------------------------------------------------------ */
/* 汇总                                                               */
/* ------------------------------------------------------------------ */

for (const p of passes) console.log(`  ok   ${p}`);
if (fails.length) {
  console.log('');
  for (const f of fails) console.log(`  FAIL ${f}`);
  console.log(`\n${passes.length} 项通过，${fails.length} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${passes.length} 项检查通过`);
