/**
 * 发布前清理：把编译出的测试产物从 dist 中移除。
 *
 * 为什么需要这一步：
 *   tsc 会把 src/**\/*.test.ts 一并编译进 dist，而 npm 的 "files" 白名单
 *   只限定顶层目录、无法排除目录内部的单个文件（.npmignore 对白名单内的
 *   目录不生效）。结果是测试代码被打进发布包——体积浪费，且对用户无意义。
 *
 * 为什么不用 tsconfig 的 exclude：
 *   npm test 正是靠 dist/**\/*.test.js 来跑的，构建时排除会让测试跑不了。
 *   所以在「构建时保留、打包前摘掉」这个位置处理。
 *
 * 由 package.json 的 prepack 钩子调用，本地开发与 npm test 不受影响。
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const DIST = path.resolve(process.cwd(), "dist");
const SIDECAR = path.resolve(process.cwd(), "sidecar");

/** 判断是否是测试产物：foo.test.js / foo.test.js.map / foo.test.d.ts / foo.test.d.ts.map */
function isTestArtifact(name) {
  return /\.test\.(js|js\.map|d\.ts|d\.ts\.map|js\.map)$/.test(name) || /\.test\.js\.map$/.test(name);
}

let removed = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dist 不存在时静默跳过
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 递归清理 Python 字节码缓存等无关目录
      if (entry.name === "__pycache__") {
        rmSync(full, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      walk(full);
      continue;
    }

    if (isTestArtifact(entry.name)) {
      try {
        statSync(full);
        rmSync(full, { force: true });
        removed += 1;
      } catch {
        // 忽略个别文件删除失败，不阻塞发布
      }
    }
  }
}

walk(DIST);
// sidecar 目录同样要清：只要本地跑过一次 chictr_sidecar.py，Python 就会在这里
// 生成 __pycache__，而它是随包发布的目录（files 里列了 sidecar），必须摘掉。
walk(SIDECAR);

if (removed > 0) {
  console.log(`[prepack] 已从发布包中排除 ${removed} 个测试/缓存文件`);
} else {
  console.log("[prepack] 无需清理");
}
