# ChiCTR Sidecar 运行手册

让 MCP server 绕过阿里盾 405 的两段式部署：Python sidecar 负责过盾与抓取，
Node MCP server 负责对外协议。**默认关闭**，不影响现有 Playwright 路径。

## 架构

```
MCP 客户端
   │  stdio (MCP 协议)
   ▼
Node MCP server (dist/index.js)
   │  CHICTR_USE_SIDECAR=1 时优先走这里
   │  HTTP JSON (127.0.0.1:8848)
   ▼
Python sidecar (sidecar/chictr_sidecar.py)
   │  ├─ 纯 HTTP + TLS 指纹伪装（curl_cffi）── 常规请求
   │  └─ StealthySession 无头浏览器 ──────── 仅 cookie 过期时过盾（约每小时 1 次）
   ▼
www.chictr.org.cn
```

核心机制：阿里盾的 `acw_sc__v2` cookie 有效期约 1 小时。sidecar 只在需要时
启动一次浏览器解挑战，随后用它返回的 cookie 走纯 HTTP 请求。实测 **1 次过盾
（约 5s）支撑 13+ 次请求**，10 并发全部成功。

失败时自动回退 Playwright，对外契约不变。

## 前置条件

```bash
cd /Users/qinxiaoqiang/Downloads/chictr_trials
python3 -m venv .venv                                  # 已创建
.venv/bin/pip install "scrapling[fetchers]"            # 已安装（含 patchright/curl_cffi）
.venv/bin/scrapling install                            # 已安装浏览器内核
```

注意：`pip install --user` 在本机会因权限失败（`Operation not permitted`），
必须用 venv。

## 启动

### 1. 启动 sidecar

```bash
cd /Users/qinxiaoqiang/Downloads/chictr_trials
.venv/bin/python sidecar/chictr_sidecar.py --warmup --log-level INFO
```

- `--warmup`：启动时先过一次挑战，首次请求无需等待（推荐）。
- 默认监听 `127.0.0.1:8848`，可用 `--host` / `--port` 覆盖。
- 启动成功的标志：

```
INFO chictr_sidecar: 过盾成功，耗时 4.7s，cookie=['acw_sc__v2', 'acw_tc', 'ssxmod_itna', 'ssxmod_itna2']
INFO chictr_sidecar: ChiCTR sidecar 监听 http://127.0.0.1:8848
```

> 日志里的 `ERROR: No Cloudflare challenge found.` 是 **正常噪声**：ChiCTR 用的是
> 阿里盾而非 Cloudflare，Scrapling 的 CF solver 找不到 CF 挑战便打印该行。真正
> 起作用的是 patchright 的指纹补丁 + 真实浏览器导航。

### 2. （可选）验证 sidecar

```bash
curl -sS http://127.0.0.1:8848/health
curl -sS "http://127.0.0.1:8848/search?title=%E8%83%B0%E8%85%BA%E7%99%8C&page=1&pages=1"
curl -sS "http://127.0.0.1:8848/search?regno=ChiCTR2600132949"
curl -sS "http://127.0.0.1:8848/detail?proj=344425"
```

### 3. 启动 MCP server（启用 sidecar）

```bash
CHICTR_USE_SIDECAR=1 node dist/index.js
```

或写入 MCP 客户端配置：

```json
{
  "mcpServers": {
    "chictr": {
      "command": "node",
      "args": ["/Users/qinxiaoqiang/Downloads/chictr_trials/dist/index.js"],
      "env": { "CHICTR_USE_SIDECAR": "1" }
    }
  }
}
```

## 接口

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| GET | `/health` | — | `{ok, solver:{fresh, age_seconds, solve_count, last_error, cookie_names}}` |
| GET | `/search` | `title`、`regno`、`createyear`、`page`、`pages` | `{ok, total, total_pages, returned, pages_fetched, results[]}` |
| GET | `/detail` | `proj` | `{ok, registration_number, fields{}, field_count}` |

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

## 监控

```bash
# 是否在线 + cookie 状态
curl -sS http://127.0.0.1:8848/health

# 通过 MCP 工具查看
# get_runtime_metrics -> { sidecar: { enabled, available, baseUrl, lastError } }
```

`/health` 的关键字段：

- `solver.fresh`：cookie 是否仍在有效期内（TTL 55 分钟）。
- `solver.solve_count`：累计过盾次数。稳态下应长期为 1（约每小时 +1）。
- `solver.last_error`：最近一次过盾失败原因，正常为 `null`。

`solve_count` 快速上涨说明 cookie 被反复判失效，应检查是否被限流。

## 排障

| 现象 | 原因 | 处理 |
|------|------|------|
| `/health` 连不上 | sidecar 未启动 | 按上面第 1 步启动 |
| 日志 `ERROR: No Cloudflare challenge found.` | ChiCTR 用阿里盾不是 CF | 正常，忽略 |
| `{"error":"challenge_unsolved"}` (503) | 过盾后仍返回挑战页 | 查看日志中的过盾失败原因；通常是 IP 被限流，稍后重试 |
| MCP 返回 Playwright 报错 | sidecar 未启用或不可达 | 确认 `CHICTR_USE_SIDECAR=1`，且 `curl /health` 正常 |
| `Executable doesn't exist ... chromium_headless_shell` | Playwright 浏览器未安装 | 这是**回退路径**才需要的；若 sidecar 正常则不该出现 |
| MCP server 启动即崩，`Could not locate the bindings file` | `better-sqlite3` 未针对当前 Node ABI 构建 | 见下 |

### better-sqlite3 原生绑定

Node 22（ABI v127）下若报绑定缺失：

```bash
cd /Users/qinxiaoqiang/Downloads/chictr_trials/node_modules/better-sqlite3
npx prebuild-install -r node -t 22.19.0
```

`npm rebuild` 在受限沙箱下会失败（无法写 `~/Library/Caches/node-gyp`），
用预编译包可绕过。

## 并发与配额

- 实测 10 并发 10/10 成功，期间 `solve_count` 保持 1（未触发重新过盾）。
- 内部 `ChictrClient._lock` 串行化底层 HTTP 会话（curl_cffi 非线程安全），
  因此并发是「排队」而非真并行；10 并发下仍满足可用性。
- 并发上限尚未探测（>10 未测），请勿盲目加大。

## 合规提醒

ChiCTR 在 re3data 登记为**数据访问 restricted + 许可 Copyrights**，站点页脚为
`All rights reserved.`，且无官方 API/bulk 通道。WHO ICTRP 官方声明
"at no charge" 但禁商业用途，其 XML Web Service 明文禁止本地存储数据。

本 sidecar 按「先技术验证」推进，**合规判断需自行确认**。相关背景见
`dev/browser-removal/SCRAPLING_SOLUTION.md` 与 `ICTRP_PROTOCOL_FINDINGS.md`。

## 相关文件

| 文件 | 说明 |
|------|------|
| `sidecar/chictr_sidecar.py` | sidecar 实现（过盾 + 解析 + HTTP 服务） |
| `src/runtime/sidecar-client.ts` | Node 侧客户端（默认关闭，失败自动回退） |
| `dev/browser-removal/SIDECAR_VERIFICATION.md` | 端到端验证报告与实测数据 |
| `dev/browser-removal/SCRAPLING_SOLUTION.md` | 过盾可行性三层证据 |
| `dev/browser-removal/samples/` | 归档的实测页面样本 |
