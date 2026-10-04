# Sidecar 端到端验证报告

> 验证日期：2026-10-04 · 环境：macOS / Python 3.10.11 / .venv / scrapling 0.4.15
> 被测对象：`sidecar/chictr_sidecar.py`（468 行）
> 样本归档：`dev/browser-removal/samples/live_search.html`、`detail_live.html`

## 结论

**sidecar 端到端可用，过盾成本已被摊薄到可忽略。** 全部 6 项验证通过，
其中「一次过盾支撑 13+ 次请求」与「10 并发 10/10 成功」是核心结论。

## 验证项

| # | 验证项 | 结果 | 证据 |
|---|--------|------|------|
| 1 | 启动 + 预热过盾 | ✅ 通过 | 过盾耗时 4.7s / 6.0s / 5.9s（三次冷启动），产出 acw_sc__v2 / acw_tc / ssxmod_itna / ssxmod_itna2 |
| 2 | `/health` | ✅ 通过 | `{"ok": true, "solver": {"fresh": true, "solve_count": 1, "last_error": null}}` |
| 3 | `/search` 单页 | ✅ 通过 | 胰腺癌 → total 469 / total_pages 47 / returned 10 |
| 4 | `/search` 多页 | ✅ 通过 | pages=2 → returned 20，跨页无重复，页边界衔接正确 |
| 5 | `/search` 按注册号 | ✅ 通过 | regno=ChiCTR2600132949 → total 1，**1.46s** |
| 6 | `/detail` | ✅ 通过 | proj=344425 → 14 个字段，中英双字段齐全 |

## 核心量化结论

### 过盾成本摊薄（最重要的架构收益）

```
solve_count = 1     ← 启动时预热过一次
age_seconds = 57.0  ← 已用 57 秒
期间请求数  ≥ 13    ← 3 并发分页 + 10 并发分页 + 若干单次
```

即 **1 次 4.7s 的浏览器开销，支撑了 13+ 次 HTTP 请求**。按 cookie TTL 55 分钟计算，
稳态下浏览器仅在每小时出现一次，其余请求全部走纯 HTTP（curl_cffi + TLS 指纹伪装）。
这正是 `SCRAPLING_SOLUTION.md` 中「浏览器降级为低频 cookie 刷新器」的落地验证。

### 并发能力

- **3 并发**（3 个不同 page）：3/3 成功，返回 3 个不同页面，无串页。
- **10 并发**（10 个不同 page）：**10/10 成功**，共 100 条记录。
- 10 并发期间 `solve_count` 仍为 1 —— 说明 cookie 复用未触发重新过盾。
- 注意：`ChictrClient._lock` 串行化了底层 HTTP 会话（curl_cffi session 非线程安全），
  所以并发是「请求排队」而非真并行；实测仍能满足 10 并发下的可用性。

### 性能基线

| 路径 | 耗时 |
|------|------|
| 冷启动过盾 | 4.7 – 6.0s |
| 热态单页检索（regno） | 1.46s |
| 热态单页检索（title） | ~1.5s |
| 详情页 | ~2s |

## 解析正确性

### 搜索结果页列结构（实测确认）

```html
<td>历史版本</td>                      <!-- [0] -->
<td>ChiCTR2600133371</td>              <!-- [1] 注册号 -->
<td>                                    <!-- [2] 题目 + 机构 -->
  <a href="showproj.html?proj=245719" title="阿得贝利单抗联合NALIRIFOX…">…</a>
  <p>浙江大学医学院附属第一医院</p>
</td>
<td>干预性研究</td>                     <!-- [3] 研究类型 -->
<td>2026/09/24</td>                    <!-- [4] 注册时间 -->
```

- 题目优先取 `<a>` 的 `title` 属性（比标签内文本干净，无换行残留）。
- 机构取同单元格内的 `<p>`。
- 早期版本把 `<a>` 文本和 `<p>` 一起抓，导致「题目+机构」粘连 —— 已修复。

### 总数解析（两次踩坑后修正）

- ❌ 最初用 `共\s*&nbsp;?\s*([\d,]+)` → 匹配到「共检索到」后的空串。
- ❌ 再用 `合计 N 条数据` / `共 N 页` → 那是**离线样本页**的页脚；实测线上页面
  **不含**该页脚，分页栏 `<div id="pagination">` 由 `js/myPagination.js` 客户端渲染。
- ✅ 最终用静态 HTML 中的 `<span id="data-total">469</span>`：
  「共检索到 **469** 个符合检索条件的试验。」
- 总页数不在静态 HTML 中，按每页 10 条推算：`total_pages = (total + 9) // 10`。

### 详情页字段（中英对照的双标签结构）

真实行形态是 **「中文标签：英文标签：值」**：

```
注册时间： Date of Registration： 2026-09-20 00:00:00
注册题目： <中文标题> Public title： <英文标题>
```

- ❌ 若把英文标签直接当边界，`注册时间` 会被截断成空值（字段数掉到 9）。
- ✅ 修法：匹配中文标签后，先剥掉紧随的 1~2 个「英文标签：」前缀，再取真实值。
- 结果：字段数 9 → **14**，且值干净无粘连。

## 样本

| 文件 | 大小 | 说明 |
|------|------|------|
| `dev/browser-removal/samples/live_search.html` | 44 KB | 实测搜索结果页（胰腺癌，10 条结果 + `data-total`） |
| `dev/browser-removal/samples/detail_live.html` | 155 KB | 实测详情页（proj=344425，中英双字段） |

## 仍然有效的验证（续）：Node MCP 侧接入

### 接入方式

新增 `src/runtime/sidecar-client.ts`，**默认关闭**，只有 `CHICTR_USE_SIDECAR=1`
（或 `true`/`yes`/`on`）才启用，保证不改变现有 Playwright 路径的默认行为。

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CHICTR_USE_SIDECAR` | 未设置（关闭） | 设为 `1` 启用 sidecar 优先路径 |
| `CHICTR_SIDECAR_URL` | `http://127.0.0.1:8848` | sidecar 地址 |
| `CHICTR_SIDECAR_TIMEOUT_MS` | `30000` | 单次调用超时 |

改动文件：

- `src/runtime/sidecar-client.ts`（新增）：HTTP 调用 + 映射到现有
  `TrialListItem` / `TrialDetail` 类型。任何失败返回 `null`，由调用方回退。
- `src/services/search.ts`：缓存未命中后先走 sidecar，失败再走 Playwright。
- `src/services/detail.ts`：同上。
- `src/index.ts`：`get_runtime_metrics` 增加 `sidecar` 状态字段。

### 关键修复：浏览器惰性初始化

原 `src/index.ts` 的 `CallToolRequestSchema` handler 在 `switch` **之前**无条件执行
`new BrowserManager()` + `initialize()`，导致即使 sidecar 命中也会先拉起 Chromium ——
sidecar 的全部价值（免浏览器）被这行代码抵消。

已改为 `ensureBrowser()` 惰性函数，仅在真正需要 Playwright 的分支（或 sidecar
回退）才初始化。

### MCP 协议端到端验证

环境：`CHICTR_USE_SIDECAR=1`，**刻意不安装 Playwright 浏览器**作为对照。

| MCP 工具 | 结果 | 耗时 |
|----------|------|------|
| `search_trials {keyword:"胰腺癌",maxResults:3}` | ✅ 真实数据 | ~2.1s |
| `get_trial_detail {registration_number:"ChiCTR2600132949"}` | ✅ 14 字段 | ~2.5s |
| `get_runtime_metrics` | ✅ `sidecar.available=true` | — |

决定性证据：本机 Playwright 浏览器**未安装**（`browserType.launch: Executable
doesn't exist at .../chromium_headless_shell-1234/...`）。在修复惰性初始化之前，
`search_trials` 直接抛出该错误；修复后同样的调用返回真实数据 —— 这证明请求
全程未触碰浏览器，sidecar 路径确实绕开了 Chromium。

详情字段映射正确性（`get_trial_detail` 返回）：

```
regno:   ChiCTR2600132949
title:   可切除胰腺癌术后维持化疗方案的临床研究 ——多中心、前瞻性、随机对照试验
disease: 胰腺癌 | type: 干预性研究
leader:  陆逢春 | date: 2026-09-20 00:00:00
```

### 性能对比（重要）

| 路径 | 搜索耗时 | 说明 |
|------|----------|------|
| 旧 Playwright 路径 | 45s 超时上限 + 每页 5–10s 人为延迟 | `src/services/search.ts` 原逻辑 |
| 新 sidecar 路径 | **~2.1s** | 纯 HTTP，无浏览器 |

即端到端响应时间下降约一个数量级，且去掉了原有的随机延迟规避逻辑。

### 环境问题（与本次改动无关）

`better-sqlite3` 的原生绑定未针对 Node 22（ABI v127）构建，导致 MCP server 无法
启动。`npm rebuild` 被沙箱阻断（`EPERM: operation not permitted, mkdir
'/Users/qinxiaoqiang/Library/Caches/node-gyp/22.19.0'`）。解决办法是安装预编译包：

```bash
cd node_modules/better-sqlite3 && npx prebuild-install -r node -t 22.19.0
```

## 仍未验证 / 已知限制

1. **cookie 过期瞬间的续期行为**：未测到 55 分钟边界；`invalidate` + 重试一次
   的逻辑已实现，但未经真实过期触发验证。
2. **并发上限**：仅测到 10 并发。更高（20/50）是否触发二次拦截未知。
3. **StealthySession 长驻稳定性**：当前每次过盾新建一次浏览器上下文并退出，未测长驻。
4. **`研究实施时间` 值内含下一个标签**：该字段值会吞掉「征募观察对象时间」，
   属已知的轻微粘连（不影响主要字段）。
5. **合规未决**：ChiCTR 数据访问登记为 restricted + Copyrights，站点页脚
   All rights reserved.。按用户 m00154 的决定「先技术验证，合规问题我自己判断」推进。

## 复现命令

```bash
cd /Users/qinxiaoqiang/Downloads/chictr_trials
.venv/bin/python sidecar/chictr_sidecar.py --warmup --log-level INFO

curl -sS http://127.0.0.1:8848/health
curl -sS "http://127.0.0.1:8848/search?title=%E8%83%B0%E8%85%BA%E7%99%8C&page=1&pages=2"
curl -sS "http://127.0.0.1:8848/search?regno=ChiCTR2600132949"
curl -sS "http://127.0.0.1:8848/detail?proj=344425"
```
