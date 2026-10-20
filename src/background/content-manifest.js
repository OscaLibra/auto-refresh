/**
 * background/content-manifest.js —— content 脚本清单（唯一真源）
 *
 * 职责：定义注入顺序。数组顺序 = 执行顺序，`99-main.js` 必须最后。
 * 为什么单独抽一个文件：`registrar.js` 要它、`tools/verify.mjs` 要它、README 也要它，
 *   写三份必然漂移。规范 1.2：插入新模块时必须同步改这里 + 文件名前缀。
 * 边界：只导出常量，不含任何逻辑。
 */

export const CONTENT_JS = Object.freeze([
  'src/content/00-config.js',
  'src/content/10-rule-match.js',
  'src/content/20-activity.js',
  'src/content/30-idle-judge.js',
  'src/content/40-executors.js',
  'src/content/50-overlay.js',
  'src/content/60-scroll-keeper.js',
  'src/content/70-telemetry.js',
  'src/content/99-main.js',
]);
