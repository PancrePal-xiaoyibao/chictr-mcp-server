# 首次启动自动部署、环境检查与激活

本文件回答一个问题：**用户双击 dmg / exe 装完这个 app 之后，第一次启动时怎么自动把依赖装好、把环境查清楚、把服务激活起来。**

面向两类读者：

| 读者 | 关心什么 | 建议先读 |
|---|---|---|
| ① 要把本项目打进 dmg/exe 的开发者 | 打包时该放什么、不该放什么；安装器该调什么 | 二、三、七节 |
| ② 要写自动激活逻辑的集成方 | 用哪个 API、看哪个退出码、怎么起 sidecar | 三、四、五、六节 |

---

## 一、为什么必须做运行时自举

**核心事实**：打包成 dmg/exe 后，安装器**不会**执行 `package.json` 的 `postinstall` 钩子。打包器只收集文件，生命周期脚本是被丢掉的。

因此所有依赖准备都必须由**主程序在运行时自己驱动**。这就是 `src/runtime/env-probe.ts`（探测）和 `src/runtime/bootstrap.ts`（自举）存在的原因。

`package.json` 里确实还留着 `postinstall` 脚本，但它的定位已经降级为「npm 场景下的温和引导」——`cmdPostinstall()` 里明确写了不下载任何大文件，只检查并打印提示，且用 `try/catch` 包住，**永远不能让安装失败**。

### 为什么不能「一个安装包全搞定」

实测体积：

| 项目 | 大小 |
|---|---|
| `.venv`（Python 依赖） | 325 MB（playwright 134M + patchright 134M） |
| `~/Library/Caches/ms-playwright`（浏览器内核） | 557 MB |
| `node_modules` | 数百 MB |
| **合计** | **≈ 1 GB** |

而且有**两套 Chromium 内核**：Node 侧 playwright 要 `chromium-1234`，Python 侧 patchright 要 `chromium-1243`。塞进一个安装包既臃肿又互相冲突。

**推荐形态**：Node 侧（几十 MB）随包分发，Python 侧按需自举。

```
你的 App.app / your-app.exe
├── node_modules/             # Node 依赖，打包器收集
├── sidecar/chictr_sidecar.py # 随包分发（package.json 的 files 已含 "sidecar"）
├── dist/                     # 编译产物
└── （首次启动后创建）
    └── .venv/                # 325MB，由 setup 创建
```

---

## 二、三个名词，先对齐

| 名词 | 是什么 | 作用 |
|---|---|---|
| **Scrapling** | 第三方 Python 爬虫库 | 零件 |
| **curl_cffi / patchright** | Scrapling 捆绑的底层库 | **真正解决阿里盾 405 的是它们** |
| **sidecar** | 我们的 `sidecar/chictr_sidecar.py`，用 Scrapling 提供 HTTP 服务 | 成品 |

- **curl_cffi** —— 伪装 TLS 指纹（JA3/JA4），让请求看起来像真 Chrome。
- **patchright** —— Chromium 反自动化补丁，用于过一次性的 JS 挑战、取回 `acw_sc__v2` cookie。

拿到 cookie 后，后续请求只是普通 HTTP 带上 cookie，约 1.5s/页。

---

## 三、命令与退出码（安装器靠这个判断）

```bash
chictr-mcp-server doctor               # 体检，只读不动磁盘
chictr-mcp-server setup [选项]          # 补齐缺失依赖（幂等，可重复运行）
chictr-mcp-server clean [--yes]        # 删除虚拟环境以便重装
chictr-mcp-server sidecar              # 前台启动 sidecar（含 --warmup）
```

### setup 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `--browser` | 关 | 同时下载浏览器内核（约 560MB，需联网） |
| `--mirror=<名称\|URL>` | `aliyun` | PyPI 镜像：`aliyun` / `tencent` / `official` / `tsinghua` |
| `--timeout=<秒>` | 1800 | 单步超时 |

### 退出码约定（**勿随意改动**）

| 码 | 含义 | 调用方应对 |
|---|---|---|
| `0` | 环境就绪 / 操作成功 | 继续，进入激活 |
| `1` | 未就绪，需要用户动作 | 提示用户跑 `setup`，或自动触发自举 |
| `2` | 自举失败（网络、磁盘、权限） | 展示错误，允许重试 |

`doctor` 判定「就绪」的条件（`cmdDoctor()`）：

```ts
const ready =
  report.sidecar.status === "ok" ||
  (report.venv.status === "ok" &&
    report.pythonDeps.status === "ok" &&
    report.browser.status === "ok");
```

即：**sidecar 在线**，或者**三条本地依赖全齐**，任一满足即为就绪。注意 sidecar 在线时不需要本地浏览器内核——这是最快最省资源的形态。

---

## 四、环境变量总表

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHICTR_HOME` | 自动推断 | 项目根目录。打包后位置非常规时**必须设** |
| `CHICTR_VENV` | `<root>/.venv` | 虚拟环境目录 |
| `CHICTR_USE_SIDECAR` | 未设置（关闭） | 设为 `1`/`true`/`yes`/`on` 启用 HTTP 路径 |
| `CHICTR_SIDECAR_URL` | `http://127.0.0.1:8848` | sidecar 地址（尾部斜杠会被剥掉） |
| `CHICTR_SIDECAR_TIMEOUT_MS` | `30000` | sidecar 请求超时；非法值回退 30000 |

**只读安装目录的处理**：`.venv` 默认建在 `<项目根>/.venv`。macOS 的 `/Applications`、Windows 的 `Program Files` 通常只读，此时必须把 `CHICTR_HOME` 指向可写目录：

```bash
export CHICTR_HOME="$HOME/Library/Application Support/chictr"
```

`projectRoot()` 的解析顺序：先看 `CHICTR_HOME`；否则从 `dist/runtime/env-probe.js`（或 `src/runtime/env-probe.ts`）回溯两级/一级，用「有 `package.json`、有 `sidecar/`、且 package 名为 `chictr-mcp-server`」打分选最优。打分逻辑是：

```ts
return { ok: true, score: name === "chictr-mcp-server" ? 2 : 1 };
```

---

## 五、层次一：启动时体检（已实现，零配置）

`src/index.ts` 的 `main()` 在 `server.connect()` **之前**调用：

```ts
void reportEnvironmentOnBoot();   // 注意 void，不 await
```

三条硬约束：

1. **只写 stderr**。stdout 是 MCP 协议通道，写进去会破坏协议。
2. **永不阻塞启动**。用 `void` 触发，不 await，服务照常连接。
3. **永不抛异常**。整个函数体被 `try { ... } catch {}` 包住，注释写得很直白：`体检本身失败绝不能影响服务启动。`

未就绪时的 stderr 提示：

```
[chictr-mcp-server] 环境未就绪：未找到 Python 虚拟环境
                  运行 "chictr-mcp-server setup" 自动修复，或调用环境诊断工具查看详情。
```

启用了 sidecar 但它不可达时：

```
[chictr-mcp-server] sidecar 不可达（sidecar 不可达（http://127.0.0.1:8848））。将回退到 Playwright 路径；如需启动运行 "chictr-mcp-server sidecar"。
```

体检走 `getEnvReport()`，带 **30 秒 TTL 缓存**，所以启动时那一次通常几百毫秒内完成，不拖慢启动。

---

## 六、层次二：集成方如何驱动自动激活

### 6.1 用退出码驱动 UI（推荐给安装器 / 首启向导）

```ts
import { spawn } from "node:child_process";

type SetupOutcome = "ready" | "needs_user_action" | "bootstrap_failed";

function runCli(args: string[], timeoutMs = 35 * 60 * 1000): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    // 实时把进度转给 UI：pip / 下载都是长任务，不给反馈用户会以为卡死
    child.stdout.on("data", (c: Buffer) => onProgress(c.toString()));
    child.stderr.on("data", (c: Buffer) => onProgress(c.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(124);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(127);
    });
  });
}

async function activate(): Promise<SetupOutcome> {
  // 1) 先体检：只读，快，能直接算出「缺什么」
  if ((await runCli(["doctor"])) === 0) return "ready";

  // 2) 未就绪 → 自举。幂等，已装的东西不会重装
  const code = await runCli(["setup"], 35 * 60 * 1000);
  if (code === 0) return "ready";
  return code === 2 ? "bootstrap_failed" : "needs_user_action";
}
```

**不要自己判断缺什么再拼参数**——`setup` 内部已经做了探测，重复运行安全（见 6.3）。

### 6.2 直接调 `bootstrapEnvironment()`（跳过 CLI 进程）

```ts
import {
  bootstrapEnvironment,
  cleanEnvironment,
  type BootstrapResult,
} from "chictr-mcp-server/dist/runtime/bootstrap.js";

const result: BootstrapResult = await bootstrapEnvironment({
  // 约 560MB，必须显式授权；不传就是跳过
  installBrowser: false,
  // 镜像名（aliyun/tencent/official/tsinghua）或完整 URL
  pypiMirror: "aliyun",
  // 单步超时，默认 30 分钟
  stepTimeoutMs: 30 * 60 * 1000,
  // 进度回调：message 面向用户可直接展示，percent 可能为 undefined
  onProgress: (message, percent) => {
    ui.setStatus(percent !== undefined ? `${message} (${percent}%)` : message);
  },
  // 取消信号
  signal: abortController.signal,
});

if (!result.ok) {
  ui.showError(result.error);       // ok=false 时 error 非空
} else if (result.error) {
  ui.showWarning(result.error);     // ok=true 但带警告（见下）
}

for (const step of result.steps) {
  console.log(step.status, step.name, step.detail); // done | skipped | failed
}
console.log(result.report.summary, result.report.actions);
```

**一个容易踩的语义**：浏览器内核安装失败时，`bootstrapEnvironment()` 返回 `ok: true` 但 `error` 非空（浏览器是可选路径，纯 HTTP 模式不需要它）：

```ts
return {
  ok: true,
  steps,
  report,
  error: `浏览器内核安装失败（不影响纯 HTTP 模式）：${steps[steps.length - 1].detail}`,
};
```

CLI 对这个情况的处理是打 `⚠️` 但仍返回退出码 `0`。集成方也必须这样处理，否则会把「可选能力缺失」误报成「环境不可用」。

### 6.3 幂等与断点续跑

`bootstrapEnvironment()` 每一步都**先探测再动作**，且**任何一步失败都不回滚**已完成步骤：

| 步骤 | 幂等策略 |
|---|---|
| 检查 Node.js | 版本不满足直接返回失败，不做任何修改 |
| 创建虚拟环境 | `existsSync(venvPython())` 为真则 `skipped` |
| 安装 Python 依赖 | 先用 `importlib.util.find_spec` 问缺什么，全齐则 `skipped`（省掉几分钟 pip 往返） |
| 下载浏览器内核 | 未授权或已就绪则 `skipped` |

「不回滚」对 560MB 的浏览器下载尤其重要：断网中断后重跑会从断点继续，而不是从头再来。

`cleanEnvironment()` 只删 `.venv` 和标记文件 `.chictr-browser.json`，**不碰全局浏览器缓存**——那个目录可能被其他工具共用。

---

## 七、镜像回退链（实测踩出来的坑）

### 默认镜像是阿里云，不是清华

```ts
const PYPI_MIRRORS: Record<string, string> = {
  aliyun:   "https://mirrors.aliyun.com/pypi/simple",
  tencent:  "https://mirrors.cloud.tencent.com/pypi/simple",
  official: "https://pypi.org/simple",
  tsinghua: "https://pypi.tuna.tsinghua.edu.cn/simple",
};
```

清华镜像对 **pip 26 的新版 User-Agent**（带一长串 JSON 系统信息）返回 **403**：

```
pip/26.1.2 {"ci":null,"cpu":"arm64","distro":{...},...}   → 清华 403
pip/26.1.2                                                 → 清华 200
任意 UA                                                    → 阿里云/腾讯 200
```

403 会让 pip 报出**极具误导性**的错误，看起来像「这个包不存在」：

```
ERROR: Could not find a version that satisfies the requirement scrapling[fetchers]
       (from versions: none)
```

### 回退顺序

`mirrorChain(preferred)` 生成的实际顺序是：**首选镜像 → aliyun → tencent → tsinghua → official**（带 URL 去重，official 固定最后）。

`stepInstallDeps()` 逐项尝试，任一成功即返回，并在 `detail` 里明确报告回退过程：

```
✅ 安装 Python 依赖: scrapling[fetchers] 已安装（镜像 aliyun）
   （前 1 个镜像失败后回退成功：tsinghua: ERROR: Could not find a version ...）
```

全部失败时的 `detail` 形如 `所有镜像均失败 —— tsinghua: ... || aliyun: ... || ...`。

失败换源而不是把第一个错误抛给用户——这是刻意的，因为上面那个 403 伪装成「包不存在」的错误会把人引到完全错误的排查方向。

### 顺带升级 pip

装依赖前先跑 `pip install --upgrade pip -i <首选镜像>`。老 pip 解析新包元数据经常失败。**这步失败不算致命**，继续用现有 pip 尝试安装（`await` 了但没检查返回值）。

---

## 八、浏览器内核：刻意不静默下载

下载量约 **560MB**（`stepInstallBrowser` 里的提示原文是「约 560MB」），`doctor` 的 hint 也写「约 560MB」。因此：

```ts
if (!opts.installBrowser) {
  steps.push({
    name: "下载浏览器内核",
    status: "skipped",
    detail: "未授权（如需自动过盾请传 installBrowser: true）",
  });
  return true;   // 注意是 true：跳过不是失败
}
```

三条授权路径，三者等价：

| 入口 | 写法 |
|---|---|
| CLI | `chictr-mcp-server setup --browser` |
| 代码 | `bootstrapEnvironment({ installBrowser: true })` |
| 提示 | `doctor` 在缺内核时给出 hint：「运行 chictr-mcp-server setup --browser 下载（约 560MB，需要联网）」 |

**这不是技术限制而是产品选择**：没人希望工具在后台悄悄下 560MB，在 CI 里更糟。

### 用的是 patchright 而不是 scrapling install

```ts
const out = await execStreaming(py, ["-m", "patchright", "install", "chromium"], ...);
```

`scrapling install` 会连带装它自己跟踪的**全部**浏览器，而我们只要 Chromium。

下载进度从输出里按 `/(\d{1,3})%/` 解析（patchright/playwright 的输出形如 `|████ 45% of 130.2 MiB`）。

成功后写标记文件 `<root>/.chictr-browser.json`：

```json
{
  "installedAt": "2026-...",
  "registryDir": "/Users/.../Library/Caches/ms-playwright",
  "installer": "patchright"
}
```

**写不了也不影响功能**，只是探测会退化为实际扫描缓存目录。

---

## 九、探测层的关键设计（写集成逻辑前必须知道）

`src/runtime/env-probe.ts` **绝不修改磁盘、绝不触发下载**，可以在任意时刻安全调用（包括 MCP 工具里做诊断）。

| 设计点 | 值 / 行为 | 理由 |
|---|---|---|
| 缓存 TTL | `PROBE_TTL_MS = 30_000` | MCP 工具可能被频繁调用，探测要起子进程，不便宜 |
| 子进程超时 | `PROBE_TIMEOUT_MS = 8_000` | 探测不该拖慢启动 |
| 并发合并 | `inFlight` Promise 复用 | 多个工具同时探测不重复起子进程 |
| 最低 Python | `MIN_PYTHON = [3, 10]` | scrapling 要求 3.10+（注：该常量在 env-probe.ts 和 bootstrap.ts 里各定义了一次） |
| 手动失效 | `invalidateEnvReport()` | bootstrap 改完环境后调用 |

### 浏览器内核检查为什么要比对 revision

**不能只看缓存目录里「有没有东西」**。缓存目录是全局共享的，里面可能有别的 playwright 版本下的、版本号不同的内核；只看目录非空会误报「已安装」，实际启动时抛 `Executable doesn't exist ...`。这是「开箱即用」最容易翻车的地方。

做法是让 venv 里的解释器读它**自己**随包携带的 `browsers.json`，报告期望的 revision，再确认缓存里那个具体目录存在。两个已踩过的坑写在注释里：

1. `browsers.json` 里的逻辑名用连字符（`chromium-headless-shell`），磁盘目录名用下划线（`chromium_headless_shell-1243`）。直接拼名字永远匹配不上，所以要对目录名做归一化后比对。
2. 某些平台/版本下 headless 会**直接复用完整版 chromium 目录**，此时 headless-shell 目录缺失并不影响启动（实测验证）。因此判定只看完整版：

```ts
if (present.includes("chromium")) { /* ok */ }
```

### 依赖检查为什么用 find_spec 而不用 pip show

`importlib.util.find_spec` 不产生网络/索引开销，且在 **pip 本身损坏时仍能工作**。

### `sidecar` 状态用 `unknown` 而不是 `missing`

未启用 sidecar 时返回 `status: "unknown"`，注释写得很清楚：**「不需要」不等于「缺失」**。集成方做 UI 展示时不要把 `unknown` 渲染成红色错误。

---

## 十、激活：从「环境就绪」到「服务真正在跑」

**环境就绪 ≠ 服务激活**。就绪只是描述磁盘状态；激活是让 MCP 服务走上网关最短的那条路径。分两步。

### 10.1 启动 sidecar

```bash
chictr-mcp-server sidecar
```

`cmdSidecar()` 的行为：

1. 先检查 `venvPython()` 与 `sidecarScript()` 是否存在，缺任一直接返回退出码 **2**（不是 1——这是明确错误，不是「等用户动作」）。
2. 用 `<venv python> <sidecar 脚本> --warmup [透传的 -- 参数]` 起**前台**子进程，`stdio: "inherit"`。
3. 转发 `SIGINT` / `SIGTERM` 给子进程，所以 Ctrl+C 能干净退出。

`--warmup` 的含义是**启动时先过一次挑战**（过盾），这样第一个真实请求不用等。

sidecar 自身支持的参数（`sidecar/chictr_sidecar.py` 的 argparse）：

| 参数 | 默认 | 环境变量回退 |
|---|---|---|
| `--host` | `127.0.0.1` | `CHICTR_SIDECAR_HOST` |
| `--port` | `8848` | `CHICTR_SIDECAR_PORT` |
| `--warmup` | 关 | — |
| `--log-level` | `INFO` | `CHICTR_SIDECAR_LOG` |

`chictr-mcp-server sidecar` 会把额外以 `--` 开头的参数透传下去：

```bash
chictr-mcp-server sidecar --port=9000 --log-level=DEBUG
```

### 10.2 让 MCP 服务走 HTTP 路径

```bash
export CHICTR_USE_SIDECAR=1
chictr-mcp-server --transport=stdio
```

`isSidecarEnabled()` 的判定（`src/runtime/sidecar-client.ts:44`）：

```ts
const raw = (process.env.CHICTR_USE_SIDECAR || "").trim().toLowerCase();
return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
```

**默认关闭**是刻意的——保证不改变现有 Playwright 路径的默认行为。

调用链（`src/services/search.ts:46`、`src/services/detail.ts:144`）：启用后先走 sidecar，**任何失败都静默回退到 Playwright，不改变对外契约**。

```
isSidecarEnabled() === true
  → searchTrialsViaSidecar(...)
      ├─ 成功 → 写缓存 + challengeDetector.recordSuccess() → 返回（无需浏览器）
      └─ 失败/超时 → 落到 browserManager.withPage(...) Playwright 路径
```

sidecar 调用的超时是 `CHICTR_SIDECAR_TIMEOUT_MS`（默认 30s），失败时 `callSidecar()` 返回 `null` 并记录 `lastError` / `lastAvailability`，由调用方决定回退。设计原则第 3 条：「sidecar 不可达时快速失败（短超时），不拖慢整体流程」。

### 10.3 验证 sidecar 活着

```bash
curl http://127.0.0.1:8848/health
# {"ok": true, "solver": {"fresh": true, "solve_count": 1, ...}}
```

`probeSidecar()` 读的就是这个端点，判定逻辑：

| `/health` 返回 | 探测结论 |
|---|---|
| `solver.fresh === true` | `ok` — sidecar 在线，cookie 新鲜（detail 含年龄与过盾次数） |
| `solver.fresh === false` | `ok` — 在线但 cookie 已失效；hint 说下次请求会自动重新过盾 |
| 连不上 / 3 秒超时 | `missing` — hint 提示启动 sidecar 或设 `CHICTR_USE_SIDECAR=0` 走 Playwright |

注意探测超时是固定的 **3000ms**（硬编码），与 `CHICTR_SIDECAR_TIMEOUT_MS` 无关。

### 10.4 让 AI 客户端自己读懂环境

MCP 工具 **`check_environment`**（`src/index.ts:116`）返回**可读文本 + 结构化 JSON** 两部分：

```json
{
  "ready": true,
  "summary": "sidecar 可用，检索走免浏览器通道（最快）",
  "actions": [],
  "root": "/Applications/ChiCTR.app/Contents/Resources",
  "checks": {
    "node":               { "status": "ok",      "detail": "Node 20.x.x" },
    "venv":               { "status": "ok",      "detail": "Python 3.13.14" },
    "python_deps":        { "status": "ok",      "detail": "scrapling / curl_cffi / patchright 均已安装" },
    "browser":            { "status": "ok",      "detail": "浏览器内核就绪（chromium @ ...）" },
    "sidecar_script":     { "status": "ok",      "detail": "sidecar 脚本已就位" },
    "sidecar":            { "status": "ok",      "detail": "sidecar 在线，cookie 新鲜（年龄 12s，过盾 1 次）" },
    "playwright_fallback":{ "status": "missing", "detail": "未安装 Node 侧 Playwright（仅回退路径需要，sidecar 模式可忽略）" }
  }
}
```

- `refresh: true` 参数可忽略 30 秒缓存强制重探。
- `ready` 的判定是 `report.canRunBrowserless || report.sidecar.status === "ok"`。
- `status` 有五种取值：`ok` / `missing` / `outdated` / `error` / `unknown`。**`unknown` 不是错误**。
- 文本部分由 `formatEnvReport()` 渲染，带 ✅❌⚠️➖ 图标、结论、按优先级排序的「下一步」、以及去重后的「提示」。

这样 AI 读完就知道该让用户做什么，或者自己调 `setup`。

---

## 十一、打包检查清单

给要把本项目打进 dmg/exe 的开发者：

- [ ] `sidecar/chictr_sidecar.py` 必须随包分发（`package.json` 的 `files` 已含 `"sidecar"`），否则体检报「安装包可能不完整，请联系分发方」。
- [ ] **不要**把 `.venv` 或浏览器缓存打进包——那会让 dmg 膨胀到 1GB+。
- [ ] 安装目录只读时，首启前先设 `CHICTR_HOME` 指向 `~/Library/Application Support/<your-app>` 或 `%APPDATA%\<your-app>`。`isWritable()` 可用于校验。
- [ ] 首启向导用 `doctor` 的退出码驱动 UI：`0` 直接进激活，`1` 调 `setup`，`2` 展示错误并允许重试。
- [ ] `setup` 是长任务（首次 40s ~ 3min），**必须**给进度反馈，否则用户会强杀。
- [ ] 把 `setup` 的 stdout/stderr 转发到 UI 日志区——失败时用户需要看到真实错误行。
- [ ] 560MB 的浏览器下载必须**用户点确认后才触发**，不要塞进首启默认流程。
- [ ] 不要往 stdout 写任何日志（那是 MCP 协议通道），要写就写 stderr。

---

## 十二、验证与排障

**确认环境就绪**：

```bash
chictr-mcp-server doctor          # 全部 ✅，退出码 0
```

**常见症状对照**：

| 症状 | 原因 | 处理 |
|---|---|---|
| `from versions: none` | 镜像 403（见第七节） | 已自动回退；或 `setup --mirror=aliyun` |
| `Executable doesn't exist at .../chromium-1234` | Node 侧 playwright 内核缺失 | 走 sidecar 路径可忽略；否则 `npx playwright install chromium` |
| 体检报 venv missing 但目录存在 | venv 损坏 | `setup` 会检测重建；或 `clean --yes` 后重来 |
| sidecar 启动后一直不 ready | 过盾失败（网络/被限流） | 看 sidecar 日志；确认能访问 ChiCTR |
| `ERROR: No Cloudflare challenge found.` | **正常噪声** | ChiCTR 用阿里盾不是 CF，可忽略 |
| 首启提示缺 Python | 系统无 Python ≥ 3.10 | 体检无法自动解决这一项，需引导用户先装 Python |

最后一条专门说明：`ERROR: No Cloudflare challenge found.` 每次过盾都会出现，它是 scrapling 尝试找 Cloudflare 挑战没找到而打印的，**不代表失败**。真正的成功标志是紧接着的 `INFO chictr_sidecar: 过盾成功，耗时 X.Xs`。

**如果没有 Python**：`doctor` 会报 `venv: missing`。这是 `setup` **唯一无法自动解决的依赖**——需要用户先装 Python。

---

## 十三、实测记录

为验证流程真实可用，构造了一个「什么都没有」的隔离目录：只有 `package.json` + `dist/` + `sidecar/chictr_sidecar.py`，共 **592 KB**，无 venv、无 node_modules。

| 步骤 | 结果 |
|---|---|
| `doctor` | ✅ 正确报未就绪，退出码 1，给出 actions |
| `setup --mirror=tsinghua` | ✅ 清华失败 → **自动回退阿里云成功**（2m35s） |
| `doctor` | ✅ 全部就绪（venv 3.13.14 / 依赖 / 浏览器内核 / 脚本） |
| 启动 sidecar | ✅ 过盾成功 **6.7s** |
| 真实搜索「胰腺癌」 | ✅ `total 469` / `total_pages 47` / 返回 10 条 |
| MCP 工具 `check_environment` | ✅ 22ms（缓存命中） |

样例数据：

```
ChiCTR2600133371  阿得贝利单抗联合NALIRIFOX用于可切除胰腺癌新辅助治疗
ChiCTR2600133365  转移性胰腺癌的多模态识别
ChiCTR2600133048  动脉灌注化疗栓塞联合双免疫检查点抑制剂一线治疗胰腺癌肝转移
```

即：**一台干净机器上，592KB 的包 + 一条 `setup` 命令 = 可用**。

---

## 十四、已知缺口（诚实记录）

1. **Node 侧 Playwright 回退路径不可用**：本机 Node playwright 1.62.1 需要 `chromium-1234`，而缓存只有 `chromium-1243`（Python 侧 patchright 用的）。当前仅因走 sidecar 纯 HTTP 路径才不受影响。一旦 sidecar 失败并回退 Playwright，会抛 `Executable doesn't exist`。**建议：把 sidecar 视为唯一路径，或补装 Node 侧内核。**
2. **cookie 续期边界未验证**：`COOKIE_TTL_SECONDS = 55*60`，但 55 分钟边界没有真跑过。理论上过期后 `ChallengeSolver` 会重新过盾。
3. **并发上限未探明**：只测到 10 并发（10/10 成功）。`ChictrClient._lock` 串行化底层 HTTP，所以并发是排队而非真并行。
4. **长驻稳定性未验证**：`StealthySession` 长时间运行的稳定性未测。
5. **研究实施时间字段轻微粘连**：值内含下一个标签，属已知解析瑕疵。
6. **`MIN_PYTHON` 重复定义**：`[3, 10]` 在 `src/runtime/env-probe.ts:37` 和 `src/runtime/bootstrap.ts:97` 各写了一份且都未被 import 使用，改一处不会同步另一处。

以下细节**未验证**，不要当作保证：打包器（electron-builder / pkg 等）具体如何处理 `bin` 字段与 `CHICTR_HOME` 的植入时机；Windows 上 `py -3` 启动器在无 Python 机器上的失败表现；`setup --timeout` 与 `stepTimeoutMs` 在超时后的中间态是否一定可恢复（代码逻辑是「不回滚」，但未做断网压测）。

---

## 十五、相关文件

| 文件 | 职责 |
|---|---|
| `src/runtime/env-probe.ts` | 环境探测（只读、缓存 30s、绝不抛异常） |
| `src/runtime/bootstrap.ts` | 自举（幂等、镜像回退、显式授权、不回滚） |
| `src/cli/setup-cli.ts` | CLI：doctor / setup / clean / sidecar / postinstall |
| `src/runtime/sidecar-client.ts` | Node → sidecar HTTP 客户端，含 `isSidecarEnabled()` |
| `src/index.ts` | MCP 服务；`check_environment` 工具与 `reportEnvironmentOnBoot()` |
| `sidecar/chictr_sidecar.py` | Python sidecar 服务本体 |
| `src/runtime/env-probe.test.ts` | 12 个探测单测（重点防误报） |
| `dev/browser-removal/DEPLOYMENT.md` | 开箱即用部署指南（更偏背景与实测） |
| `dev/browser-removal/SIDECAR_RUNBOOK.md` | sidecar 运维手册 |
| `dev/browser-removal/SIDECAR_VERIFICATION.md` | sidecar 验证报告 |

---

## 附：合规提醒

ChiCTR 在 re3data 登记为 **restricted**，页脚为 **All rights reserved.**，无官方 API、无 bulk 下载。部署到终端用户前请再次确认数据使用范围。本文件只描述技术实现。
