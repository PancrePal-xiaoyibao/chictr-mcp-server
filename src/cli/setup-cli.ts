#!/usr/bin/env node
/**
 * 环境自检与自举 CLI。
 *
 * 打包成 dmg/exe 后，用户看不到 npm，也不该被要求手敲命令。这个入口提供
 * 三条最基本的命令，既供人用，也供安装器/首启引导调用：
 *
 *   chictr-mcp-server doctor              体检，只读不动磁盘
 *   chictr-mcp-server setup [--browser]   补齐缺失依赖（幂等，可重复运行）
 *   chictr-mcp-server sidecar             启动 sidecar 前台进程
 *
 * 退出码约定（安装器靠它判断，勿随意改动）：
 *   0  成功 / 环境就绪
 *   1  未就绪或需要用户动作（doctor 发现缺失项时）
 *   2  自举失败（有明确错误）
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  formatEnvReport,
  getEnvReport,
  probeEnvironment,
  venvPython,
  sidecarScript,
  projectRoot,
} from "../runtime/env-probe.js";
import { bootstrapEnvironment, cleanEnvironment } from "../runtime/bootstrap.js";

const HELP = `
ChiCTR MCP Server — 环境管理

用法:
  chictr-mcp-server doctor              检查环境（只读，不修改任何文件）
  chictr-mcp-server setup [选项]        安装缺失依赖（幂等，可重复运行）
  chictr-mcp-server clean [--yes]       删除虚拟环境以便重装
  chictr-mcp-server sidecar             启动 sidecar（前台运行）
  chictr-mcp-server --help              显示本帮助

setup 选项:
  --browser              同时下载浏览器内核（约 560MB，需要联网）
  --mirror=<名称|URL>    PyPI 镜像，可选: aliyun(默认) / tencent / official / tsinghua
                         单个镜像失败会自动回退，最终兜底官方源
  --timeout=<秒>         单步超时，默认 1800

启动 MCP 服务（供 MCP 客户端配置）:
  CHICTR_USE_SIDECAR=1 chictr-mcp-server --transport=stdio

环境变量:
  CHICTR_HOME              项目根目录（打包后目录不在约定位置时设置）
  CHICTR_VENV              虚拟环境目录（默认 <root>/.venv）
  CHICTR_USE_SIDECAR       1 启用 sidecar 优先路径
  CHICTR_SIDECAR_URL       sidecar 地址（默认 http://127.0.0.1:8848）
`;

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function flagValue(prefix: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

/** doctor：只读体检。 */
async function cmdDoctor(): Promise<number> {
  const report = await getEnvReport(true);
  console.log(formatEnvReport(report));

  // 就绪 = 能在「免浏览器」或「有浏览器」任一路径下工作。
  const ready =
    report.sidecar.status === "ok" ||
    (report.venv.status === "ok" &&
      report.pythonDeps.status === "ok" &&
      report.browser.status === "ok");

  if (ready) {
    console.log("\n✅ 环境就绪。");
    return 0;
  }
  console.log("\n❌ 环境未就绪，请运行: chictr-mcp-server setup");
  return 1;
}

/** setup：补齐依赖。 */
async function cmdSetup(): Promise<number> {
  const installBrowser = hasFlag("--browser");
  const mirror = flagValue("--mirror=") || "aliyun";
  const timeoutSec = Number(flagValue("--timeout=") || 1800);

  if (!installBrowser) {
    console.log("提示: 未指定 --browser，将跳过浏览器内核下载。");
    console.log("      sidecar 的纯 HTTP 模式不需要它；若要自动过盾请加 --browser。\n");
  }

  const result = await bootstrapEnvironment({
    installBrowser,
    pypiMirror: mirror,
    stepTimeoutMs: Number.isFinite(timeoutSec) ? timeoutSec * 1000 : 1800_000,
    onProgress: (msg, pct) => {
      console.log(pct !== undefined ? `  [${String(pct).padStart(3)}%] ${msg}` : `  ${msg}`);
    },
  });

  console.log("\n执行结果:");
  for (const s of result.steps) {
    const icon = s.status === "done" ? "✅" : s.status === "skipped" ? "➖" : "❌";
    console.log(`  ${icon} ${s.name}: ${s.detail}`);
  }

  console.log("\n环境状态:");
  console.log(formatEnvReport(result.report));

  if (!result.ok) {
    console.error(`\n❌ 自举失败: ${result.error}`);
    return 2;
  }
  if (result.error) {
    console.warn(`\n⚠️  ${result.error}`);
  }
  console.log("\n✅ 完成。");
  return 0;
}

/** clean：删除 venv（需确认）。 */
async function cmdClean(): Promise<number> {
  if (!hasFlag("--yes")) {
    const dir = venvPython().replace(/[\\/]bin[\\/].*$|[\\/]Scripts[\\/].*$/, "");
    console.log(`即将删除虚拟环境: ${dir}`);
    console.log("这会移除已下载的 Python 依赖（浏览器缓存不受影响）。");
    console.log("确认请加 --yes 重新运行:");
    console.log("  chictr-mcp-server clean --yes");
    return 1;
  }

  const result = await cleanEnvironment({
    onProgress: (m) => console.log(`  ${m}`),
  });
  console.log(result.detail);
  console.log("\n" + formatEnvReport(result.report));
  return result.ok ? 0 : 2;
}

/** sidecar：前台启动 Python 服务。 */
async function cmdSidecar(): Promise<number> {
  const py = venvPython();
  const script = sidecarScript();

  if (!existsSync(py)) {
    console.error("❌ 未找到虚拟环境，请先运行: chictr-mcp-server setup");
    return 2;
  }
  if (!existsSync(script)) {
    console.error(`❌ 未找到 sidecar 脚本: ${script}`);
    return 2;
  }

  const passthrough = process.argv.slice(3).filter((a) => a.startsWith("--"));
  const args = [script, "--warmup", ...passthrough];

  console.log(`启动 sidecar: ${py} ${args.join(" ")}`);
  console.log("（Ctrl+C 停止）\n");

  const child = spawn(py, args, { stdio: "inherit" });

  const forward = (sig: NodeJS.Signals): void => {
    if (!child.killed) child.kill(sig);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));

  return await new Promise<number>((resolve) => {
    child.on("error", (err) => {
      console.error(`❌ 启动失败: ${err.message}`);
      resolve(2);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

/** postinstall：npm 安装时的温和引导。
 *
 * 刻意**不**在这里下载任何大文件。原因：
 *   1. 打包成 dmg/exe 后安装器根本不会执行这个钩子，逻辑不能只依赖它；
 *   2. 在 CI 或用户没打算用时静默下 560MB 是冒犯行为。
 * 所以这里只做「检查 + 提示」，真正的安装交给用户显式执行的 setup。
 */
async function cmdPostinstall(): Promise<number> {
  try {
    const report = await getEnvReport(true);
    if (report.venv.status !== "ok" || report.pythonDeps.status !== "ok") {
      console.log("\n[chictr-mcp-server] 首次使用请运行以下命令完成环境配置：");
      console.log("  npx chictr-mcp-server setup\n");
      console.log("  （如需自动过盾能力，加 --browser 参数下载浏览器内核）\n");
    }
  } catch {
    // postinstall 永远不能导致安装失败。
  }
  return 0;
}

async function cliMain(): Promise<number> {
  const cmd = process.argv[2];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return 0;
  }

  switch (cmd) {
    case "doctor":
      return cmdDoctor();
    case "setup":
      return cmdSetup();
    case "clean":
      return cmdClean();
    case "sidecar":
      return cmdSidecar();
    case "postinstall":
      return cmdPostinstall();
    default:
      // 未知子命令：交给 MCP 主程序处理（可能带 --transport= 等参数）。
      return -1;
  }
}

const code = await cliMain();
if (code >= 0) {
  process.exit(code);
}

// code === -1：不是 CLI 子命令，交回给 MCP server 主入口。
// 这里用动态 import 避免 CLI 与 MCP 两条路径互相污染。
console.log(`未知命令: ${process.argv[2]}（提示: 项目根目录 ${projectRoot()}）`);
console.log("运行 chictr-mcp-server --help 查看用法");
process.exit(0);
