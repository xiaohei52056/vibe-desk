/**
 * 把 Pyodide 运行时从 node_modules 复制到 public/pyodide/。
 *
 * 为什么不用 CDN：jsDelivr 在国内网络不稳定，npmmirror 的文件服务把
 * python_stdlib.zip 下架了（451）。本地化之后 Python 引擎完全离线可用，
 * dev 与构建产物（public/ 会原样进 dist/）都自带。
 *
 * 重装依赖或升级 pyodide 版本后重跑一次：npm run setup:py
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pyodide');
const dest = join(root, 'public', 'pyodide');
mkdirSync(dest, { recursive: true });

for (const f of ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  copyFileSync(join(src, f), join(dest, f));
  console.log('copied', f);
}
console.log('pyodide runtime ->', dest);
