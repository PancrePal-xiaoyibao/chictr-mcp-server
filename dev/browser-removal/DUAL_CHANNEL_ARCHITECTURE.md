# ChiCTR 浏览器依赖改造：双通道、可降级方案

**日期**：2026-10-04  
**状态**：评估/设计稿；未修改 `src/`、`package.json` 或已构建产物  
**决策**：**不一刀切删除 ChiCTR；把浏览器从硬依赖改为可选增强通道，并以 WHO ICTRP CSV 作为无浏览器的稳定降级通道。**

---

## 1. 先纠正结论：我没有 100% 把握，也不应作此承诺

上一轮把 ICTRP CSV 直接表述为“替代 ChiCTR”的方案，结论过强。它已经证明：**零浏览器的数据通道可用**；但尚未证明：它在所有关键词、所有历史记录、所有 ChiCTR 特有字段上能够等价替代原站。

当前能确定的事实是：

| 事实 | 证据 | 对设计的含义 |
|---|---|---|
| ChiCTR 原站搜索与详情目前持续返回 405 | 直连、中国出口、美国代理、真实 Chromium、英文路径均复现 | 原通道不能作为唯一数据源 |
| WHO ICTRP 的 ASP.NET 搜索可由纯 HTTP 调用 | GET 表单状态 + Cookie；POST `__VIEWSTATE`、`__VIEWSTATEGENERATOR`、`__EVENTVALIDATION`、`TextBox1`、`Button1` | 无浏览器基础通道已验证 |
| ICTRP 结果页的 CSV 导出可取回完整结果集 | 结果页状态 + 仅提交 `Button7=Export to CSV`；IBI343 获得 12 条而非页面 10 条 | 不能只解析页面上的前 10 条 |
| CSV 中存在 ChiCTR 来源记录 | `ChiCTR2300077564`，`Source Register=ChiCTR`，并有 58 列字段 | ICTRP 是有价值的 ChiCTR 镜像/聚合源 |
| ICTRP 不能保证完整或同步 | IBI343 的 12 条中仅 1 条为 ChiCTR；原始详情页独有字段与时效尚未完成覆盖率验证 | 不能宣称“完全替代” |
| 浏览器仍可能在其他部署环境访问 ChiCTR | 当前环境的 405 不等于所有环境永久不可用 | 不能删掉直接源的扩展能力 |

**因此应追求的目标不是“永远不需要浏览器”，而是：**

> 默认安装和默认查询不需要下载 Chromium；当直接 ChiCTR 通道可配置且可用时，它可补齐原始字段；当它不可用时，系统仍以 ICTRP 结果正常工作，并明确说明数据来源与缺口。

---

## 2. 推荐架构：两个数据通道 + 明确来源语义

```text
                 ┌─────────────────────────────┐
search_trials ──►│ SourceRouter                 │
                 │ source=auto|ictrp|chictr     │
                 └──────────────┬──────────────┘
                                │
                ┌───────────────┴────────────────┐
                │                                │
                ▼                                ▼
     ICTRP CSV 通道（核心/必备）       ChiCTR 原始通道（可选增强）
     axios/fetch + Cheerio             Browser adapter / external adapter
     零浏览器、零 Docker                只在明确启用后初始化
                │                                │
                └───────────────┬────────────────┘
                                ▼
                  CanonicalTrial + Provenance
                  字段级来源、时间、降级原因
```

### 2.1 ICTRP CSV 通道：默认、必备、零浏览器

**职责**：搜索、获得全量导出结果、从中筛选 `Source Register = ChiCTR`；必要时读取 `Trial2.aspx` 详情作为补充。

请求链必须严格分阶段，避免上一轮出现的 ASP.NET 事件错误：

```text
1. GET  /Default.aspx
   保存 Cookie；读取 __VIEWSTATE / __VIEWSTATEGENERATOR / __EVENTVALIDATION

2. POST /Default.aspx
   发送上述表单状态、__VIEWSTATEENCRYPTED=''、TextBox1、Button1=Search
   得到“结果页”HTML 与新的 hidden fields

3. POST /Default.aspx
   只发送结果页的 hidden inputs + Button7=Export to CSV
   注意：不得再发送已不在结果页表单中的 TextBox1 或 Button1

4. 解析 CSV，按 TrialID 去重；筛选/标注 Source Register=ChiCTR
```

**实现原则**：
- Cookie jar 与表单状态仅在一次完整链路中使用；绝不复用过期 viewstate。
- 导出响应必须验证 `Content-Type: application/vnd.ms-excel`（或 CSV 内容）和 `Content-Disposition`；绝不把 `NoAccess.aspx` 当成功结果。
- 将 HTML `12 records`、CSV 实际行数、ChiCTR 行数记录为可观测指标。
- CSV 是搜索结果的权威全量载体；`Trial2.aspx` 是单条详情补充，不能反过来假设其字段比 CSV 完整。
- 仍须限制频率、缓存、指数退避；不可把 ICTRP 当无限制 API。

### 2.2 ChiCTR 原始通道：可选增强，绝不是默认依赖

**职责**：仅在可用时取得 ChiCTR 原始 HTML，补齐 ICTRP 没有或可能失真的字段（例如中文原文、项目页特有结构、project id 对应关系）。

它不应再由 `src/index.ts` 的所有工具调用无条件启动。改造后应抽象为：

```ts
interface DirectChictrProvider {
  isAvailable(): Promise<boolean>;
  search(input: SearchInput): Promise<ProviderSearchResult>;
  getDetail(registrationNumber: string): Promise<ProviderDetailResult>;
}
```

可实现为：
1. **本地 Browser adapter（可选）**：只有用户显式安装/配置 Playwright 或系统 Chrome 时启用；不再用 `postinstall` 下载 Chromium。
2. **外部 adapter（可选）**：企业已有的受控浏览器、合规采集服务或类似 FlareSolverr 的服务，通过 HTTP 接口接入；该服务的浏览器成本不转嫁为本 npm 包安装成本。
3. **禁用状态（正常状态之一）**：未配置即返回 `available: false`，不是启动错误。

> 当前 405 不是“用更多模拟头或更激进的绕过”应解决的问题。本设计只保留合法部署环境中已有的直接数据访问能力；不把绕过 WAF 作为交付承诺。

---

## 3. 路由与降级策略

### 3.1 `source` 参数：让调用方有控制权

为现有工具新增可选枚举，而不是静默改变语义：

```ts
type SourcePreference = "auto" | "ictrp" | "chictr";
```

| 值 | 行为 | 适用场景 |
|---|---|---|
| `auto`（默认） | 先使用 ICTRP 快速得到可用结果；若启用的 ChiCTR 通道可用且需要补充字段，则补充/合并 | 面向普通用户的稳健默认值 |
| `ictrp` | 只走 HTTP + CSV；绝不初始化浏览器 | 轻量部署、稳定批量检索、可复现任务 |
| `chictr` | 只走直接原始通道；不可用时返回结构化 `SOURCE_UNAVAILABLE`，**不偷偷切源** | 必须原站字段、审计严格的调用方 |

默认 `auto` 选择“ICTRP 先返回”，是因为它已经在当前环境验证可用；它不等价于宣称 ICTRP 是 ChiCTR 的完整替代。

### 3.2 搜索降级矩阵

| 条件 | `auto` 行为 | 返回语义 |
|---|---|---|
| ICTRP CSV 成功；直接源禁用/不可用 | 返回 ICTRP 结果 | `source_used: ["ictrp_csv"]`，`direct_source_status: "unavailable"` |
| 两者成功 | 以 `registration_number`/`TrialID` 合并；直接源字段优先但保留 ICTRP 值及出处 | `source_used: ["ictrp_csv", "chictr_direct"]` |
| ICTRP 成功；直接源 405/超时/挑战 | 返回 ICTRP，记录直接源失败 | `degraded: true`，但不把“降级”伪装成“无结果” |
| ICTRP 无 ChiCTR 命中，直接源成功 | 返回直接源结果 | 明确 `coverage_warning`：ICTRP 未命中不证明 ChiCTR 无记录 |
| 两者失败 | 返回结构化错误和每通道诊断 | 禁止返回空数组伪装“无结果” |

### 3.3 详情降级矩阵

详情请求可能由 ICTRP CSV 直接提供足量字段；仅当调用方需要缺失字段时再请求详情页或直接源。

1. 先查持久缓存（需存 `source`、抓取时间、字段完整度）。
2. `auto`：读取 ICTRP CSV/详情；计算缺字段集合。
3. 仅在直接源 adapter 已启用且“缺字段集合”属于直接源可补齐字段时调用它。
4. 合并时采用**字段级优先级**，而不是整个对象覆盖：
   - ChiCTR 原始中文字段优先；
   - ICTRP CSV 的 `Phase`、`Primary outcome`、`Secondary outcome`、联系人等在原始通道未提供时保留；
   - 冲突字段同时返回 `value`、`source`、`retrieved_at`，或至少记录到 `_provenance`。

---

## 4. 返回模型：数据来源必须可见

不能继续返回“看起来像 ChiCTR 原始结果”的裸对象。最低限度在 MCP JSON 外层或每条记录加：

```ts
interface DataProvenance {
  source_used: Array<"ictrp_csv" | "ictrp_detail" | "chictr_direct">;
  retrieved_at: string;
  direct_source_status?: "disabled" | "available" | "unavailable" | "failed";
  degraded: boolean;
  coverage_warning?: string;
  source_urls: string[];
}
```

对于 ICTRP 记录，`registry` 不能写成单纯的 `ChiCTR`，应准确区分：

```json
{
  "registry": "ChiCTR via WHO ICTRP",
  "source_register": "ChiCTR",
  "source_url": "https://trialsearch.who.int/...",
  "original_registry_url": "https://www.chictr.org.cn/showproj.html?proj=..."
}
```

这样客户端才可判断：这是原站实时数据、WHO 聚合副本，还是双源合并结果。

---

## 5. 分阶段实施，避免主版本风险

### Phase 0 — 先建测试资产，不改行为

放在 `dev/browser-removal/`：
- 录制并脱敏 ICTRP 表单、结果 HTML、CSV fixture。
- 覆盖以下断言：form 状态提取、Cookie 回传、导出 POST 不含 `Button1`/`TextBox1`、CSV 58 列、IBI343 CSV 有 12 条且含 `ChiCTR2300077564`。
- 用多组关键词测量：总 CSV 行数、ChiCTR 行数、唯一 ChiCTR ID、字段空值率、与直接源（若可访问）的重叠率。

**退出条件**：可以在离线 fixture 上稳定重放解析，不依赖外站。

### Phase 1 — 引入 ICTRP provider，但保持现有 ChiCTR 行为

新增独立模块（建议路径）：

```text
src/providers/types.ts
src/providers/ictrp-provider.ts
src/providers/source-router.ts
src/parsers/ictrp-csv-parser.ts
```

- 先只实现 `source: "ictrp"` 的显式新路径或新工具；不触动现有 `searchTrials()` 的默认行为。
- 复用现有 `RequestOrchestrator`、`CacheManager`、错误分类基础设施，而不是复制一套缓存。
- 新缓存键包含 provider/schema：`ictrp:v1:search:<normalized-query>`，避免与原 ChiCTR 缓存混淆。

**退出条件**：新增路径单元测试、fixture 测试、真实低频 smoke test 全通过。

### Phase 2 — 做成 `auto` 双通道路由

- 浏览器初始化从全局无条件初始化改为 provider 懒初始化。
- `auto` 默认 ICTRP-first；仅当设置 `CHICTR_DIRECT_PROVIDER` 且所需字段不足时调用直接 provider。
- 加结构化来源/降级元数据和指标。

**退出条件**：直接 provider 被断开时，`auto` 仍返回 ICTRP 数据；直接 provider 可用时，不丢失其字段；两种结果均可溯源。

### Phase 3 — 去除硬浏览器安装成本（最后做，不抢跑）

- 删除 `postinstall: playwright install chromium`。
- 将 Playwright 移到 `optionalDependencies` **或** 从核心包中移除、由外部 adapter 持有。
- README 明确三个部署等级：`ICTRP only`（默认）、`ICTRP + local browser`（可选）、`ICTRP + external direct provider`（可选）。

**退出条件**：`npm install` 不下载浏览器；没有 Playwright 的 clean install 能执行 ICTRP 查询与所有缓存/状态工具。

---

## 6. 不应做的事

1. **不立刻删除 `src/browser.ts` 或 `src/services/{search,detail}.ts`**：这会把尚未测量的原站字段覆盖率风险直接变成不可逆功能损失。
2. **不把 ICTRP 未命中解释为“ChiCTR 没有记录”**：它可能是同步延迟、英文/中文关键词差异、索引策略或覆盖差异。
3. **不把 HTTP 200 当成功**：ICTRP `NoAccess.aspx` 可返回 200；必须检查内容类型、错误页文本、CSV header/行数。
4. **不在任何工具调用时启动 Chromium**：缓存统计、清缓存、ICTRP-only 请求都不该产生浏览器进程。
5. **不把 FlareSolverr 叫作“无浏览器”**：它可以是外部可选 adapter，但其运行成本和合规责任必须明确。

---

## 7. 目前的置信度与待验证项

| 判断 | 置信度 | 原因 | 需要补的验证 |
|---|---:|---|---|
| 可以让默认安装不下载约 500MB Chromium | 高 | ICTRP 表单搜索与 CSV 全链路已实测，且不依赖 JS/浏览器 | clean install + 回归测试 |
| ICTRP CSV 可绕过网页 10 条显示限制 | 高 | IBI343：页面 10 条、显示 12 records、CSV 实得 12 条 | 大结果集（>100）确认导出上限 |
| CSV 可提供部分 ChiCTR 数据 | 高 | IBI343 CSV 实得 `ChiCTR2300077564` 且字段丰富 | 多关键词覆盖率统计 |
| ICTRP 可完全替代 ChiCTR | **低；未证实** | 已有 ChiCTR 记录，但单样本覆盖率不足；同步和字段等价性未知 | 关键词矩阵 + 注册号对照 + 时效统计 |
| 可保留可用的直接增强通道 | 中 | 接口隔离与懒初始化是成熟工程手段；当前环境原站 405 | 在合法可访问的部署环境集成测试 |
| 当前 ChiCTR/Playwright 可恢复可用 | 未知 | 当前多个出口和 Chromium 均为 405 | 不作为本方案的前提 |

---

## 8. 最终建议

接受你的判断：**改造应采用双通道降级，而不是删除一个通道后押注另一个通道。**

推荐的产品承诺应写成：

> “默认使用 WHO ICTRP 的纯 HTTP CSV 通道，因此不再强制下载浏览器；若部署者配置了可用的 ChiCTR 直接 provider，系统会把它作为可追溯的字段增强来源。任一通道不可用时，系统会显式报告来源与降级状态，不会静默返回空结果或伪装成原站数据。”

这比“完全删除浏览器并由 ICTRP 100% 替代 ChiCTR”更准确、更可维护，也符合当前全部实测证据。
