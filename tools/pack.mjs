/**
 * tools/pack.mjs —— 打包成可分发的 zip
 *
 * 只打包运行所需文件（manifest / icons / src / 文档），剔除 tools、node_modules 等。
 * 不引第三方依赖：Windows 用 Compress-Archive，其它平台用 zip 命令。
 * 用法：node tools/pack.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'dist');
const OUT = join(OUT_DIR, `auto-refresh-${manifest.version}.zip`);

const INCLUDE = ['manifest.json', 'icons', 'src', 'README.md', 'CHANGELOG.md', 'docs'];

mkdirSync(OUT_DIR, { recursive: true });
if (existsSync(OUT)) rmSync(OUT);

const missing = INCLUDE.filter((p) => !existsSync(join(ROOT, p)));
if (missing.length) {
  console.error(`缺少必要文件：${missing.join(', ')}`);
  process.exit(1);
}

if (process.platform === 'win32') {
  const list = INCLUDE.map((p) => `'${join(ROOT, p).replace(/'/g, "''")}'`).join(',');
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path ${list} -DestinationPath '${OUT.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('zip', ['-r', '-q', OUT, ...INCLUDE], { cwd: ROOT, stdio: 'inherit' });
}

console.log(`已打包：${OUT}`);
console.log(`版本：${manifest.version}（请确认与 package.json 一致，可先跑 node tools/verify.mjs）`);
