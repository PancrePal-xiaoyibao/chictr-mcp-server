# 开箱即用部署指南（dmg / exe）

本文件回答两个问题：**用户拿到安装包后要做什么**，以及**我们如何保证它自动完成**。

## 一、先厘清三个名词

| 名词 | 是什么 | 类比 |
|---|---|---|
| **Scrapling** | 第三方 Python 爬虫库（`pip install scrapling`） | 零件 |
| **curl_cffi / patchright** | Scrapling 捆绑的两个底层库，**真正解决阿里盾 405 的是它们** | 关键材料 |
| **sidecar** | 我们写的 `sidecar/chictr_sidecar.py`，用 Scrapling 提供 HTTP 服务 | 成品 |

真正起作用的是：
- **curl_cffi** —— 伪装 TLS 指纹（JA3/JA4），让请求看起来像真 Chrome。
- **patchright** —— Chromium 反自动化补丁，用于过一次性的 JS 挑战、取回 `acw_sc__v2` cookie。

拿到 cookie 后，后续请求只是普通 HTTP，带上 cookie 即可，约 1.5s/页。

## 二、为什么不能做成「一个安装包全搞定」

实测体积：

| 项目 | 大小 |
|---|---|
| `.venv`（Python 依赖） | 325 MB（playwright 134M + patchright 134M） |
| `~/Library/Caches/ms-playwright`（浏览器内核） | 557 MB |
| `node_modules` | 数百 MB |
| **合计** | **≈ 1 GB** |

且**有两套 Chromium 内核**：Node 侧 playwright 要 `chromium-1234`，Python 侧 patchright 要 `chromium-1243`。

**关键约束**：打成 dmg/exe 后，安装器**不会**执行 `package.json` 的 `postinstall`。
打包器只收集文件，钩子是被丢掉的。所以依赖准备**必须由主程序在运行时驱动**——
这就是 `env-probe.ts` + `bootstrap.ts` 存在的原因。

## 三、用户视角：三步走

```bash
# 1. 体检（只读，不改任何东西；退出码 1 = 需要处理）
chictr-mcp-server doctor

# 2. 一键修复（创建 venv + 装依赖；联网，首次约 40s ~ 3min）
chictr-mcp-server setup

# 3. 启动 sidecar（前台运行，首次会过盾）
chictr-mcp-server sidecar
```

然后让 MCP 客户端走 HTTP 路径：

```bash
export CHICTR_USE_SIDECAR=1
chictr-mcp-server --transport=stdio
```

也可以只把这三步交给 AI——MCP 工具 `check_environment` 会返回同样的体检结论和修复建议，
AI 读完就知道该让用户做什么、或自己调 `setup`。

### 退出码约定

| 码 | 含义 | 调用方应对 |
|---|---|---|
| 0 | 环境就绪 / 操作成功 | 继续 |
| 1 | 未就绪，需要用户动作 | 提示用户跑 `setup` |
| 2 | 自举失败（网络、磁盘、权限） | 展示错误，可重试 |

## 四、自动化的三个层次

### 1. 启动时自检（已实现，无需配置）

MCP 服务每次启动会做一次体检，结果只写 **stderr**（stdout 是 MCP 协议通道，写进去会破坏协议）。
未就绪时提示：

```
[chictr-mcp-server] 环境未就绪：未找到 Python 虚拟环境
[chictr-mcp-server] 运行 "chictr-mcp-server setup" 自动修复
```

体检**永不阻塞启动**，也永不抛异常——环境好坏都能启动服务，只是能力不同。

### 2. 首次运行自动下载（可选，需要显式授权）

```bash
chictr-mcp-server setup --browser    # 额外下载浏览器内核（约 560MB）
```

或从代码里调用：

```ts
await bootstrapEnvironment({ installBrowser: true, onProgress: (m) => console.log(m) });
```

**刻意不做静默自动下载**：560MB 在用户不知情时下载是冒犯行为。
`bootstrap.ts` 的所有下载都必须由 `installBrowser: true` 显式触发。

### 3. 自举的健壮性设计

`bootstrapEnvironment()` 是**幂等**的：已存在的 venv 不重建，已装的依赖不重装。
重复运行安全，中断后重跑会从断点继续。

**镜像自动回退**（这是实测踩出来的坑）：

默认镜像从清华换成**阿里云**，因为清华镜像对 pip 26 的新版 User-Agent 返回 403：

```
pip/26.1.2 {"ci":null,"cpu":"arm64","distro":{...},...}   → 清华 403
pip/26.1.2                                                 → 清华 200
任意 UA                                                    → 阿里云/腾讯 200
```

403 会让 pip 报出**极具误导性**的错误：

```
ERROR: Could not find a version that satisfies the requirement scrapling[fetchers]
       (from versions: none)
```

看起来像「这个包不存在」，实际是镜像拒绝了请求。因此 `stepInstallDeps` 现在按
`首选镜像 → 其他镜像 → 官方源` 依次重试，成功后明确报告回退过程：

```
✅ 安装 Python 依赖: scrapling[fetchers] 已安装（镜像 aliyun）
   （前 1 个镜像失败后回退成功：tsinghua: ERROR: Could not find a version ...）
```

## 五、打包建议

推荐结构（把 Python 侧作为**可选运行时**，不塞进安装包）：

```
你的 App.app / your-app.exe
├── node_modules/            # Node 依赖，打包器收集
├── sidecar/chictr_sidecar.py # 随包分发（package.json 的 files 已含 "sidecar"）
├── dist/                     # 编译产物
└── （首次运行时在用户目录创建）
    └── .venv/                # 325MB，安装后由 setup 创建
```

理由：Node 部分可以随包分发（几十 MB），Python 侧 325MB + 浏览器 557MB
放安装包里会让 dmg 膨胀到 1GB+，且两套 Chromium 内核互相冲突。

**.venv 的位置**：默认建在 `<项目根>/.venv`。如果安装目录只读
（macOS 的 `/Applications`、Windows 的 `Program Files`），
必须设置 `CHICTR_HOME` 指向可写目录：

```bash
export CHICTR_HOME="$HOME/Library/Application Support/chictr"
```

程序启动时用 `isWritable()` 判断，只读时会在体检报告里给出提示。

## 六、环境变量总表

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHICTR_HOME` | 自动推断 | 项目根目录（打包后位置非常规时必须设） |
| `CHICTR_VENV` | `<root>/.venv` | 虚拟环境目录 |
| `CHICTR_USE_SIDECAR` | 未设置 | 设为 `1/true/yes/on` 启用 HTTP 路径 |
| `CHICTR_SIDECAR_URL` | `http://127.0.0.1:8848` | sidecar 地址 |
| `CHICTR_SIDECAR_TIMEOUT_MS` | `30000` | sidecar 请求超时 |

## 七、用户环境要求

| 要求 | 说明 |
|---|---|
| Node.js | ≥ 20（打包版自带，可忽略） |
| Python | ≥ 3.10（`setup` 自动发现 `python3.13/3.12/3.11/3.10/python3`） |
| 磁盘 | 纯 HTTP 路径约 400MB；含浏览器约 1GB |
| 网络 | 首次 `setup` 需联网（约 40s ~ 3min） |

**如果用户没有 Python**：`doctor` 会报 `venv: missing` 并提示安装 Python。
这是 `setup` 唯一无法自动解决的依赖——需要用户先装 Python。

## 八、验证与排障

**确认环境就绪**：

```bash
chictr-mcp-server doctor          # 全部 ✅，退出码 0
```

**确认 sidecar 活着**：

```bash
curl http://127.0.0.1:8848/health
# {"ok": true, "solver": {"fresh": true, "solve_count": 1, ...}}
```

**常见症状对照**：

| 症状 | 原因 | 处理 |
|---|---|---|
| `from versions: none` | 镜像 403（见上文） | 已自动回退；或 `setup --mirror=aliyun` |
| `Executable doesn't exist at .../chromium-1234` | Node 侧 playwright 内核缺失 | 走 sidecar 路径可忽略；否则 `npx playwright install chromium` |
| 体检报 venv missing 但目录存在 | venv 损坏 | `setup` 会检测并重建；或 `clean --yes` 后重来 |
| sidecar 启动后一直不 ready | 过盾失败（网络/被限流） | 看 sidecar 日志；确认能访问 ChiCTR |
| `ERROR: No Cloudflare challenge found.` | **正常噪声** | ChiCTR 用阿里盾不是 CF，可忽略 |

最后一条要特别说明：这条 ERROR 每次过盾都会出现，它是 scrapling 尝试找 Cloudflare
挑战没找到而打印的，**不代表失败**。真正的成功标志是紧接着的
`INFO chictr_sidecar: 过盾成功，耗时 X.Xs`。

## 九、全新安装实测记录

为验证上面的流程真实可用，构造了一个「什么都没有」的隔离目录：
只有 `package.json` + `dist/` + `sidecar/chictr_sidecar.py`，共 **592 KB**，无 venv、无 node_modules。

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

## 十、已知缺口（诚实记录）

以下问题**尚未解决或未验证**，部署时需留意：

1. **Node 侧 Playwright 回退路径不可用**：本机 Node playwright 1.62.1 需要
   `chromium-1234`，而缓存只有 `chromium-1243`（Python 侧用的）。当前仅因走 sidecar
   纯 HTTP 路径才不受影响。一旦 sidecar 失败并回退 Playwright，会抛
   `Executable doesn't exist`。**建议：把 sidecar 视为唯一路径，或补装 Node 侧内核。**
2. ~~cookie 续期边界未验证~~ → **已实测确认（见下）**。

### cookie 失效恢复：已实测

这是首次真实观测到 cookie 过期全链路。日志原文：

```
[15:50:26] 上一次成功请求（胰腺癌）
[15:58:55] WARNING chictr_sidecar: cookie 失效，下次请求将重新过盾：挑战页返回 (status=200)
[15:58:55] INFO    chictr_sidecar: 启动无头浏览器过一次阿里盾挑战 …
[15:59:01] INFO    chictr_sidecar: 过盾成功，耗时 5.7s，cookie=[acw_sc__v2, acw_tc, ssxmod_itna, ssxmod_itna2]
[15:59:02] 重试同一请求 → 成功
```

| 项目 | 实测值 |
|---|---|
| cookie 实际存活 | **约 37.5 分钟**（15:21:23 过盾 → 15:58:55 失效） |
| 代码 TTL 设定 | 55 分钟 |
| 失效后恢复耗时 | **5.7s** |
| 恢复期间请求结果 | 先失败一次 → 自动重试 → 成功（对调用方透明） |

**结论：TTL 设定偏乐观（37.5 < 55），但设计是对的。**
失效判定走的是**响应内容**（检测到挑战页）而非计时器，
所以即使预估超时，也能正确兜住——计时器只是提前规避，内容检测才是兜底。

这意味着：*用户最长会遇到一次约 6s 的额外延迟*，且只在 cookie 恰好过期的那次请求上。
3. **并发上限未探明**：只测到 10 并发（10/10 成功）。`ChictrClient._lock` 串行化底层
   HTTP，所以并发是排队而非真并行。
4. **长驻稳定性未验证**：StealthySession 长时间运行的稳定性未测。
5. **研究实施时间字段轻微粘连**：值内含下一个标签，属已知解析瑕疵。

## 十一、合规提醒

ChiCTR 在 re3data 登记为 **restricted**，页脚为 **All rights reserved.**，
无官方 API、无 bulk 下载。用户已明确表示「先技术验证，合规问题我自己判断」（m00154）。

部署到终端用户前请再次确认数据使用范围。本文件只描述技术实现。

## 十二、相关文件

| 文件 | 职责 |
|---|---|
| `src/runtime/env-probe.ts` | 环境探测（只读、缓存 30s、绝不抛异常） |
| `src/runtime/bootstrap.ts` | 自举（幂等、镜像回退、显式授权） |
| `src/cli/setup-cli.ts` | CLI：doctor / setup / clean / sidecar / postinstall |
| `src/runtime/sidecar-client.ts` | Node → sidecar HTTP 客户端 |
| `sidecar/chictr_sidecar.py` | Python sidecar 服务本体 |
| `src/runtime/env-probe.test.ts` | 12 个探测单测（重点防误报） |
| `dev/browser-removal/SIDECAR_RUNBOOK.md` | sidecar 运维手册 |
| `dev/browser-removal/SIDECAR_VERIFICATION.md` | sidecar 验证报告 |
| `docs/deployment/AUTO_BOOTSTRAP.md` | 首次启动自动激活方案 |
| `docs/deployment/XYB_PI_DESKTOP_INTEGRATION.md` | 与 xyb-pi-desktop 的集成方案 |
