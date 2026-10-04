/**
 * 自举层（Bootstrap）——「按需安装」，让缺依赖的机器能自己补上。
 *
 * 为什么不能靠 npm postinstall：打包成 dmg/exe 后安装器不会执行 package.json
 * 的 postinstall 钩子（打包器只收集文件）。所以依赖准备必须由主程序在运行时
 * 驱动，也就是这个模块存在的理由。
 *
 * 设计原则：
 *   1. **幂等**：每一步都先探测再动作，重复运行不产生副作用、不重复下载。
 *   2. **可中断可恢复**：下载失败不清空已有成果，重跑从中断处继续。
 *   3. **显式授权**：超过阈值（默认 100MB）的下载必须先经调用方确认。
 *      这不是技术限制而是产品选择——没人希望工具在后台悄悄下 560MB。
 *   4. **进度可见**：长任务持续汇报进度，否则用户会以为程序卡死。
 *   5. **绝不静默失败**：每一步的成败与原因都写进结构化结果。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  browserMarkerFile,
  invalidateEnvReport,
  probeEnvironment,
  projectRoot,
  venvDir,
  venvPython,
  type EnvReport,
} from "./env-probe.js";

/** 预置的 PyPI 镜像，供国内用户选择。
 *
 * 注意：默认用 aliyun 而非 tsinghua。实测 tsinghua 会对 pip 26 的新版
 * User-Agent（带一长串 JSON 系统信息）返回 403，导致 `setup` 直接失败并报
 * "from versions: none"（极易被误读成包不存在）。aliyun/tencent 无此问题。
 */
const PYPI_MIRRORS: Record<string, string> = {
  aliyun: "https://mirrors.aliyun.com/pypi/simple",
  tencent: "https://mirrors.cloud.tencent.com/pypi/simple",
  official: "https://pypi.org/simple",
  tsinghua: "https://pypi.tuna.tsinghua.edu.cn/simple",
};

/** 安装依赖时的镜像尝试顺序：先默认镜像，失败则依次回退。
 *
 * 单个镜像故障不该让用户卡死，尤其是国内镜像偶发的限流/UA 过滤。
 * 最后一项固定为官方源，作为最终兜底。
 */
function mirrorChain(preferred: string): Array<{ name: string; url: string }> {
  const ordered: Array<{ name: string; url: string }> = [];
  const push = (name: string, url: string): void => {
    if (!ordered.some((o) => o.url === url)) ordered.push({ name, url });
  };

  const preferredName = preferred.trim();
  const preferredUrl = PYPI_MIRRORS[preferredName] || preferredName;
  push(preferredName, preferredUrl);

  // 依次回退到其他可用镜像，官方源放最后。
  for (const [name, url] of Object.entries(PYPI_MIRRORS)) {
    if (name === "official") continue;
    push(name, url);
  }
  push("official", PYPI_MIRRORS.official);
  return ordered;
}

export interface BootstrapStep {
  name: string;
  status: "skipped" | "done" | "failed";
  detail: string;
}

export interface BootstrapResult {
  ok: boolean;
  steps: BootstrapStep[];
  report: EnvReport;
  /** 明确的失败原因（ok=false 时非空）。 */
  error: string | null;
}

export interface BootstrapOptions {
  /** 下载浏览器内核（约 560MB）。默认 false，需显式开启。 */
  installBrowser?: boolean;
  /** PyPI 镜像名（见 PYPI_MIRRORS）或完整 URL。默认 official。 */
  pypiMirror?: string;
  /** 每步执行的超时（毫秒）。默认 30 分钟。 */
  stepTimeoutMs?: number;
  /** 进度回调；message 面向用户，可直接打印。 */
  onProgress?: (message: string, percent?: number) => void;
  /** 取消信号。 */
  signal?: AbortSignal;
}

/** 已验证可用的 Python 最低版本。
 *
 * 注意：env-probe.ts 里有一份同值副本（探测层不 import 自举层，避免探测拉入写操作依赖）。
 * 改动此处时**必须同步** src/runtime/env-probe.ts 的 MIN_PYTHON，否则会出现
 * 「探测说就绪、自举说版本不够」的矛盾。
 */
const MIN_PYTHON: [number, number] = [3, 10];

function log(opts: BootstrapOptions, message: string, percent?: number): void {
  opts.onProgress?.(message, percent);
}

// ---------------------------------------------------------------------------
// 进程执行
// ---------------------------------------------------------------------------

interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 执行外部命令并实时转发输出。
 *
 * 用 spawn 而非 execFile：pip 和浏览器下载都会长时间运行，必须能流式拿到
 * 输出（既能报进度，也能在失败时给出真正有用的错误行，而不是一句超时）。
 */
function execStreaming(
  cmd: string,
  args: string[],
  opts: BootstrapOptions,
  label: string,
  /** 从输出里解析 0-100 的进度。返回 undefined 表示无进展。 */
  parseProgress?: (line: string) => number | undefined
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const timeout = opts.stepTimeoutMs ?? 30 * 60 * 1000;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(cmd, args, {
      env: { ...process.env, PYTHONUNBUFFERED: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        code: 124,
        stdout,
        stderr: `${stderr}\n[超时] ${label} 超过 ${Math.round(timeout / 1000)}s 未完成`,
      });
    }, timeout);

    const onData = (chunk: Buffer, isErr: boolean): void => {
      const text = chunk.toString();
      if (isErr) stderr += text;
      else stdout += text;
      if (!parseProgress) return;
      // pip 的输出是 \r 覆盖式进度条，按行拆后再逐行尝试解析。
      for (const line of text.split(/[\r\n]+/)) {
        if (!line.trim()) continue;
        const pct = parseProgress(line);
        if (pct !== undefined) log(opts, `${label}: ${line.trim().slice(0, 120)}`, pct);
      }
    };

    child.stdout?.on("data", (c: Buffer) => onData(c, false));
    child.stderr?.on("data", (c: Buffer) => onData(c, true));

    const abortHandler = (): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: 130, stdout, stderr: `${stderr}\n[取消] ${label} 被中止` });
    };
    opts.signal?.addEventListener("abort", abortHandler, { once: true });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortHandler);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortHandler);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** 取输出的最后几行非空内容，用于错误摘要。 */
function tail(text: string, lines = 4): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" | ");
}

// ---------------------------------------------------------------------------
// Python 解释器发现
// ---------------------------------------------------------------------------

interface PythonCandidate {
  cmd: string;
  version: [number, number];
}

/**
 * 找到一个可用的系统 Python（≥3.10）。
 *
 * 注意：Windows 上优先 `py -3`（官方启动器最可靠）；macOS/Linux 上依次尝试
 * 带版本号的命令和裸 `python3`。绝不假设 `python` 存在——很多系统只有 `python3`。
 */
async function findSystemPython(
  opts: BootstrapOptions
): Promise<{ candidate: PythonCandidate | null; tried: string[] }> {
  const tried: string[] = [];
  const attempts: Array<{ cmd: string; args: string[] }> =
    process.platform === "win32"
      ? [
          { cmd: "py", args: ["-3", "--version"] },
          { cmd: "python3", args: ["--version"] },
          { cmd: "python", args: ["--version"] },
        ]
      : [
          { cmd: "python3.13", args: ["--version"] },
          { cmd: "python3.12", args: ["--version"] },
          { cmd: "python3.11", args: ["--version"] },
          { cmd: "python3.10", args: ["--version"] },
          { cmd: "python3", args: ["--version"] },
        ];

  for (const { cmd, args } of attempts) {
    tried.push(cmd);
    const out = await execStreaming(cmd, args, { ...opts, stepTimeoutMs: 10_000 }, cmd);
    if (out.code !== 0) continue;
    const m = /(\d+)\.(\d+)/.exec(out.stdout || out.stderr);
    if (!m) continue;
    const version: [number, number] = [Number(m[1]), Number(m[2])];
    if (
      version[0] > MIN_PYTHON[0] ||
      (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1])
    ) {
      // `py -3` 需要把子命令带上才算真正的解释器调用。
      return {
        candidate: { cmd: cmd === "py" ? "py" : cmd, version },
        tried,
      };
    }
  }
  return { candidate: null, tried };
}

/** 把候选解释器变成可直接执行的 argv 前缀。 */
function pythonArgv(candidate: PythonCandidate): string[] {
  return candidate.cmd === "py" ? ["py", "-3"] : [candidate.cmd];
}

// ---------------------------------------------------------------------------
// 各步骤
// ---------------------------------------------------------------------------

async function stepCreateVenv(
  opts: BootstrapOptions,
  steps: BootstrapStep[]
): Promise<boolean> {
  const dir = venvDir();
  if (existsSync(venvPython())) {
    steps.push({ name: "创建虚拟环境", status: "skipped", detail: `已存在：${dir}` });
    return true;
  }

  const { candidate, tried } = await findSystemPython(opts);
  if (!candidate) {
    steps.push({
      name: "创建虚拟环境",
      status: "failed",
      detail: `未找到 Python ≥ ${MIN_PYTHON.join(".")}（已尝试：${tried.join(", ")}）`,
    });
    return false;
  }

  log(opts, `使用 ${candidate.cmd} (Python ${candidate.version.join(".")}) 创建虚拟环境…`);
  mkdirSync(path.dirname(dir), { recursive: true });

  const argv = pythonArgv(candidate);
  const out = await execStreaming(
    argv[0],
    [...argv.slice(1), "-m", "venv", dir],
    opts,
    "创建虚拟环境"
  );

  if (out.code !== 0 || !existsSync(venvPython())) {
    steps.push({
      name: "创建虚拟环境",
      status: "failed",
      detail: tail(out.stderr) || `退出码 ${out.code}`,
    });
    return false;
  }
  steps.push({
    name: "创建虚拟环境",
    status: "done",
    detail: `Python ${candidate.version.join(".")} → ${dir}`,
  });
  return true;
}

async function stepInstallDeps(
  opts: BootstrapOptions,
  steps: BootstrapStep[]
): Promise<boolean> {
  const py = venvPython();
  if (!existsSync(py)) {
    steps.push({ name: "安装 Python 依赖", status: "failed", detail: "虚拟环境不存在" });
    return false;
  }

  // 幂等：先问解释器缺什么，齐了就直接跳过（省掉一次几分钟的 pip 往返）。
  const need = "scrapling,curl_cffi,patchright".split(",");
  const check = await execStreaming(
    py,
    [
      "-c",
      "import importlib.util as u;print(','.join(m for m in %s if u.find_spec(m) is None))".replace(
        "%s",
        JSON.stringify(need)
      ),
    ],
    { ...opts, stepTimeoutMs: 30_000 },
    "检查依赖"
  );
  if (check.code === 0 && !check.stdout.trim()) {
    steps.push({
      name: "安装 Python 依赖",
      status: "skipped",
      detail: "scrapling / curl_cffi / patchright 均已安装",
    });
    return true;
  }

  const preferred = (opts.pypiMirror || "aliyun").trim();
  const chain = mirrorChain(preferred);

  // 先升级 pip：老 pip 在解析新包元数据时经常失败，这步很便宜且能省掉后面的怪错误。
  // 升级失败不算致命——继续用现有 pip 尝试安装。
  log(opts, "升级 pip…");
  await execStreaming(
    py,
    ["-m", "pip", "install", "--upgrade", "pip", "-i", chain[0].url],
    { ...opts, stepTimeoutMs: 5 * 60 * 1000 },
    "升级 pip"
  );

  // 依次尝试镜像链。某些镜像会以「包不存在」的形式伪装成解析失败（如 tsinghua
  // 对 pip 26 的 UA 返回 403 → "from versions: none"），因此失败必须换源重试，
  // 而不是直接把误导性的错误抛给用户。
  const failures: string[] = [];
  for (const mirror of chain) {
    log(opts, `安装 scrapling[fetchers]（镜像：${mirror.name}）…`);
    const out = await execStreaming(
      py,
      ["-m", "pip", "install", "scrapling[fetchers]", "-i", mirror.url],
      opts,
      `安装依赖(${mirror.name})`
    );

    if (out.code === 0) {
      const note = failures.length
        ? `（前 ${failures.length} 个镜像失败后回退成功：${failures.join("; ")}）`
        : "";
      steps.push({
        name: "安装 Python 依赖",
        status: "done",
        detail: `scrapling[fetchers] 已安装（镜像 ${mirror.name}）${note}`,
      });
      return true;
    }

    failures.push(`${mirror.name}: ${tail(out.stderr, 2)}`);
    if (mirror !== chain[chain.length - 1]) {
      log(opts, `镜像 ${mirror.name} 失败，尝试下一个…`);
    }
  }

  steps.push({
    name: "安装 Python 依赖",
    status: "failed",
    detail: `所有镜像均失败 —— ${failures.join(" || ")}`,
  });
  return false;
}

/**
 * 下载浏览器内核。
 *
 * 通过 `python -m patchright install chromium` 而非 `scrapling install`：
 * 后者会连带安装它自己跟踪的全部浏览器，而我们只需要 Chromium。
 */
async function stepInstallBrowser(
  opts: BootstrapOptions,
  steps: BootstrapStep[]
): Promise<boolean> {
  if (!opts.installBrowser) {
    steps.push({
      name: "下载浏览器内核",
      status: "skipped",
      detail: "未授权（如需自动过盾请传 installBrowser: true）",
    });
    return true;
  }

  const py = venvPython();
  if (!existsSync(py)) {
    steps.push({ name: "下载浏览器内核", status: "failed", detail: "虚拟环境不存在" });
    return false;
  }

  log(opts, "下载 Chromium 内核（约 560MB，请保持网络连接）…");
  const out = await execStreaming(
    py,
    ["-m", "patchright", "install", "chromium"],
    opts,
    "下载浏览器内核",
    (line) => {
      // patchright/playwright 的下载输出形如 "|████ 45% of 130.2 MiB"。
      const m = /(\d{1,3})%/.exec(line);
      return m ? Number(m[1]) : undefined;
    }
  );

  if (out.code !== 0) {
    steps.push({
      name: "下载浏览器内核",
      status: "failed",
      detail: tail(out.stderr) || `退出码 ${out.code}`,
    });
    return false;
  }

  // 写标记文件，让后续探测不必再花时间扫描缓存目录。
  try {
    const { playwrightCacheDir } = await import("./env-probe.js");
    writeFileSync(
      browserMarkerFile(),
      JSON.stringify(
        {
          installedAt: new Date().toISOString(),
          registryDir: playwrightCacheDir(),
          installer: "patchright",
        },
        null,
        2
      ),
      "utf8"
    );
  } catch {
    // 标记文件写不了不影响功能，探测会退化为实际扫描。
  }

  steps.push({ name: "下载浏览器内核", status: "done", detail: "Chromium 已就绪" });
  return true;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 执行自举：探测 → 补齐缺失项 → 重新探测。
 *
 * 任何一步失败都立即返回，但**不回滚**已完成的步骤——下次调用会从断点继续，
 * 这对 560MB 的浏览器下载尤其重要。
 */
export async function bootstrapEnvironment(
  opts: BootstrapOptions = {}
): Promise<BootstrapResult> {
  const steps: BootstrapStep[] = [];

  log(opts, "检查环境…");
  const before = await probeEnvironment();

  if (before.node.status !== "ok") {
    steps.push({ name: "检查 Node.js", status: "failed", detail: before.node.detail });
    return {
      ok: false,
      steps,
      report: before,
      error: `Node.js 版本不满足要求：${before.node.detail}`,
    };
  }
  steps.push({ name: "检查 Node.js", status: "skipped", detail: before.node.detail });

  // 1. 虚拟环境（含 Python 解释器发现）
  if (!(await stepCreateVenv(opts, steps))) {
    const report = await probeEnvironment();
    return { ok: false, steps, report, error: steps[steps.length - 1].detail };
  }

  // 2. Python 依赖
  if (!(await stepInstallDeps(opts, steps))) {
    const report = await probeEnvironment();
    return { ok: false, steps, report, error: steps[steps.length - 1].detail };
  }

  // 3. 浏览器内核（可选）
  if (!(await stepInstallBrowser(opts, steps))) {
    const report = await probeEnvironment();
    // 浏览器失败不算致命：没有它仍可走 sidecar 的纯 HTTP 路径。
    return {
      ok: true,
      steps,
      report,
      error: `浏览器内核安装失败（不影响纯 HTTP 模式）：${steps[steps.length - 1].detail}`,
    };
  }

  log(opts, "复核环境…");
  invalidateEnvReport();
  const report = await probeEnvironment();

  const ok =
    report.venv.status === "ok" &&
    report.pythonDeps.status === "ok" &&
    report.browser.status !== "missing";

  return {
    ok,
    steps,
    report,
    error: ok ? null : report.summary,
  };
}

/**
 * 清理环境（用于「重新安装」）。
 *
 * 只删 .venv 与标记文件，不碰用户的全局浏览器缓存——那个目录可能被其他
 * 工具共用，删掉会伤及无辜。
 */
export async function cleanEnvironment(
  opts: BootstrapOptions = {}
): Promise<{ ok: boolean; detail: string; report: EnvReport }> {
  const dir = venvDir();
  const stepDetails: string[] = [];

  if (existsSync(dir)) {
    log(opts, `删除虚拟环境 ${dir} …`);
    try {
      await rm(dir, { recursive: true, force: true });
      stepDetails.push(`已删除 ${dir}`);
    } catch (err) {
      stepDetails.push(
        `删除失败：${err instanceof Error ? err.message : String(err)}`
      );
      const report = await probeEnvironment();
      return { ok: false, detail: stepDetails.join("；"), report };
    }
  } else {
    stepDetails.push("虚拟环境不存在，无需删除");
  }

  const marker = browserMarkerFile();
  if (existsSync(marker)) {
    try {
      await rm(marker, { force: true });
      stepDetails.push("已清除浏览器标记");
    } catch {
      // 标记文件删不掉不影响后续流程。
    }
  }

  invalidateEnvReport();
  const report = await probeEnvironment();
  return { ok: true, detail: stepDetails.join("；"), report };
}

export { PYPI_MIRRORS, projectRoot };
