/**
 * 环境探测层（Env Probe）——「开箱即用」的地基。
 *
 * 为什么需要它：打包成 dmg/exe 之后，安装器**不会**执行 npm 的 postinstall
 * 钩子（打包器只收集文件，不跑生命周期脚本）。因此所有依赖准备都必须在
 * 运行时由主程序自己驱动。要做「按需自举」，先得能准确回答三个问题：
 *
 *   1. 缺什么？（Python 解释器 / venv / Python 依赖 / 浏览器内核 / cookie）
 *   2. 缺的东西能不能自动补？（有网络、有权限、有空间）
 *   3. 补不了的时候，还能降级做什么？
 *
 * 这个模块只负责回答 1，并把结论整理成可供决策的结构；它**绝不**修改磁盘
 * 或触发下载，因此可以在任意时刻安全调用（例如 MCP 工具里做诊断）。
 *
 * 设计约束：
 *   - 全部检查用短超时 + 不抛异常：探测本身绝不能成为启动失败的原因。
 *   - 结果带 TTL 缓存：MCP 工具可能被频繁调用，但探测要起子进程，不便宜。
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

/** 探测结果的缓存时长：30 秒。够短，用户装完依赖再查就能看到变化。 */
const PROBE_TTL_MS = 30_000;

/** 所有外部命令的超时：探测不该拖慢启动。 */
const PROBE_TIMEOUT_MS = 8_000;

/** sidecar 要求的最低 Python 版本（scrapling 要求 3.10+）。
 *
 * 注意：bootstrap.ts 里有一份同值副本。改动时**必须同步**，否则探测与自举会给出矛盾结论。
 */
const MIN_PYTHON: [number, number] = [3, 10];

export type CheckStatus = "ok" | "missing" | "outdated" | "error" | "unknown";

export interface CheckResult {
  status: CheckStatus;
  /** 人类可读的一句话结论，可直接展示给用户。 */
  detail: string;
  /** 修复建议；为空表示无需动作。 */
  hint?: string;
}

// ---------------------------------------------------------------------------
// 项目路径解析
// ---------------------------------------------------------------------------

/**
 * 定位项目根目录。
 *
 * 编译后本文件位于 <root>/dist/runtime/env-probe.js，源码位于
 * <root>/src/runtime/env-probe.ts，两种情况都要能正确回溯。
 * 允许用 CHICTR_HOME 覆盖（打包后的安装目录可能不在约定位置）。
 */
export function projectRoot(): string {
  const override = (process.env.CHICTR_HOME || "").trim();
  if (override) return path.resolve(override);

  const here = path.dirname(fileURLToPath(import.meta.url));
  // 编译后位于 dist/runtime/，源码位于 src/runtime/，两种情况都回溯两级。
  const candidates = [path.resolve(here, "..", ".."), path.resolve(here, "..")];

  let best: { dir: string; score: number } | null = null;
  for (const dir of candidates) {
    const { ok, score } = looksLikeProjectRoot(dir);
    if (ok && (!best || score > best.score)) best = { dir, score };
  }
  return best?.dir ?? candidates[0];
}

/**
 * 判定是否为项目根。除了探针自己，还要确认 package.json 里确实是我们这个包，
 * 否则打包后目录结构变化时会误判到别处。
 */
function looksLikeProjectRoot(dir: string): { ok: boolean; score: number } {
  if (!existsSync(path.join(dir, "package.json"))) return { ok: false, score: 0 };
  if (!existsSync(path.join(dir, "sidecar"))) return { ok: false, score: 0 };
  let name = "";
  try {
    name = String(
      (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: string;
      }).name || ""
    );
  } catch {
    return { ok: false, score: 0 };
  }
  return { ok: true, score: name === "chictr-mcp-server" ? 2 : 1 };
}

/** venv 目录；可用 CHICTR_VENV 覆盖。 */
export function venvDir(): string {
  const override = (process.env.CHICTR_VENV || "").trim();
  return override ? path.resolve(override) : path.join(projectRoot(), ".venv");
}

/** venv 内的 python 可执行文件路径（按平台）。 */
export function venvPython(): string {
  const dir = venvDir();
  return process.platform === "win32"
    ? path.join(dir, "Scripts", "python.exe")
    : path.join(dir, "bin", "python3");
}

/** sidecar 脚本路径。 */
export function sidecarScript(): string {
  return path.join(projectRoot(), "sidecar", "chictr_sidecar.py");
}

/** 记录已安装浏览器内核的标记文件（由 bootstrap 写入，用于跳过重复安装）。 */
export function browserMarkerFile(): string {
  return path.join(projectRoot(), ".chictr-browser.json");
}

// ---------------------------------------------------------------------------
// 单项检查
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout || "", stderr: stderr || "" });
      }
    );
  });
}

/** 检查 venv 里的 python 是否存在且可用。 */
async function probeVenv(): Promise<{ result: CheckResult; version: string | null }> {
  const py = venvPython();
  if (!existsSync(py)) {
    return {
      result: {
        status: "missing",
        detail: `未找到虚拟环境（${py}）`,
        hint: "运行 chictr-mcp-server setup 自动创建，或设置 CHICTR_VENV 指向已有环境",
      },
      version: null,
    };
  }

  const { code, stdout, stderr } = await run(py, ["--version"]);
  if (code !== 0) {
    return {
      result: {
        status: "error",
        detail: `虚拟环境不可用：${(stderr || stdout).trim() || `退出码 ${code}`}`,
        hint: "虚拟环境可能已损坏，删除 .venv 后重新运行 setup",
      },
      version: null,
    };
  }

  const version = stdout.trim().replace(/^Python\s+/i, "");

  // 版本下限必须真判。scrapling 要求 3.10+，如果只报「Python 3.9.x」而状态是 ok，
  // 用户会以为环境没问题，直到 setup 或运行时报出难以理解的错误。
  const parsed = parsePythonVersion(version);
  if (parsed && compareVersion(parsed, MIN_PYTHON) < 0) {
    return {
      result: {
        status: "outdated",
        detail: `Python ${version} 低于最低要求 ${MIN_PYTHON.join(".")}`,
        hint: `请安装 Python ${MIN_PYTHON.join(".")} 或更高版本后重新运行 setup`,
      },
      version,
    };
  }

  return {
    result: { status: "ok", detail: `Python ${version}` },
    version,
  };
}

/** 从 "3.10.11" / "3.10" 这类字符串解析出主次版本号；解析不出来返回 null。 */
function parsePythonVersion(version: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** 比较 (major, minor)：a < b 返回负数，相等返回 0，a > b 返回正数。 */
function compareVersion(a: [number, number], b: [number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

/**
 * 检查 venv 里是否装了 sidecar 需要的 Python 包。
 *
 * 用 importlib.util.find_spec 而不是 `pip show`：前者不产生网络/索引开销，
 * 且在 pip 本身损坏时仍能工作。
 */
async function probePythonDeps(): Promise<CheckResult> {
  const py = venvPython();
  if (!existsSync(py)) {
    return {
      status: "unknown",
      detail: "无虚拟环境，跳过依赖检查",
    };
  }

  const script = [
    "import importlib.util as u",
    "need=['scrapling','curl_cffi','patchright']",
    "miss=[m for m in need if u.find_spec(m) is None]",
    "print(','.join(miss))",
  ].join(";");

  const { code, stdout, stderr } = await run(py, ["-c", script]);
  if (code !== 0) {
    return {
      status: "error",
      detail: `依赖检查失败：${(stderr || "").trim().split("\n")[0] || `退出码 ${code}`}`,
      hint: "运行 chictr-mcp-server setup 重新安装依赖",
    };
  }

  const missing = stdout.trim();
  if (missing) {
    return {
      status: "missing",
      detail: `缺少 Python 依赖：${missing}`,
      hint: "运行 chictr-mcp-server setup 自动安装（需要联网）",
    };
  }
  return { status: "ok", detail: "scrapling / curl_cffi / patchright 均已安装" };
}

/**
 * 检查浏览器内核。
 *
 * 关键：**必须验证 revision 是否匹配**，不能只看缓存目录里「有没有东西」。
 * 缓存目录是全局共享的，里面可能有别的 playwright 版本下载的、版本号不同的
 * 内核；只看目录非空会误报「已安装」，而实际启动时会抛
 * "Executable doesn't exist ..."——这正是「开箱即用」最容易翻车的地方。
 *
 * 做法：向 venv 里的解释器问它**自己**期望的 revision（读 playwright 随包
 * 携带的 browsers.json），再确认缓存里那个具体目录存在。
 */
async function probeBrowser(): Promise<CheckResult> {
  const py = venvPython();
  if (!existsSync(py)) {
    return { status: "unknown", detail: "无虚拟环境，跳过浏览器检查" };
  }

  // 让解释器报告「它期望的 revision」+「实际缓存路径」，一次问清。
  //
  // 两个必须注意的坑（都踩过）：
  //   1. browsers.json 里的逻辑名用连字符（chromium-headless-shell），而磁盘
  //      目录名用下划线（chromium_headless_shell-1243）。直接拼名字永远匹配不上。
  //   2. 某些平台/版本下 headless 会直接复用完整版 chromium 目录，此时
  //      headless-shell 目录缺失并不影响启动（已实测验证）。
  // 因此这里不硬编码名字，而是对目录名做归一化后比对。
  const script = [
    "import json,os,sys,pathlib",
    "try:",
    "    import playwright",
    "except Exception:",
    "    print('NO_PLAYWRIGHT'); sys.exit(0)",
    "base=pathlib.Path(playwright.__file__).parent",
    "spec=json.loads((base/'driver'/'package'/'browsers.json').read_text())",
    "if sys.platform=='darwin': root=os.path.join(os.path.expanduser('~'),'Library','Caches','ms-playwright')",
    "elif sys.platform=='win32': root=os.path.join(os.environ.get('LOCALAPPDATA',''),'ms-playwright')",
    "else: root=os.path.join(os.path.expanduser('~'),'.cache','ms-playwright')",
    "want=[(b['name'], str(b['revision'])) for b in spec['browsers'] if 'chromium' in b['name'] and b.get('installByDefault')]",
    "def dirs_for(name, rev):",
    "    cands=[name.replace('-','_'), name.replace('_','-'), name]",
    "    return [os.path.join(root, f'{c}-{rev}') for c in dict.fromkeys(cands)]",
    "present=[n for n,r in want if any(os.path.isdir(d) for d in dirs_for(n,r))]",
    "print('PRESENT:'+','.join(present))",
    "print('ROOT:'+root)",
  ].join("\n");

  const { code, stdout, stderr } = await run(py, ["-c", script]);
  if (code !== 0) {
    return {
      status: "error",
      detail: `浏览器检查失败：${(stderr || "").trim().split("\n")[0] || `退出码 ${code}`}`,
    };
  }

  const out = stdout.trim();
  if (out.startsWith("NO_PLAYWRIGHT")) {
    return {
      status: "missing",
      detail: "Python 环境缺少 playwright（依赖安装不完整）",
      hint: "运行 chictr-mcp-server setup 修复",
    };
  }

  const presentLine = out.split("\n").find((l) => l.startsWith("PRESENT:")) || "";
  const rootLine = out.split("\n").find((l) => l.startsWith("ROOT:")) || "ROOT:";
  const present = presentLine.slice("PRESENT:".length).split(",").filter(Boolean);
  const root = rootLine.slice("ROOT:".length);

  // 只要完整版 chromium 在，就足以启动（实测 headless 也复用它），
  // 因此不把 headless-shell 缺失当作错误。
  if (present.includes("chromium")) {
    return {
      status: "ok",
      detail: `浏览器内核就绪（${present.join("、")} @ ${root}）`,
    };
  }
  return {
    status: "missing",
    detail: "缺少与当前依赖匹配的浏览器内核",
    hint: "运行 chictr-mcp-server setup --browser 下载（约 560MB，需要联网）",
  };
}

/**
 * 检查 sidecar 是否在线（若启用了 sidecar）。
 *
 * 未启用 sidecar 时返回 unknown 而非 missing——「不需要」不等于「缺失」。
 */
async function probeSidecar(): Promise<CheckResult> {
  const enabled = ["1", "true", "yes", "on"].includes(
    (process.env.CHICTR_USE_SIDECAR || "").trim().toLowerCase()
  );
  if (!enabled) {
    return {
      status: "unknown",
      detail: "未启用 sidecar（CHICTR_USE_SIDECAR 未设置）",
    };
  }

  const baseUrl = (process.env.CHICTR_SIDECAR_URL || "http://127.0.0.1:8848").replace(
    /\/+$/,
    ""
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    const payload = (await res.json()) as {
      solver?: { fresh?: boolean; solve_count?: number; age_seconds?: number };
    };
    const solver = payload.solver || {};
    if (solver.fresh) {
      return {
        status: "ok",
        detail: `sidecar 在线，cookie 新鲜（年龄 ${solver.age_seconds ?? "?"}s，过盾 ${solver.solve_count ?? 0} 次）`,
      };
    }
    return {
      status: "ok",
      detail: `sidecar 在线，但 cookie 已失效（过盾 ${solver.solve_count ?? 0} 次）`,
      hint: "下次请求会自动重新过盾；若持续失败请检查 IP 是否被限流",
    };
  } catch {
    return {
      status: "missing",
      detail: `sidecar 不可达（${baseUrl}）`,
      hint: "运行 chictr-mcp-server sidecar 启动它，或设置 CHICTR_USE_SIDECAR=0 走 Playwright",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查 Chromium（Node 侧 Playwright）能否启动。
 *
 * 注意这不启动浏览器，只确认可执行文件存在——启动一次要几秒，
 * 探测不该付这个代价。
 *
 * 打包场景下 node_modules 可能不含 playwright（sidecar 模式根本不需要它），
 * 此时报 "missing" 比抛堆栈更有用：这是**可选**回退路径，不是故障。
 */
async function probePlaywrightBrowser(): Promise<CheckResult> {
  let pw: { chromium?: { executablePath?: () => string } };
  try {
    pw = require_("playwright") as typeof pw;
  } catch {
    return {
      status: "missing",
      detail: "未安装 Node 侧 Playwright（仅回退路径需要，sidecar 模式可忽略）",
    };
  }

  try {
    const exe = pw.chromium?.executablePath?.();
    if (!executablePathExists(exe)) {
      return {
        status: "missing",
        detail: "Node 侧 Playwright 浏览器未安装（仅回退路径需要）",
        hint: "启用 sidecar 时可忽略；如需回退请运行 setup",
      };
    }
    return { status: "ok", detail: "Node 侧 Playwright 浏览器已安装" };
  } catch (err) {
    return {
      status: "missing",
      detail: `Node 侧 Playwright 浏览器不可用：${
        err instanceof Error ? err.message.split("\n")[0] : String(err)
      }`,
    };
  }
}

function executablePathExists(exe: string | undefined): boolean {
  if (!exe) return false;
  try {
    return existsSync(exe);
  } catch {
    return false;
  }
}

/** 检查 Node 版本是否满足 package.json 的 engines 约束。 */
function probeNode(): CheckResult {
  const current = process.versions.node;
  const [major] = current.split(".").map(Number);
  if (major >= 20) {
    return { status: "ok", detail: `Node ${current}` };
  }
  return {
    status: "outdated",
    detail: `Node ${current} 过低（需要 ≥ 20）`,
    hint: "升级 Node.js 后重试",
  };
}

/** 检查 sidecar 脚本是否存在。 */
function probeSidecarScript(): CheckResult {
  const script = sidecarScript();
  if (existsSync(script)) {
    return { status: "ok", detail: "sidecar 脚本已就位" };
  }
  return {
    status: "missing",
    detail: `缺少 sidecar 脚本（${script}）`,
    hint: "安装包不完整；若设置了 CHICTR_HOME 请确认路径正确",
  };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export interface EnvReport {
  /** 项目根目录，便于用户确认探测的是对的安装位置。 */
  root: string;
  platform: string;
  node: CheckResult;
  venv: CheckResult;
  pythonVersion: string | null;
  pythonDeps: CheckResult;
  browser: CheckResult;
  playwrightBrowser: CheckResult;
  sidecarScript: CheckResult;
  sidecar: CheckResult;
  /** 一句话总结：当前最有价值的那个待办（或“一切就绪”）。 */
  summary: string;
  /** 缺失项的修复动作摘要，按优先级排序。 */
  actions: string[];
  /**
   * 能否在当前状态下提供「免浏览器」的检索能力。
   * 这是判断是否必须走自举的关键信号。
   */
  canRunBrowserless: boolean;
}

function summarize(report: Omit<EnvReport, "summary" | "actions">): {
  summary: string;
  actions: string[];
} {
  const actions: string[] = [];

  if (report.node.status !== "ok") {
    actions.push("升级 Node.js 到 20 或更高版本");
  }
  if (report.sidecarScript.status === "missing") {
    actions.push("安装包可能不完整，请联系分发方");
  }

  // 免浏览器路径优先：sidecar 通就用 sidecar，这是最快最省资源的形态。
  if (report.sidecar.status === "ok") {
    return { summary: "sidecar 可用，检索走免浏览器通道（最快）", actions };
  }

  if (report.venv.status !== "ok") {
    actions.push("运行 chictr-mcp-server setup 创建 Python 环境并安装依赖");
  } else if (report.pythonDeps.status !== "ok") {
    actions.push("运行 chictr-mcp-server setup 安装缺失的 Python 依赖（需要联网）");
  } else if (report.browser.status !== "ok") {
    actions.push("运行 chictr-mcp-server setup 下载浏览器内核（约 560MB，需要联网）");
  }
  if (report.sidecar.status === "missing") {
    actions.push("运行 chictr-mcp-server sidecar 启动 sidecar（首次会过一次盾）");
  }

  if (actions.length === 0) {
    return { summary: "环境就绪，但 sidecar 未运行", actions };
  }
  return {
    summary: `环境未就绪，需要 ${actions.length} 项动作`,
    actions,
  };
}

/** 执行一次完整探测。不修改任何磁盘状态。 */
export async function probeEnvironment(): Promise<EnvReport> {
  const [venvProbe, pythonDeps, browser, sidecar] = await Promise.all([
    probeVenv(),
    probePythonDeps(),
    probeBrowser(),
    probeSidecar(),
  ]);
  const playwrightBrowser = await probePlaywrightBrowser();

  const base: Omit<EnvReport, "summary" | "actions"> = {
    root: projectRoot(),
    platform: process.platform,
    node: probeNode(),
    venv: venvProbe.result,
    pythonVersion: venvProbe.version,
    pythonDeps,
    browser,
    playwrightBrowser,
    sidecarScript: probeSidecarScript(),
    sidecar,
    // 免浏览器可用 = venv 与依赖齐备，或 sidecar 已经在跑。
    canRunBrowserless:
      sidecar.status === "ok" ||
      (venvProbe.result.status === "ok" && pythonDeps.status === "ok"),
  };

  const { summary, actions } = summarize(base);
  return { ...base, summary, actions };
}

// ---------------------------------------------------------------------------
// 缓存（供 MCP 工具频繁调用）
// ---------------------------------------------------------------------------

let cached: { at: number; report: EnvReport } | null = null;
let inFlight: Promise<EnvReport> | null = null;

/**
 * 带缓存的探测。
 * @param force 忽略缓存，强制重新探测（setup 完成后调用）。
 */
export async function getEnvReport(force = false): Promise<EnvReport> {
  if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return cached.report;
  }
  // 合并并发调用，避免多个 MCP 工具同时探测时重复起子进程。
  if (!force && inFlight) {
    return inFlight;
  }
  inFlight = probeEnvironment()
    .then((report) => {
      cached = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** 手动清空缓存（bootstrap 改动了环境之后调用）。 */
export function invalidateEnvReport(): void {
  cached = null;
}

/** 供 setup/doctor 展示用的可读渲染。 */
export function formatEnvReport(report: EnvReport): string {
  const icon = (s: CheckStatus): string =>
    s === "ok" ? "✅" : s === "missing" ? "❌" : s === "outdated" ? "⚠️" : s === "error" ? "❌" : "➖";

  const lines: string[] = [
    `项目根目录: ${report.root}`,
    `平台:       ${report.platform}`,
    "",
    `${icon(report.node.status)} Node.js          ${report.node.detail}`,
    `${icon(report.venv.status)} Python venv      ${report.venv.detail}`,
    `${icon(report.pythonDeps.status)} Python 依赖      ${report.pythonDeps.detail}`,
    `${icon(report.browser.status)} 浏览器内核       ${report.browser.detail}`,
    `${icon(report.sidecarScript.status)} sidecar 脚本     ${report.sidecarScript.detail}`,
    `${icon(report.sidecar.status)} sidecar 服务     ${report.sidecar.detail}`,
    `${icon(report.playwrightBrowser.status)} Playwright(回退) ${report.playwrightBrowser.detail}`,
    "",
    `结论: ${report.summary}`,
  ];

  if (report.actions.length > 0) {
    lines.push("", "下一步:");
    report.actions.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  }

  // 把各项 hint 也带上，用户往往需要具体命令而非泛泛建议。
  const hints = [
    report.node,
    report.venv,
    report.pythonDeps,
    report.browser,
    report.sidecar,
  ]
    .map((c) => c.hint)
    .filter((h): h is string => Boolean(h));
  if (hints.length > 0) {
    lines.push("", "提示:");
    for (const h of [...new Set(hints)]) lines.push(`  · ${h}`);
  }

  return lines.join("\n");
}

/** 供内部使用：确认某个路径可写（bootstrap 下载前要检查）。 */
export async function isWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 默认的 ms-playwright 缓存目录（仅用于展示，不用于写入）。 */
export function playwrightCacheDir(): string {
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Caches", "ms-playwright");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || homedir(), "ms-playwright");
  }
  return path.join(homedir(), ".cache", "ms-playwright");
}
