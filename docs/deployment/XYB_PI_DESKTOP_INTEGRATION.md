# 与 xyb-pi-desktop（小胰宝）集成方案

> 目标项目：`/Users/qinxiaoqiang/Downloads/xiaoyibao-pi-desktop`（`pi-desktop` v0.16.1）
> 本文基于对该项目源码与规范的实际阅读，非推测。凡未落地的事项均明确标注。

## 0. 结论摘要

好消息：**xyb-pi-desktop 已经集成了本项目**。它不需要从零对接——

`apps/desktop/resources/plugins/xyb.trial-sources/manifest.json` 中已声明：

```jsonc
{
  "id": "chictr",
  "label": "ChiCTR 中国临床试验注册中心",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "chictr-mcp-server@2.0.2"]
}
```

所以本次集成的真正工作不是「接进去」，而是**把这条既有链路从 Playwright 形态升级到 sidecar 形态**，并让它符合 pi-desktop 的体积与授权规范。

三个必须处理的落差：

| 落差 | 现状 | 目标 |
|---|---|---|
| **形态** | `npx -y chictr-mcp-server@2.0.2`，首次联网拉包；运行时依赖 Playwright Chromium（570MB） | 升级到含 sidecar 的版本，依赖 Python 运行时 + 浏览器内核 |
| **前置条件** | 插件 README 如实写着「依赖 Playwright Chromium（约 570MB）」；`SOURCES[].need` 也这么写 | 改为「依赖 Python 3.10+ 与约 1GB 运行时」——**体积翻倍，必须诚实告知** |
| **L2 声明** | `XYB-EXTENSIONS.md` 定义了 `requires` 声明式字段 | **该字段尚未实现**（文档原文：「宿主通道待建」），需与宿主团队确认排期 |

## 1. 宿主侧的集成契约（实读所得）

理解这几条，集成的形状就定了。

### 1.1 MCP 服务只能声明，不能运行时打开

ADR-0038 明确规定：MCP 服务器**在 manifest 里声明**，`contributes.mcpServers` 携带
`{ id, label?, transport }` 加恰好一种 transport 的字段（`stdio` 用 `command`/`args`/`env`）。

对集成的含义：**我们不能在运行时偷偷起 sidecar**。sidecar 进程必须由 chictr-mcp-server 自己作为子进程管理，
宿主只负责拉起 `chictr-mcp-server`（stdio MCP 服务），后者再拉 sidecar。

链路是：

```
Electron main (plugin-mcp.ts)
  └─ stdio NDJSON ─→ chictr-mcp-server（Node 进程，MCP 协议）
                       └─ HTTP ─→ chictr_sidecar.py（Python 进程，127.0.0.1:8848）
                                    └─ HTTPS ─→ chictr.org.cn
```

**三层进程**。这是与现状最大的结构差异：现在只有两层（宿主 → npx 包）。

### 1.2 权限分档，且 `mcp.server.local` 是 high、默认拒绝

pi-desktop 把拉本地进程视为高风险。`xyb.trial-sources` 的整体设计就是「独立成插件，
让插件是否启用本身成为授权动作」。

对集成的含义：**不要为了省事把 sidecar 相关能力塞进默认可用的核心插件**。
保持它单独成插件、默认关闭的现状是对的，也是 `XYB-EXTENSIONS.md` §4 红线第 2 条的要求。

### 1.3 超时预算（这条决定了 sidecar 的价值）

实读 `apps/desktop/electron/main/plugin-mcp.ts`：

| 常量 | 值 |
|---|---|
| `MCP_CONNECT_TIMEOUT_MS` | 10_000（10s 完成握手） |
| `MCP_CALL_TIMEOUT_MS` | 100_000（每次调用 100s） |
| `MCP_TOOL_DISCOVERY_TIMEOUT_MS` | 30_000 |
| `MAX_STDIO_LINE_BYTES` | 4 MB |
| `MAX_MCP_TOOLS_PER_SERVER` | 2048 |
| host-core 派发总预算 | 150s（含握手 + 遍历 + 调用） |

ADR-0038 原文：*「host-core's 150s dispatch deadline carries the whole leg —
handshake, traversal, and call — so the client reports its own timeout first.」*

**关键推论**：100s 的调用预算对 sidecar 路径（1.5–2s）绰绰有余；
但旧 Playwright 路径的「45s 超时上限 + 每页 5–10s 人为延迟」在多次翻页时会逼近预算。
这正是 sidecar 集成对 pi-desktop 的实际价值：**把余量从「勉强够」变成「绰绰有余」**。

### 1.4 凭据红线

`XYB-EXTENSIONS.md` §3.3 的三条（不接受例外）：

1. 只写 `<应用数据目录>/config.json`，权限 `0600`
2. **绝不**经命令行参数传递（进程列表可读），走 `--config` 文件
3. 不进日志、不进工具返回值、不进仓库

本项目目前**不需要凭据**（ChiCTR 无 API key），因此这条暂无冲突。
但若未来引入代理认证，必须遵守。

### 1.5 工具注册的命名与风险等级

- 发现的工具注册为 `plugin_<pluginIdSafe>_<serverId>_<toolName>`，
  即本项目工具会呈现为 `plugin_xyb_trial-sources_chictr_search_trials` 之类。
- **每个工具一律 `risk: "medium"`**，不看服务自报的风险等级：
  *「a self-declared risk level from that source is not evidence」*。

对本项目的含义：我们无法通过自报声明降低工具的审查等级。

### 1.6 连接是惰性的

ADR-0038：*「Connection is lazy — declaring a server costs nothing until a tool is called — and teardown follows unload.」*

这与我们在 `src/index.ts` 里做的**惰性浏览器初始化**是同一思路，一致。

## 2. 目标形态：三层进程与本项目的自举

### 2.1 期望的最终链路

```
用户点开「试验来源」→ 启用 xyb.trial-sources 插件（授权 mcp.server.local）
  ↓
宿主按 manifest 声明拉起 chictr-mcp-server（stdio）
  ↓
chictr-mcp-server 启动时体检（env-probe）→ 未就绪则提示
  ↓
若 CHICTR_USE_SIDECAR=1 → 走 HTTP 到 sidecar
  ↓
sidecar 首次调用时过阿里盾挑战（约 6.7s）→ 拿到 cookie → 后续纯 HTTP 复用
```

### 2.2 manifest 改造建议

现状（Form B，`npx` 拉包）：

```jsonc
{
  "id": "chictr",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "chictr-mcp-server@2.0.2"]
}
```

问题：
1. `npx -y` 在首次运行时联网拉包 —— 违背「开箱即用」；
2. 拉到的版本**不含 sidecar**（2.0.2 是旧版）；
3. 无法注入 `CHICTR_USE_SIDECAR` 等环境变量。

建议改为**随插件分发**（对照 `xyb.trial-sources` 里 `chinadrugtrials` 的做法：
`"command": "./mcp/chinadrugtrials-mcp.mjs"`，920 行零依赖）：

```jsonc
{
  "id": "chictr",
  "label": "ChiCTR 中国临床试验注册中心",
  "transport": "stdio",
  "command": "node",
  "args": ["./mcp/chictr/server.js", "--transport=stdio"],
  "env": {
    "CHICTR_USE_SIDECAR": "1",
    "CHICTR_HOME": "<应用私有数据目录>/chictr"
  }
}
```

但注意 `XYB-EXTENSIONS.md` §3.3 的形态选择表：

| 形态 | 适用 | 对本项目的判断 |
|---|---|---|
| **A 自带服务**（首选） | 逻辑在代码里、依赖轻 | ❌ 不合适——sidecar 依赖 Python + 1GB 运行时 |
| **B vendor 第三方包** | 上游许可允许 | ⚠️ 部分——Node 侧可以随包，Python 侧不行 |
| **C 受管组件（L2）** | 运行时/数据很重 | ✅ **正解**——Python 运行时 + 浏览器内核走 L2 |

文档已把 **ChiCTR（Apache-2.0）列为 B 形态的先例**，但那是在 sidecar 出现之前写的判断。
引入 Python 运行时后，本项目实际同时落在 B（Node 层）与 **C（Python + 浏览器层）**。

### 2.3 L2 声明（宿主通道待建）

`XYB-EXTENSIONS.md` §5 给出的目标形态：

```jsonc
"requires": [
  { "kind": "playwright-chromium", "bytes": 597688320, "source": "playwright", "license": "Apache-2.0" },
  { "kind": "python-deps",         "bytes": 2000000,   "source": "pypi",       "license": "PSF-2.0" }
]
```

本项目应声明（**实测体积**）：

```jsonc
"requires": [
  { "kind": "python-runtime",      "bytes": 0,         "source": "system",     "license": "PSF-2.0",
    "note": "需用户本机 Python 3.10+；无法自动安装，需明确提示" },
  { "kind": "python-deps",         "bytes": 340787200, "source": "pypi",       "license": "BSD-3-Clause",
    "note": ".venv 实测 325MB（含 playwright 134M + patchright 134M）" },
  { "kind": "playwright-chromium", "bytes": 597688320, "source": "playwright", "license": "Apache-2.0",
    "note": "实测 ~/Library/Caches/ms-playwright 557MB" }
]
```

**重要**：该字段目前**只有文档定义，没有宿主实现**。§5 原文标注「（目标形态：宿主通道待建）」。
因此当下必须走**过渡方案**（见 §3）。

### 2.4 关于两套 Chromium 内核

现状有个需要澄清的坑：机器上会有两个内核需求——

| 来源 | 需要的 revision |
|---|---|
| Node 侧 playwright 1.62.1 | `chromium-1234` |
| Python 侧 patchright | `chromium-1243` |

**走 sidecar 路径时 Node 侧内核完全不需要**（实测：Node 侧内核缺失，sidecar 路径仍返回真实数据）。
所以集成后应：

1. 明确 sidecar 为**唯一主路径**；
2. Node 侧 Playwright 仅作 fallback，且**不下载其内核**（省 570MB 的一份冗余）；
3. 在体检报告里把 Node 侧内核缺失标为「可忽略」（已在 `env-probe.ts` 中实现）。

这条能显著减小 L2 声明体积，也避免用户疑问「为什么装了两个浏览器」。

## 3. 过渡方案：在没有 L2 宿主通道时如何工作

宿主尚未实现 `requires`，但我们的自举层（`src/cli/setup-cli.ts`）已经能独立完成准备工作。
两者对接方式：

### 3.1 方案甲：应用内「一键就绪」按钮（推荐）

插件提供一个命令，由用户显式触发，调用本项目的自举逻辑：

```ts
// 插件侧（示意）：需要 shell 能力则另议，建议由宿主代跑
import { bootstrapEnvironment } from "chictr-mcp-server/dist/runtime/bootstrap.js";

await bootstrapEnvironment({
  installBrowser: true,                       // 需用户显式同意，约 560MB
  pypiMirror: "aliyun",                       // 默认；失败自动回退 tencent → official
  onProgress: (msg) => report(msg),           // 复用 plugin.installProgress 通道
});
```

`plugin.installProgress` 的 phase 枚举是
`resolve | download | verify | install | enable`，与本项目的自举步骤可做如下映射：

| 本项目阶段 | 映射到 phase |
|---|---|
| 创建 venv | `install` |
| 安装 Python 依赖（含镜像回退） | `download` |
| 下载浏览器内核 | `download`（带 `receivedBytes`/`totalBytes`） |
| 校验内核可用 | `verify` |
| 完成 | `enable` |

镜像回退还能天然对上 `source` / `attempt` / `attempts` / `tried[]` 字段——
本项目的 `mirrorChain()` 正是同样的语义（首选 → 回退 → 官方兜底），
实测能正确报告「前 1 个镜像失败后回退成功：tsinghua: ...」。

### 3.2 方案乙：让用户手动跑一次 CLI

最省事、最诚实，但需要用户开终端：

```bash
chictr-mcp-server doctor     # 只读体检，退出码 0/1/2
chictr-mcp-server setup      # 幂等自举
chictr-mcp-server sidecar    # 前台启动 sidecar（首次过盾）
```

退出码约定（便于宿主驱动 UI）：

| 码 | 含义 | UI 应对 |
|---|---|---|
| 0 | 就绪 | 直接启用数据源 |
| 1 | 未就绪，需用户动作 | 展示 `actions[]`，提供「一键修复」 |
| 2 | 自举失败 | 展示错误（网络/磁盘），允许重试 |

### 3.3 方案丙：MCP 工具内自省（已可用）

本项目已注册第 10 个 MCP 工具 `check_environment`：

```jsonc
// 入参
{ "refresh": true }
// 出参（结构化部分）
{
  "ready": true,
  "summary": "环境就绪",
  "actions": [],
  "root": "/path/to/root",
  "checks": {
    "node": {...}, "venv": {...}, "python_deps": {...},
    "browser": {...}, "sidecar_script": {...}, "sidecar": {...},
    "playwright_fallback": {...}
  }
}
```

**这是对集成最友好的一条**：助手读完就能自己判断「要不要让用户去准备环境」，
不需要宿主额外写探测逻辑。建议 pi-desktop 的技能文档里明确告诉助手：
调用 chictr 工具前先看 `check_environment`。

## 4. 需要 pi-desktop 侧配合的改动清单

| # | 改动 | 位置 | 理由 |
|---|---|---|---|
| 1 | manifest 的 chictr 条目改为随包 `node ./mcp/chictr/server.js` | `xyb.trial-sources/manifest.json` | 去掉 `npx -y` 的首次联网；版本可控 |
| 2 | 注入 `CHICTR_USE_SIDECAR=1` 与 `CHICTR_HOME` | 同上 `env` | 启用 HTTP 路径；`CHICTR_HOME` 指向应用私有可写目录 |
| 3 | 更新 `SOURCES[].need` 文案 | `xyb.trial-sources/main.js` | 现文案是「依赖 Playwright Chromium」，实际变为 Python 运行时 + ~1GB |
| 4 | 更新插件 `README.md` 前置条件段 | `xyb.trial-sources/README.md` | 同上，保持文档诚实 |
| 5 | 增加「一键就绪」命令与进度上报 | `main.js` + manifest `commands` | 见 §3.1 |
| 6 | 技能文档加一句「先查 check_environment」 | `skills/china-trials.md` | 让助手能自省环境 |
| 7 | 与宿主团队确认 `requires` 排期 | 上游 `XYB-EXTENSIONS.md` §5 | 当前只有文档定义 |

**注意第 3、4 条**：`XYB-EXTENSIONS.md` §4 强调「UI 才能诚实告知患者」。
体积从 570MB 变成约 1GB，这个变化必须体现在文案里，不能沿用旧描述。

## 5. 体积与授权话术（供 UI 文案参考）

按 §5 要求「体积与来源告知并征得同意」，建议文案：

> **ChiCTR 数据源需要准备运行环境**（约 1.1 GB）
>
> - Python 运行时（需您本机已安装 Python 3.10 或更高版本）
> - Python 依赖包：约 325 MB（来自 PyPI，许可 BSD-3-Clause）
> - 浏览器内核：约 557 MB（来自 Playwright，许可 Apache-2.0）
>
> 这些**不会**在您不知情时下载。是否现在准备？
>
> 为什么这么大：为了绕开站点的反爬验证，需要 TLS 指纹伪装（curl_cffi）
> 与带反检测补丁的浏览器内核（patchright）。这两个组件无法省略。

## 6. 合规提醒

ChiCTR 在 re3data 登记为 **restricted**，页脚 **All rights reserved.**，无官方 API、无 bulk 下载。
集成进面向患者的产品前，需确认数据使用范围。本项目仅做技术实现，合规判断由产品方做出。

pi-desktop 侧的对应表述可参考 `SOURCES[].limit` 的写法——它已经在做「如实标注限制」这件事
（例如 chictr 条目写「站点有反爬与滑动验证；触发时需人工验证后恢复，工具不得绕过」）。

**一点必须修正的事实**：现有文案说「触发时需人工验证后恢复，工具不得绕过」。
这是 sidecar 之前的准确描述（Playwright 路径遇到挑战需要人工介入）。
sidecar 方案下**挑战由程序自动解开**（实测 6.7s，无需人工），
所以这句应更新——否则产品对用户的承诺与实现不符。

## 7. 待确认事项（需要产品/宿主决策）

1. **`requires` 字段何时实现？** 决定走 §3.1 还是长期停在 §3.2。
2. **Python 运行时如何解决？** 本项目的 `setup` 能自动建 venv，但**不能自动安装 Python 本身**。
   若目标用户可能没有 Python，需要宿主侧提供引导或改为捆绑 Python。
3. **sidecar 是否常驻？** 当前是前台进程。若要做成随应用启动的常驻服务，
   需要按 ADR-0040（plugin resident services）设计，且考虑 MCP bridge 的惰性连接语义。
4. **是否保留 Node 侧 Playwright fallback？** 保留则多 570MB，不保留则少一层保险。
   倾向：不下载内核，仅保留代码路径。
5. **npm 包发布形态**：是否需要把 `sidecar/` 目录纳入 npm 包（`package.json` 的 `files` 已含 `"sidecar"`）。

## 8. 相关文件

| 文件 | 说明 |
|---|---|
| `src/runtime/env-probe.ts` | 环境探测，被 `check_environment` 使用 |
| `src/runtime/bootstrap.ts` | 自举，含镜像回退链 |
| `src/cli/setup-cli.ts` | doctor / setup / clean / sidecar CLI |
| `src/runtime/sidecar-client.ts` | Node → sidecar HTTP 客户端 |
| `sidecar/chictr_sidecar.py` | Python sidecar 本体 |
| `docs/deployment/DEPLOYMENT.md` | 开箱即用部署指南（dmg/exe） |
| `docs/deployment/AUTO_BOOTSTRAP.md` | 首次启动自动激活方案 |

pi-desktop 侧：

| 文件 | 说明 |
|---|---|
| `apps/desktop/resources/plugins/xyb.trial-sources/manifest.json` | 三个 MCP 服务声明处 |
| `apps/desktop/resources/plugins/xyb.trial-sources/main.js` | `SOURCES` 目录与前置条件文案 |
| `apps/desktop/electron/main/plugin-mcp.ts` | MCP 桥接实现（超时常量在此） |
| `docs/adr/0038-plugin-mcp-bridge.md` | MCP 集成契约 |
| `XYB-EXTENSIONS.md` | 插件/MCP 开发规范，§3.3 与 §5 最相关 |
