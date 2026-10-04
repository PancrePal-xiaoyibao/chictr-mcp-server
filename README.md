# ChiCTR MCP Server

[![npm version](https://img.shields.io/npm/v/chictr-mcp-server.svg)](https://www.npmjs.com/package/chictr-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

基于 Model Context Protocol (MCP) 的中国临床试验注册中心 (ChiCTR) 查询服务。

站点对 `/searchproj.html`（搜索）与 `/showproj.html`（详情）施加了阿里盾（阿里云 WAF）保护：
直连返回 **405**，换出口 IP 则变成一页需要执行 JavaScript 才能通过的**挑战页**。
本项目用「Node MCP 服务器 + Python sidecar 子进程」的两段式架构解决它 —— sidecar 过一次挑战
拿到 cookie，之后全程走纯 HTTP。

**当前版本**: v3.0.0 · **MCP 工具**: 10 个 · **默认数据通道**: ChiCTR 原站直连

---

## 📍 目录

- [Scrapling 是什么（以及真正解决问题的是哪两个组件）](#-scrapling-是什么)
- [架构与部署形态](#-架构与部署形态)
- [sidecar 设计](#-sidecar-设计)
- [部署](#-部署)
- [应用场景](#-应用场景)
- [可用工具](#-可用工具)
- [MCP 配置说明](#-mcp-配置说明)
- [CLI 用法](#-cli-命令行工具)
- [性能对比](#-性能对比)
- [已知限制](#-已知限制)
- [合规说明](#-合规说明)

---

## 🧩 Scrapling 是什么

**Scrapling 是一个第三方 Python 爬虫库**（`pip install scrapling`，本项目用的 `scrapling[fetchers]`
实测版本 0.4.15）。它提供 `Fetcher` / `StealthyFetcher` / `StealthySession` 等一把好用的
抓取 API，把「伪装 TLS 指纹」「跑无头浏览器」「过挑战」收敛成几行调用。

### ⚠️ 关键结论：解决阿里盾 405 的不是 Scrapling 这个「框架」

这是本项目最重要的一条认知，也是「开箱即用」代价的来源：

> **真正过盾的是 Scrapling 捆绑的两个底层组件 —— `curl_cffi` 和 `patchright`。
> Scrapling 只是把它们包成了好用的 API。**

| 组件 | 角色 | 在过盾中的实际作用 |
|---|---|---|
| **curl_cffi** | TLS 指纹伪装（impersonate） | 让 Python HTTP 请求的 TLS 指纹（JA3/JA4）看起来像真 Chrome。**它只把「硬 405」降级成「挑战页」，本身解不了挑战。** |
| **patchright** | Chromium 反自动化补丁（Playwright 的 fork） | 让阿里盾的挑战脚本**能真正跑完**并算出 `acw_sc__v2` cookie。**这才是拿到真实页面的那一步。** |
| Scrapling（`Fetcher` / `StealthyFetcher`） | 调用这两个组件的封装层 | 提供 API。它自带的 Cloudflare solver（`solve_cloudflare=True`）对阿里盾**不起作用**，只会打印 `No Cloudflare challenge found.` |

三层证据（`dev/browser-removal/SCRAPLING_SOLUTION.md`，2026-10-04 本机实测）：

| 层级 | 手段 | 结果 |
|---|---|---|
| 0 | 裸 curl / 裸 Node 直连 | ❌ **405 硬拦截** |
| 1 | `Fetcher`（curl_cffi TLS 指纹伪装） | ⚠️ 200，但只返回 **17,136 字节的挑战页**（含 `acw_sc__v2` / `aliyunwaf`） |
| 2 | `StealthyFetcher`（patchright + 真实导航） | ✅ 200，**42,178 字节真实页面**（`共 13125`、`retrieve.js`），挑战通过 |
| 2' | 同样的活交给**原生 Playwright + `page.setContent()`** | ❌ 挑战脚本死循环，跑不完 |

**推论**：`StealthyFetcher` 与原生 Playwright 的差别就在 patchright 的指纹补丁；
正是这个补丁让挑战脚本得以走完。Cloudflare solver 与本case无关。

### 代价：依赖很重（约 1 GB）

「框架能力很强」的反面是**依赖体积**。因为要同时带上「TLS 伪装库」和「带补丁的 Chromium 内核」：

| 项目 | 实测体积 |
|---|---|
| `.venv`（Python 依赖，其中 playwright 134 MB + patchright 134 MB） | **325 MB** |
| `~/Library/Caches/ms-playwright`（浏览器内核） | **557 MB** |
| Node 侧 `node_modules` | 数百 MB |
| **合计** | **≈ 1 GB** |

而且会存在**两套 Chromium 内核**：Node 侧 Playwright 要 `chromium-1234`，Python 侧 patchright 要
`chromium-1243`。这正是本项目不能做成「一个安装包全搞定」、必须把 Python 侧做成
**运行时按需自举**的根本原因（见 [部署](#-部署)）。

---

## 🏗️ 架构与部署形态

### 运行时架构

```
MCP 客户端（Cherry Studio / Claude Desktop / …）
   │  stdio（MCP 协议，stdout 专属通道）
   ▼
Node MCP server（dist/index.js）          ← 对外协议、缓存、状态机、工具编排
   │  CHICTR_USE_SIDECAR=1 时优先走这里
   │  HTTP JSON → 127.0.0.1:8848
   ▼
Python sidecar（sidecar/chictr_sidecar.py） ← 过盾 + 抓取 + 解析
   ├─ curl_cffi 纯 HTTP + TLS 指纹伪装 ─────── 常规请求路径（约 1.5s/页）
   └─ patchright StealthySession 无头浏览器 ── 仅 cookie 过期时过盾（约每小时 1 次）
   ▼
https://www.chictr.org.cn
```

职责边界很清楚：**sidecar 只负责「把 HTML 拿回来并解析成 JSON」，Node 侧负责一切对外契约。**

### 三种部署形态

| 形态 | 组成 | 浏览器依赖 | 适用 |
|---|---|---|---|
| **A. sidecar 形态（推荐）** | Node MCP server + Python sidecar | 仅过盾时拉一次 Chromium | 本机开发、桌面 App、长期驻留服务 |
| **B. 纯 Playwright 形态（默认/回退）** | 只有 Node MCP server | 每次查询都要 Chromium | 已有浏览器环境、sidecar 不可用时的兜底 |
| **C. ICTRP 形态（规划中）** | 只有 Node MCP server，走 WHO ICTRP | 无 | 轻量部署、批量检索；见 `dev/browser-removal/DUAL_CHANNEL_ARCHITECTURE.md` |

当前实现落地的是 **A + B**：sidecar 可用则走 A，任一环节失败**自动回退** B，对外契约不变。
形态 C 仍是设计稿，尚未实现。

**打包形态**（形态 A 打成 dmg/exe 时）：

```
你的 App.app / your-app.exe
├── node_modules/              # Node 依赖，打包器收集（几十 MB）
├── dist/                      # TS 编译产物
├── sidecar/chictr_sidecar.py  # 随包分发（package.json 的 files 已含 "sidecar"）
└── （首次运行时在用户目录创建）
    └── .venv/                 # 325 MB，由 setup 创建，不进安装包
```

关键约束：**打成 dmg/exe 后安装器不会执行 `package.json` 的 `postinstall`**（打包器只收集文件，
钩子被丢掉）。所以依赖准备必须由主程序**在运行时驱动** —— 这就是 `env-probe.ts` + `bootstrap.ts`
存在的原因。

---

## ⚙️ sidecar 设计

### 接口（极小的 HTTP JSON）

sidecar 用标准库 `ThreadingHTTPServer` 暴露三个只读端点，没有框架依赖：

| 方法 | 路径 | 参数 | 返回 |
|---|---|---|---|
| GET | `/health` | — | `{ok, solver:{fresh, age_seconds, solve_count, last_error, cookie_names}}` |
| GET | `/search` | `title`、`regno`、`createyear`、`page`、`pages` | `{ok, source, query, total, total_pages, returned, pages_fetched, results[]}` |
| GET | `/detail` | `proj`（project id） | `{ok, source, project_id, url, registration_number, fields{}, field_count}` |

错误语义：过盾后仍拿到挑战页 → **503 `{"error":"challenge_unsolved"}`**；缺 `proj` → 400；
其他异常 → 502。默认监听 `127.0.0.1:8848`（`--host` / `--port` / `CHICTR_SIDECAR_HOST` /
`CHICTR_SIDECAR_PORT` 可覆盖，另有 `CHICTR_SIDECAR_LOG` 控制日志级别）。

`/search` 的 `results[]` 元素：

```json
{
  "project_id": "245719",
  "registration_number": "ChiCTR2600133371",
  "title": "阿得贝利单抗联合NALIRIFOX用于可切除胰腺癌新辅助治疗",
  "institution": "浙江大学医学院附属第一医院",
  "study_type": "干预性研究",
  "registration_date": "2026/09/24",
  "detail_url": "https://www.chictr.org.cn/showproj.html?proj=245719"
}
```

### 核心机制：cookie 复用，浏览器降级为「低频刷新器」

这是整个设计的地基 —— **挑战解出的 cookie 可以脱离浏览器复用**。

1. **过一次挑战**：`ChallengeSolver._solve()` 启动 `StealthySession(headless=True)`，
   导航到 `/searchproj.html`，从 `session.context.cookies()` 取出
   **`acw_sc__v2` / `acw_tc` / `ssxmod_itna` / `ssxmod_itna2`** 四个 cookie。
2. **纯 HTTP 复用**：`ChictrClient.get_html()` 用 `FetcherSession(impersonate="chrome")`
   带上这组 cookie 请求，**不再触碰浏览器**。
3. **实测摊薄效果**：**`solve_count = 1` 支撑了 ≥13 次请求**（含 3 并发 + 10 并发分页），
   期间未触发重新过盾。一次过盾约 **4.7–6.0s**，此后约 **1.5s/页**。

设计上还有几处关键细节：

| 机制 | 实现 | 原因 |
|---|---|---|
| **双重检查锁** | `ensure()` 先无锁查 `is_fresh()`，未命中再进 `threading.Lock` 复查后才 `_solve()` | 多线程并发首次请求时只跑一次浏览器 |
| **常驻 HTTP 会话** | `FetcherSession` 是工厂式 context manager，构造时进入一次并保持常驻，由 `close()` 退出 | 避免每个请求重建连接池 |
| **底层串行化** | `self._lock` 包住 `self._http.get(...)` | **curl_cffi 的底层 session 并非线程安全**，并发是「排队」而非真并行 |
| **内容检测兜底** | `_is_challenge()` 检测响应里是否只有 `acw_sc__v2`、缺少 `retrieve.js`/`myPagination.js`/`showproj` | **不信任 TTL，信任响应内容** |
| **一次重试** | 命中挑战页或请求异常 → `solver.invalidate(reason)` → 重试一次（`_retry=False` 防递归） | 恢复路径短且不会打转 |

### ⚠️ 重要发现：cookie 实际只有约 37.5 分钟，不是 1 小时

代码里 `COOKIE_TTL_SECONDS = 55 * 60`（55 分钟，比 `acw_sc__v2` 的 1 小时 `expires` 留了 5 分钟余量）。
**但实测 cookie 实际存活约 37.5 分钟，TTL 判断偏乐观。**

这个偏差**不会造成故障**，因为兜底不在 TTL 而在**内容检测**：
cookie 提前失效时，请求会返回挑战页而非报错，`_is_challenge()` 立刻识别出来 →
`invalidate()` 清空 cookie → 重新过盾 → 重试。**实测约 5.7s 恢复**，调用方只感知到一次稍慢的请求。

结论：`fresh` 只是「提前刷新」的优化信号，**真正的正确性由响应内容检测保证**。
运维上不应把 `solver.fresh == false` 当成故障（见[监控](#监控与排障)）。

### Node 侧客户端（`src/runtime/sidecar-client.ts`）

| 行为 | 实现 |
|---|---|
| **默认关闭** | `isSidecarEnabled()` 只在 `CHICTR_USE_SIDECAR` 为 `1`/`true`/`yes`/`on` 时返回 true |
| **失败即回退** | 任何失败（不可达、非 JSON、非 2xx、`payload.error`、0 条有效结果）返回 `null`，由 `src/index.ts` 回退 Playwright |
| **快速失败** | 请求带 `AbortController` + `CHICTR_SIDECAR_TIMEOUT_MS`（默认 30000ms） |
| **状态可见** | `getSidecarStatus()` → `{enabled, available, baseUrl, lastError}`，经 `get_runtime_metrics` 暴露 |

`get_trial_detail` 需要先有 `project_id`：客户端先查缓存里的「注册号 → project_id」映射，
没有就先用 `/search?regno=` 查一次拿 `project_id`，再调 `/detail?proj=`。

### 惰性初始化浏览器（关键修复）

原 `src/index.ts` 的 `CallToolRequestSchema` handler 在 `switch` **之前**无条件执行
`new BrowserManager()` + `initialize()` —— 后果是**即使 sidecar 命中也会先拉起 Chromium**，
sidecar 的全部价值被这一行抵消。

现已改为 `ensureBrowser()` 惰性函数，**只有真正会走 Playwright 的分支（含 sidecar 回退）
才初始化 Chromium**。决定性验证：在一台**刻意不安装 Playwright 浏览器内核**的机器上
（`Executable doesn't exist at .../chromium_headless_shell-1234/...`），修复前 `search_trials`
直接抛错，修复后同样调用返回真实数据 —— 证明全程未触碰浏览器。

---

## 🚀 部署

### 用户视角：三步走

```bash
# 1. 体检（只读，不改任何东西；退出码 1 = 需要处理）
chictr-mcp-server doctor

# 2. 一键修复（创建 venv + 装依赖；联网，首次约 40s ~ 3min）
chictr-mcp-server setup

# 3. 启动 sidecar（前台运行，首次会过一次盾）
chictr-mcp-server sidecar
```

然后让 MCP 客户端走 HTTP 路径：

```bash
export CHICTR_USE_SIDECAR=1
chictr-mcp-server --transport=stdio
```

> `setup` 默认**不下载浏览器内核**（省 560 MB）。sidecar 的纯 HTTP 常规路径不需要它；
> 只有「首次过盾」才需要 Chromium。需要时加 `--browser` 显式授权下载。
>
> 也可以把这三步交给 AI —— MCP 工具 `check_environment` 会返回同样的体检结论和修复建议。

### 退出码约定

| 码 | 含义 | 调用方应对 |
|---|---|---|
| 0 | 环境就绪 / 操作成功 | 继续 |
| 1 | 未就绪，需要用户动作 | 提示用户跑 `setup` |
| 2 | 自举失败（网络、磁盘、权限） | 展示错误，可重试 |

### 自动化的三个层次

1. **启动时自检**（已实现，无需配置）：MCP 服务每次启动做一次体检，结果**只写 stderr
   （stdout 是 MCP 协议通道，写进去会破坏协议）**。体检**永不阻塞启动、永不抛异常** ——
   环境好坏都能启动服务，只是能力不同。
   ```
   [chictr-mcp-server] 环境未就绪：未找到 Python 虚拟环境
   [chictr-mcp-server] 运行 "chictr-mcp-server setup" 自动修复
   ```
2. **首次运行自动下载**（可选，需显式授权）：`setup --browser` 或代码里
   `bootstrapEnvironment({ installBrowser: true, onProgress })`。
   **刻意不做静默自动下载** —— 560 MB 在用户不知情时下载是冒犯行为。
3. **自举健壮性**：`bootstrapEnvironment()` 是**幂等**的（已存在的 venv 不重建、已装的依赖
   不重装，中断后重跑从断点继续）；pip 镜像按 `首选 → 其他 → 官方源` **自动回退**
   （默认阿里云；清华镜像对 pip 26 的新版 User-Agent 返回 403，会把错误伪装成
   `Could not find a version that satisfies the requirement scrapling[fetchers] (from versions: none)`，
   极具误导性，故镜像回退是必需而非优化）。

### 环境变量总表

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHICTR_HOME` | 自动推断 | 项目根目录（打包后位置非常规时必须设） |
| `CHICTR_VENV` | `<root>/.venv` | 虚拟环境目录 |
| `CHICTR_USE_SIDECAR` | 未设置（关闭） | 设为 `1`/`true`/`yes`/`on` 启用 sidecar 优先路径 |
| `CHICTR_SIDECAR_URL` | `http://127.0.0.1:8848` | sidecar 地址 |
| `CHICTR_SIDECAR_TIMEOUT_MS` | `30000` | sidecar 单次调用超时 |
| `CHICTR_SIDECAR_HOST` / `CHICTR_SIDECAR_PORT` | `127.0.0.1` / `8848` | sidecar 监听地址（Python 侧） |
| `CHICTR_SIDECAR_LOG` | `INFO` | sidecar 日志级别 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 未设置 | 代理（可选） |

### 用户环境要求

| 要求 | 说明 |
|---|---|
| Node.js | ≥ 20（打包版自带，可忽略） |
| Python | ≥ 3.10（`setup` 自动发现 `python3.13/3.12/3.11/3.10/python3`） |
| 磁盘 | 纯 HTTP 路径约 400 MB；含浏览器约 1 GB |
| 网络 | 首次 `setup` 需联网（约 40s ~ 3min） |

**如果用户没有 Python**：`doctor` 会报 `venv: missing` 并提示安装 Python。这是 `setup`
唯一无法自动解决的依赖。

> ⚠️ `pip install --user` 在部分 macOS 上会因权限失败
> （`OSError: [Errno 1] Operation not permitted: .../site-packages/w3lib`），**必须用 venv**。
>
> ⚠️ `.venv` 默认建在项目根。若安装目录只读（macOS `/Applications`、Windows
> `Program Files`），必须设置 `CHICTR_HOME` 指向可写目录；`isWritable()` 会在体检报告里提示。

### 监控与排障

```bash
curl -sS http://127.0.0.1:8848/health
# {"ok": true, "solver": {"fresh": true, "age_seconds": 57.0, "solve_count": 1, "last_error": null,
#  "cookie_names": ["acw_sc__v2","acw_tc","ssxmod_itna","ssxmod_itna2"]}}
```

- `solver.solve_count`：累计过盾次数。稳态下应长期为 1（约每小时 +1）。
  **快速上涨说明 cookie 被反复判失效，应检查是否被限流。**
- `solver.last_error`：最近一次过盾失败原因，正常为 `null`。
- MCP 侧可通过 `get_runtime_metrics` 看 `sidecar: { enabled, available, baseUrl, lastError }`。

| 症状 | 原因 | 处理 |
|---|---|---|
| `/health` 连不上 | sidecar 未启动 | `chictr-mcp-server sidecar` |
| 日志 `ERROR: No Cloudflare challenge found.` | **正常噪声** | ChiCTR 用阿里盾不是 CF，可忽略；成功标志是紧随的 `INFO 过盾成功，耗时 X.Xs` |
| `{"error":"challenge_unsolved"}` (503) | 过盾后仍返回挑战页 | 通常是 IP 被限流，稍后重试 |
| MCP 返回 Playwright 报错 | sidecar 未启用或不可达 | 确认 `CHICTR_USE_SIDECAR=1` 且 `curl /health` 正常 |
| `from versions: none` | pip 镜像 403 | 已自动回退；或 `setup --mirror=aliyun` |
| 体检报 venv missing 但目录存在 | venv 损坏 | `setup` 会检测并重建；或 `clean --yes` 后重来 |
| 启动即崩 `Could not locate the bindings file` | `better-sqlite3` 未针对当前 Node ABI 构建 | 见下 |

```bash
# better-sqlite3 原生绑定（Node 22 / ABI v127）；npm rebuild 在受限沙箱会因
# 无法写 ~/Library/Caches/node-gyp 而失败，用预编译包绕过
cd node_modules/better-sqlite3 && npx prebuild-install -r node -t 22.19.0
```

### 全新安装实测记录

在一个「什么都没有」的隔离目录（只有 `package.json` + `dist/` + `sidecar/chictr_sidecar.py`，
共 **592 KB**）验证：

| 步骤 | 结果 |
|---|---|
| `doctor` | ✅ 正确报未就绪，退出码 1，给出 actions |
| `setup --mirror=tsinghua` | ✅ 清华失败 → **自动回退阿里云成功**（2m35s） |
| `doctor` | ✅ 全部就绪（venv 3.13.14 / 依赖 / 浏览器内核 / 脚本） |
| 启动 sidecar | ✅ 过盾成功 **6.7s** |
| 真实搜索「胰腺癌」 | ✅ `total 469` / `total_pages 47` / 返回 10 条 |
| MCP 工具 `check_environment` | ✅ 22ms（缓存命中） |

即：**一台干净机器上，592 KB 的包 + 一条 `setup` 命令 = 可用。**

---

## 🎯 应用场景

| 场景 | 怎么用 | 为什么合适 |
|---|---|---|
| **临床试验情报监测** | 按靶点/疾病关键词定时 `search_trials`，对新增注册号批量 `get_trial_detail` | 原站是**实时**数据（WHO ICTRP 为每周同步，有滞后）；约 1.5s/页使每日轮询成本可忽略 |
| **RAG / 知识库入库** | `search_trials` 拉列表 → `get_trial_detail` 拉 14+ 字段的结构化详情 → 写入向量库 | 详情页解析为**中英对照**的结构化字段，比裸 HTML 更适合切分与检索 |
| **患者匹配与入组筛选** | 用疾病名/基因突变（如 `KRAS G12D`、`胰腺癌`）搜索，再用纳入/排除标准过滤 | `get_trial_detail` 直接返回「纳入标准」「排除标准」「研究实施地点」「招募状态」 |
| **AI Agent 的循证工具** | 作为 MCP server 挂到 Cherry Studio / Claude Desktop 等客户端 | 中国临床试验数据对上 AI 助手是通用缺口；10 个工具里有 5 个是给 Agent 自诊断用的 |
| **科研回顾与趋势分析** | 按 `year` 参数逐年检索，统计某靶点/机构的注册量变化 | 支持按年份、注册号、关键词组合查询，`max_results` 上限 100 |
| **部署自检（Agent 自助排障）** | `check_environment` → 按返回的 `actions` 决定是否调 `setup` | 让 AI 能在用户机器上自行判断「缺 Python 还是缺依赖还是 sidecar 没起」 |

---

## 📋 可用工具

共 **10 个** MCP 工具（v3.0.0 起新增 `check_environment`）。

| # | 工具 | 用途 |
|---|---|---|
| 1 | `search_trials` | 按关键词 / 注册号 / 年份搜索 |
| 2 | `get_trial_detail` | 按注册号查询完整详情 |
| 3 | `get_cache_stats` | 单层缓存统计（命中率等） |
| 4 | `clear_cache` | 清除所有缓存 |
| 5 | `get_cache_stats_v2` | 双层缓存统计（L1 内存 + L2 SQLite） |
| 6 | `get_runtime_metrics` | 运行时编排指标 + **sidecar 状态** |
| 7 | `get_access_state` | 访问状态机（NORMAL/SUSPECTED/CHALLENGED/COOLDOWN/RECOVERY） |
| 8 | `check_environment` | 本机环境体检（Python venv / 依赖 / 浏览器内核 / sidecar），只读，不下载不改文件 |
| 9 | `prepare_verification_session` | 创建人工验证会话 |
| 10 | `resume_after_verification` | 人工验证后恢复访问状态 |

### search_trials

```json
// 按关键词
{ "name": "search_trials", "arguments": { "keyword": "KRAS", "max_results": 20 } }

// 按注册号
{ "name": "search_trials", "arguments": { "registration_number": "ChiCTR2500111173" } }

// 按年份
{ "name": "search_trials", "arguments": { "year": 2024, "max_results": 20 } }

// 组合
{ "name": "search_trials", "arguments": { "keyword": "KRAS", "year": 2024, "max_results": 10 } }
```

**参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `keyword` | string | 否 | 注册题目关键词，最长 200，如 `KRAS G12C`、`胰腺癌` |
| `registration_number` | string | 否 | 注册号，形如 `^ChiCTR\d{8,}$`，最长 32 |
| `year` | integer | 否 | 注册年份，最小 2000，最大为当前年份 + 1 |
| `max_results` | integer | 否 | 最大返回数，默认 20，范围 1–100 |

### get_trial_detail

```json
{ "name": "get_trial_detail", "arguments": { "registration_number": "ChiCTR2500108082" } }
```

### check_environment

```json
{ "name": "check_environment", "arguments": { "refresh": false } }
```

`refresh: true` 忽略 30 秒缓存强制重新探测。返回 `root / node / venv / pythonDeps / browser /
playwrightBrowser / sidecarScript / sidecar / summary / actions / canRunBrowserless`。
`canRunBrowserless` 是判断「能否免浏览器检索」的关键信号。

### 缓存与状态工具

```json
{ "name": "get_cache_stats",  "arguments": {} }
{ "name": "clear_cache",      "arguments": {} }
{ "name": "get_cache_stats_v2","arguments": {} }
{ "name": "get_runtime_metrics","arguments": {} }
{ "name": "get_access_state", "arguments": {} }
```

### 人工验证会话

```json
{ "name": "prepare_verification_session",
  "arguments": { "target_url": "https://www.chictr.org.cn/searchproj.html", "timeout_ms": 300000 } }

{ "name": "resume_after_verification", "arguments": { "verification_id": "verify_xxx" } }
```

---

## 📡 MCP 配置说明

### 最简配置（npx）

```json
{
  "mcpServers": {
    "chictr": {
      "command": "npx",
      "args": ["-y", "chictr-mcp-server@latest"]
    }
  }
}
```

### 全局安装后

```bash
npm install -g chictr-mcp-server
```

```json
{ "mcpServers": { "chictr": { "command": "chictr-mcp-server" } } }
```

### 启用 sidecar（推荐）

```json
{
  "mcpServers": {
    "chictr": {
      "command": "node",
      "args": ["/Users/you/chictr_trials/dist/index.js"],
      "env": { "CHICTR_USE_SIDECAR": "1" }
    }
  }
}
```

前置：先另开一个进程跑 `chictr-mcp-server sidecar`。

### 带代理

```json
{
  "mcpServers": {
    "chictr": {
      "command": "npx",
      "args": ["-y", "chictr-mcp-server"],
      "env": { "HTTP_PROXY": "http://your-proxy-server:port" }
    }
  }
}
```

### 通信方式

| 方式 | 状态 | 说明 |
|---|---|---|
| **stdio** | ✅ 支持（默认） | 标准输入输出 |
| http | 计划中 | `http://localhost:3000/mcp` |
| sse | 计划中 | `http://localhost:3000/mcp` |

### 测试 MCP 服务

```bash
npx @modelcontextprotocol/inspector npx -y chictr-mcp-server
```

---

## 🛠️ CLI 命令行工具

`package.json` 提供两个 bin：`chictr-mcp-server`（`dist/index.js`）与 `chictr-setup`
（`dist/cli/setup-cli.js`）。

```bash
npm install -g chictr-mcp-server   # 全局安装
npx -y chictr-mcp-server           # 或直接 npx（推荐）
```

| 命令 | 说明 |
|---|---|
| `chictr-mcp-server` | 启动 STDIO MCP 服务 |
| `chictr-mcp-server doctor` | 环境体检（只读，不修改任何文件） |
| `chictr-mcp-server setup` | 安装缺失依赖（幂等，可重复运行） |
| `chictr-mcp-server setup --browser` | 同时下载浏览器内核（约 560 MB，需联网） |
| `chictr-mcp-server setup --mirror=aliyun` | 指定 PyPI 镜像（`aliyun` 默认 / `tencent` / `official` / `tsinghua`） |
| `chictr-mcp-server setup --timeout=1800` | 单步超时（秒，默认 1800） |
| `chictr-mcp-server sidecar [--port=8848]` | 前台启动 sidecar（自动带 `--warmup`，透传 `--` 参数） |
| `chictr-mcp-server clean [--yes]` | 删除虚拟环境以便重装 |

npm scripts 等价入口：`npm run doctor` / `npm run setup` / `npm run sidecar`。

---

## 📈 性能对比

| 路径 | 搜索耗时 | 说明 |
|---|---|---|
| **旧 Playwright 路径**（回退形态） | 45s 超时上限 + **每页 5–10s 人为延迟**（另有页间 3–6s、翻页前 2–4s 随机延迟） | `src/services/search.ts` 原逻辑 |
| **sidecar 路径**（推荐形态） | **约 1.5s/页**，搜索端到端 ~1.5–2.1s，详情 ~2s | 纯 HTTP + cookie 复用，无浏览器 |

**端到端响应时间下降约一个数量级**，且去掉了原有的随机延迟规避逻辑。

其他基线（实测）：

| 指标 | 数值 |
|---|---|
| 冷启动过盾 | 4.7 / 5.9 / 6.0 / 6.7s（多次冷启动） |
| 热态单页检索（`regno`） | 1.46s |
| 热态单页检索（`title`） | ~1.5s |
| 详情页 | ~2s |
| 一次过盾支撑请求数 | **≥ 13**（`solve_count` 保持 1） |
| 并发 | 3 并发 3/3 成功；**10 并发 10/10 成功**（共 100 条），期间未重新过盾 |
| cookie 实际存活 | **约 37.5 分钟**（TTL 配置 55 分钟偏乐观，靠内容检测兜底，**5.7s 恢复**） |
| 缓存 | 搜索结果 5 分钟，详情 10 分钟；双层 L1 内存 + L2 SQLite |

### 服务端返回示例

```json
{
  "results": [
    {
      "registration_number": "ChiCTR2500108082",
      "title": "谷氨酰胺联合奥沙利铂、卡培他滨（XELOX）和贝伐珠单抗一线治疗KRAS G12D基因突变型晚期结直肠癌的单臂Ⅱ期探索性研究",
      "study_type": "干预性研究",
      "registration_date": "2025/08/25",
      "institution": "浙江大学医学院附属第二医院"
    }
  ]
}
```

---

## 🔔 版本更新

### v3.0.0 (2026-04-10)
- ✅ **新增 Python sidecar 通道**：用 Scrapling（curl_cffi TLS 指纹 + patchright 反检测内核）过一次阿里盾挑战拿到 cookie，之后全程纯 HTTP。搜索从「每页 5–10s」降到 **~1.5s**，详情 ~2s
- ✅ **新增环境自举**：`chictr-mcp-server doctor / setup / clean` 三个 CLI 子命令，一条 `setup` 命令即可在干净机器上创建 venv、装依赖、按需装浏览器内核
- ✅ **新增 MCP 工具 `check_environment`**：Agent 可自查本机环境（Python / 依赖 / 浏览器内核 / sidecar 在线状态），按返回的 `actions` 决定是否调用 `setup`
- ✅ **修复浏览器惰性初始化**：原先任何工具调用都会先拉起 Chromium，导致 sidecar 命中也要付浏览器的代价；现改为仅在真正走 Playwright 时才初始化
- ✅ **npm 包内分发 sidecar 脚本**（`sidecar/chictr_sidecar.py`），装上即具备 sidecar 能力
- ✅ 修复 Python 版本下限从未生效的问题（`MIN_PYTHON` 此前未被使用，低版本 Python 会被误判为「就绪」）
- ✅ 缓存清除工具不再附带旧的随机延时（sidecar 通道下不再需要人为降速）

### v2.0.2 (2026-04-09)
- ✅ 修复详情空对象缓存命中问题（自动失效并重查）
- ✅ 进一步提升详情查询的有效内容获取稳定性

### v2.0.1 (2026-04-09)
- ✅ 修复 Cherry Studio 场景下 `./cache` 路径导致的启动失败（ENOENT）
- ✅ 默认缓存路径调整为 `~/.chictr/cache/chictr_cache.db`
- ✅ 增加 `/tmp/chictr/cache/chictr_cache.db` 兜底路径

### v2.0.0 (2026-04-09)
- ✅ 新增请求编排层（限速/重试/熔断）
- ✅ 新增 Session 池化与生命周期回收
- ✅ 新增挑战状态机与恢复工具（get_access_state / prepare_verification_session / resume_after_verification）
- ✅ 新增双层缓存（L1 内存 + L2 SQLite）与 get_cache_stats_v2

### v1.2.1 (2025-01-17)
- ✅ 更新 README，添加多维度搜索示例
- ✅ 添加版本升级指南
- ✅ 提供 Cherrystudio 缓存清除方案

### v1.2.0 (2025-01-17)
- ✅ 新增按注册号搜索（registration_number 参数）
- ✅ 新增按年份搜索（year 参数，默认当前年份）
- ✅ 所有搜索参数改为可选
- ✅ 修复详情查询 400 错误（使用正确的 project_id）

### v1.1.0 (2025-01-17)
- ✅ 修复分页功能，支持多页结果获取
- ✅ 支持代理配置（HTTP_PROXY/HTTPS_PROXY）
- ✅ 增加验证码检测与友好错误提示

---

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| Node 侧 | TypeScript、MCP SDK、Cheerio、node-cache、better-sqlite3、Playwright |
| Python sidecar | Python ≥ 3.10、Scrapling（`scrapling[fetchers]`）、curl_cffi、patchright、标准库 `ThreadingHTTPServer` |

---

## ⚠️ 已知限制

诚实记录，未解决或未验证的项：

1. **Node 侧 Playwright 回退路径在本机不可用**：Node playwright 1.62.1 需要 `chromium-1234`，
   而缓存里只有 `chromium-1243`（Python 侧 patchright 用的）。当前只因走 sidecar 纯 HTTP 路径
   才不受影响；一旦 sidecar 失败并回退 Playwright 会抛 `Executable doesn't exist`。
   **建议：把 sidecar 视为唯一路径，或补装 Node 侧内核。**
2. **cookie 过期边界**：实测存活约 37.5 分钟 < TTL 配置的 55 分钟。靠内容检测 + 重试恢复
   （实测 5.7s），但 TTL 只是一个乐观的提前刷新信号。
3. **并发上限未探明**：只测到 10 并发（10/10 成功）。`ChictrClient._lock` 串行化了底层
   HTTP 会话（curl_cffi session 非线程安全），所以并发是「排队」而非真并行。**请勿盲目加大。**
4. **长驻稳定性未验证**：`StealthySession` 长时间运行的稳定性未测（当前每次过盾新建一次
   浏览器上下文并退出）。
5. **请求频率上限未测**：阿里盾在更高 QPS 下是否二次拦截未知。
6. **`研究实施时间` 字段轻微粘连**：值内含下一个标签，属已知解析瑕疵，不影响主要字段。
7. **ICTRP 双通道尚未实现**：`dev/browser-removal/DUAL_CHANNEL_ARCHITECTURE.md` 是设计稿；
   本项目当前**没有** WHO ICTRP 通道，也没有 `source=` 参数。
8. **headless 模式下无法手动处理验证码**：频繁请求仍可能触发滑动验证码。

---

## ⚖️ 合规说明

- ChiCTR 在 **re3data 登记为数据访问 `restricted`**，站点页脚为 **`All rights reserved.`**。
- **无官方 API、无 bulk 下载通道。**
- 因此：**「可获得 ≠ 可再分发」。** 本项目定位为受控环境下的个人研究/情报用途，
  不做数据再分发。若要长期依赖 ChiCTR 直连，建议同时推进对 `chictr-s7@wchscu.cn`
  的正式授权问询。
- 绕过 WAF 是与站点访问决策的对抗，属**政策判断**而非技术判断 —— 技术结论是
  「访问可行」，合规判断请自行确认。相关背景见
  `dev/browser-removal/SCRAPLING_SOLUTION.md` §6 与 `SIDECAR_RUNBOOK.md`。

---

## 📄 许可证

MIT License

## 🙏 致谢

本项目使用中国临床试验注册中心 (ChiCTR) 的公开数据，感谢 ChiCTR 为医学研究做出的贡献。
特别感谢[小胰宝](http://www.xiaoyibao.com.cn)和[小x宝社区](https://info.xiao-x-bao.com.cn)的❤️贡献与付出，用爱心与人工智能为癌症/罕见病患者及其家庭提供支持！

## 📞 相关文档

| 文件 | 说明 |
|---|---|
| `dev/browser-removal/SCRAPLING_SOLUTION.md` | 过盾可行性三层实测证据（含复现命令） |
| `dev/browser-removal/SIDECAR_RUNBOOK.md` | sidecar 运维手册 |
| `dev/browser-removal/SIDECAR_VERIFICATION.md` | sidecar 端到端验证报告与实测数据 |
| `dev/browser-removal/DEPLOYMENT.md` | 开箱即用部署指南（dmg / exe） |
| `dev/browser-removal/DUAL_CHANNEL_ARCHITECTURE.md` | 双通道降级架构（设计稿） |
| `sidecar/chictr_sidecar.py` | sidecar 实现（过盾 + 解析 + HTTP 服务） |
| `src/runtime/sidecar-client.ts` | Node 侧客户端（默认关闭，失败自动回退） |

如有问题，请提交 GitHub Issue。
