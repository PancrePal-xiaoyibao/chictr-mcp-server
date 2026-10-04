# ChiCTR 浏览器硬依赖移除：改造规格（v2，聚焦 WHO ICTRP CSV 通道）

**日期**：2026-10-04  
**状态**：评估/设计规格；仅位于 `dev/browser-removal/`，尚未修改 `src/`、`package.json` 或构建产物。  
**目标**：默认安装与默认查询不下载约 557 MB Chromium；数据来自**唯一已验证的零浏览器官方通道**（WHO ICTRP CSV）；任何通道失败均应可见、可溯源、不可伪装为“无结果”。

> **v2 相对 v1 的变化**：删除了所有依赖「ChiCTR 直接访问可用」的设计。经本会话实测与调研，ChiCTR 原站当前**不存在**可用的自动访问路径（见 §2）。v1 的「双通道降级」架构中，第二通道没有任何经过验证的实现方式，因此降级为**单一 ICTRP 通道 + 显式的状态报告**。

---

## 1. 决策摘要

**采用「WHO ICTRP CSV 单一通道 + 严格来源语义」的架构。删除 ChiCTR 直接访问相关的一切设计。**

| # | 决策 | 原因 |
|---|---|---|
| 1 | ICTRP CSV 是唯一数据通道，纯 HTTP、零浏览器 | 已实测 `GET 表单 → 搜索 POST → CSV 导出 POST` 全链路成功，9,273 行 / 39 MB / 58 列。这是官方免费通道（"at no charge"）。 |
| 2 | **删除** `DirectChictrProvider` / `ChictrSessionProvider` / 浏览器 adapter / 外部 adapter（如 FlareSolverr）的设计 | 第二通道无任何经过验证的实现。保留它只会制造「配置了却用不了」的空壳。 |
| 3 | **删除**所有 WAF 会话、Cookie 重放、过盾相关设计 | 实测：对话中的 Cookie 与 `.env` 新鲜 Cookie 在直连与代理两种出口下**全部 405**；挑战脚本在 Node 与真实 Chromium 中**均死循环**；第三方 solver 只是把 Chromium 换成另一个必须跑通死循环的 JS 运行时。见 §2.1。 |
| 4 | **删除** Playwright 依赖与 `postinstall: playwright install chromium` | 这是用户的原始目标。ICTRP 通道不渲染 JS，Cheerio 足够。 |
| 5 | 结果必须携带来源、抓取时间与**时效警告** | ICTRP 是每周同步的聚合副本，**不是** ChiCTR 原站实时数据；且是否覆盖全量未确认。 |
| 6 | 失败必须结构化，禁止伪空结果 | 当前 WAF 页 `<title>405</title>` 会被 `HtmlParser.parseSearchResults()` 解析成 `[]`，与「真正无结果」不可区分。这是 P0 缺陷（§6.1）。 |
| 7 | 依赖 WHO 数据条款：署名、保持更新、显示处理日期、禁商业用途 | WHO 条款明文约束，且 "apply to all data obtained from the WHO ICTRP, **independent of format and method of acquisition**"。见 §5.3。 |

### 1.1 已验证证据与边界

| 事实 | 证据（本会话实测） | 设计含义 |
|---|---|---|
| ICTRP ASP.NET 搜索链可纯 HTTP 调用 | 正确回传 Cookie + `__VIEWSTATE` / `__VIEWSTATEGENERATOR` / `__EVENTVALIDATION`；导出只提交结果页 hidden fields + `Button7=Export to CSV` | 可实现为唯一数据来源。 |
| CSV 导出可用且数据量大 | `pancreatic` → **HTTP 200**，`Content-Type: application/vnd.ms-excel`，`Content-Disposition: attachment;filename=IctrpResults.csv`，**39,462,912 bytes / 9,273 行 / 58 列**，页面显示 "10354 records" | 单次请求即可获得全量结果，无需分页抓取。 |
| ICTRP 含 ChiCTR 记录且字段较全 | Source Register 分布：ClinicalTrials.gov 5276、JPRN 1476、**ChiCTR 990**、EU CTR 426、NL-OMON 212、CTRI 185、GDR 157、CTIS 129。ChiCTR 行字段完整度：`Scientific title` 990/990、`Phase` 990/990、`Recruitment Status` 990/990、`Primary outcome` 989/990、`Intervention` 988/990 | 可提供有价值的 `ChiCTR via WHO ICTRP` 数据。 |
| ChiCTR 原站**无任何官方 API / 批量通道** | `/api`、`/api/trials`、`/robots.txt`、`/sitemap.xml`、`/bin/chictr/search` 全部 404；`/swagger-ui.html` 返回中文「404系统找不到页面」；`file.html` 下载区只有一个一次性 COVID-19 专题 XLSX | 没有可申请的官方通道，不存在「走正规途径拿原站数据」的选项。 |
| ChiCTR 对自动访问当前不可用 | 本机直连 `/index.html`=200、`/searchproj.html`=**405**；curl / 多出口 / 真实 Chromium 全部被拦截；换 IP 只把硬 405 降级为**跑不通的 JS 挑战** | 不能把 ChiCTR 直接访问作为任何通道。 |
| ChiCTR 数据受版权与访问限制 | re3data：访问类型 "open" 但**数据访问 "restricted"**、另有 "embargoed"、许可 "Copyrights"。站点页脚 `All rights reserved.` 蜀ICP备16010396号-9 | **不得再分发原站数据**；本项目只转发 ICTRP 官方通道的聚合结果。 |
| ICTRP 与 ChiCTR 不等价 | 样本 `ChiCTR2000030254` 的 `Last refreshed on: 23 March 2020` 明显落后；ICTRP 是否载有全量 131,244 条未确认 | 必须暴露时效警告；**ICTRP 未命中 ≠ ChiCTR 不存在**。 |

> **来源语义**：ICTRP 命中的 ChiCTR 记录必须标记为 **`ChiCTR via WHO ICTRP`**，绝不写成「ChiCTR 实时/直接数据」。

---

## 2. 已排除的方向（不再投入）

以下方向经实测或调研**明确否决**，v2 不再为它们保留任何设计位。保留在此仅为避免重复探索。

### 2.1 WAF 绕过 / 过盾 / Cookie 重放 —— ❌ 三条独立理由

**技术**：ChiCTR 投放的阿里云盾挑战含成对的反分析陷阱：

```js
while(window['__phantomas']){}                 // 反 PhantomJS 死循环
_0x355d23(++_0x450614);                        // 无限递归，靠 try/catch 兜栈溢出
setInterval(function(){_0x4db1c0();},0xfa0);   // 每 4 秒重入
```

实测：在 Node + DOM shim 中 eval 该 16,715 字节脚本 → **退出码 0 但 stdout 为 0 字节**，后续 `console.log` 永不执行；换**真实 Chromium** `page.setContent` 让它自己跑 → **同样卡死**（120 s 超时）。手工逆向（RC4 + atob 配方，枚举全部 key）输出全为不可打印乱码。

**架构**：生态中的 solver（`WangYihang/acw-sc-v2-py`、`acw-sc-v2.js`、`acw-sc-v2-go`）工作方式是起一个**本地 Node 服务**执行混淆 JS。这**不是移除浏览器依赖，而是把 Chromium 换成另一个 JS 运行时**——而该运行时同样得先跑通上述死循环。用户的原始目标毫无推进。

**合规**：拦截本身即是站点的访问决策，绕过它与站点明确意图对抗。

**Cookie 重放实测（三次）**：对话中暴露的 Cookie（直连）→ 405；`.env` 中未暴露的新鲜 Cookie（直连）→ 405；同一新鲜 Cookie 经 `http://127.0.0.1:7890` 代理 → 405。响应均为 2,569 字节拦截页。**结论**：WAF 会话很可能与浏览器指纹/出口 IP 绑定，仅复制 Cookie 不足以复现。**不假设存在可用的自动刷新机制。**

### 2.2 其他已排除项

| 方向 | 否决理由 |
|---|---|
| Cloudflare 过盾（IUAM / Turnstile） | **根本不是本项目面对的 WAF**。ChiCTR 用阿里云盾。 |
| ICTRP **XML Web Service** | 条款明文：**"You may not locally store any of the data accessed via the web service."** 与本地缓存架构天然冲突。费用需询 `ictrpinfo@who.int`。 |
| ICTRP **Crawling Service** | 官方页面："**This service is currently not available.**" |
| ICTRP 每周全量 CSV（SharePoint） | **仅限机构申请**（"this form is not for individual requests"），按规模缴年费。见 §5.4。 |
| ResMan 平台 | 自持仅 **11,172** 条（vs ChiCTR 131,244），是研究者自愿存缴的 IPD/EDC 平台，**不是注册库镜像**。官方立场是「只能浏览，不提供下载，要下载数据必须与研究者联系」。 |
| 逐个抓取 `Trial2.aspx` 详情 | 仅在 CSV 字段不足时才考虑；CSV 单次已覆盖全量结果，逐条抓取徒增请求量。见 §4.3。 |
| 商业聚合方（药智网等） | 未验证其授权来源；不予依赖。 |

---

## 3. 目标架构

```text
                          MCP tools
               search_trials / get_trial_detail
                              │
                              ▼
                    IctrpProvider  (唯一通道)
                    纯 HTTP、零浏览器
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  GET 搜索表单          POST 搜索              POST CSV 导出
  取 ASP.NET state      取结果页 state         取 application/vnd.ms-excel
        │                     │                     │
        └─────────────────────┴─────────────────────┘
                              │
                              ▼
                    IctrpCsvParser
                    58 列 → TrialRecord
                    按 Source Register 过滤/标注
                              │
                              ▼
              TrialRecord + DataProvenance
              来源、抓取时间、时效警告、字段完整度
```

**没有第二通道、没有路由降级矩阵、没有浏览器。**

### 3.1 建议模块

```text
src/providers/types.ts            # TrialRecord / DataProvenance / 错误码
src/providers/ictrp-provider.ts   # 三步请求链 + state 管理
src/parsers/ictrp-csv-parser.ts   # 58 列 CSV → TrialRecord
src/runtime/ictrp-errors.ts       # 错误分类（或扩展 src/runtime/errors.ts）
```

**复用**现有：`RequestOrchestrator`（限流/退避/熔断）、`CacheManager`（L1/L2）。

**保留**现有 `src/parsers/html-parser.ts` 与 `src/browser.ts` 不动——前者是 ChiCTR HTML 解析器，本规格不改变其行为；后者本规格不删除（见 §7 Phase 3 讨论）。

### 3.2 核心接口

```ts
export interface DataProvenance {
  source: "ictrp_csv";
  source_register?: string;        // 例如 "ChiCTR"
  retrieved_at: string;            // ISO 8601，本系统抓取时间
  ictrp_export_date?: string;      // CSV 的 "Export date" 列
  ictrp_last_refreshed?: string;   // CSV 的 "Last Refreshed on" 列
  data_currency_warning?: string;  // ICTRP 每周同步，非实时
  source_url: string;              // https://trialsearch.who.int/
  field_completeness?: Record<string, number>;
}
```

---

## 4. 请求链、解析与返回语义

### 4.1 三步请求链（实测可用）

```text
1. GET  /Default.aspx
   保存响应 Cookie；读取 __VIEWSTATE、__VIEWSTATEGENERATOR、__EVENTVALIDATION。

2. POST /Default.aspx
   发送以上 state、__VIEWSTATEENCRYPTED=''、TextBox1=<keyword>、Button1=Search。
   Referer: https://trialsearch.who.int/Default.aspx
   保存结果页 Cookie 与新的 hidden inputs。

3. POST /Default.aspx
   只发送「结果页」hidden inputs + Button7=Export to CSV。
   ❌ 不得携带结果页已不存在的 TextBox1 / Button1
      —— 这是早期失败的原因：返回 302 → /NoAccess.aspx?aspxerrorpath=/Default.aspx
   期望：200 + Content-Type: application/vnd.ms-excel
```

### 4.2 必须实施的护栏

- Cookie 与 viewstate 只能在**同一次完整链路**内使用；不可复用旧页面状态。
- `HTTP 200` **不是**成功依据。必须检测：`NoAccess.aspx`、错误页正文、非 CSV content type、空 header、`Location` 重定向。
- 记录：页面报告的总记录数、CSV 行数、`Source Register=ChiCTR` 行数、去重后 ID 数、字段空值率。
- **CSV 是搜索全量结果的权威载体**；结果页只显示 10 条并不代表总数（实测页面 10 条 / CSV 12 条 / 页面声明 10354 records）。
- 使用 `RequestOrchestrator` 维持低频率、指数退避与可观测性。

### 4.3 详情获取策略

**默认：只查缓存与 CSV。** 若目标记录已在既有搜索结果缓存中，直接返回，不发起新请求。

**仅在以下条件同时满足时**，才 GET `Trial2.aspx?TrialID=<id>` 补充：
1. 缓存未命中；且
2. 调用方请求的字段在 CSV 中确为缺失。

抓取到的详情必须与 `TrialID` 一致，不一致则拒绝入库。

### 4.4 字段映射要点（58 列，实测列名，注意拼写）

`TrialID`、`Last Refreshed on`、`Public title`、`Scientific title`、`Acronym`、`Primary sponsor`、`Date registration`、`Date registration3`、`Export date`、`Source Register`、`web address`、`Recruitment Status`、`other records`、**`Inclusion agemin`**、**`Inclusion agemax`**、`Inclusion gender`、**`Date enrollement`**、`Target size`、`Study type`、`Study design`、`Phase`、`Countries`、`Contact Firstname`、`Contact Lastname`、`Contact Address`、`Contact Email`、`Contact Tel`、`Contact Affiliation`、`Inclusion Criteria`、`Exclusion Criteria`、`Condition`、`Intervention`、`Primary outcome`、`Secondary outcome`、`Secondary ID`、`Source Name`、`Secondary Sponsor`、`Ethics Status`、`Ethics Approval Date`、`Ethics Contact Name`、`Ethics Contact Address`、`Ethics Contact Phone`、`Ethics Contact Email`、**`results yes no`**、`results date posted`、`results url link`、`results url protocol`、`results date completed`、`results date first publication`、`results summary`、`results baseline char`、`results adverse events`、`results outcome measures`、`results ipd plan`、`results ipd description`、`Prospective registration`、`Bridging flag truefalse`、`Bridged type`

> ⚠️ 列名含拼写错误（`agemin`/`agemax`/`enrollement`）与空格式命名，解析器必须按**原样字符串**匹配，不得"纠正"。

### 4.5 来源语义

```json
{
  "trial_id": "ChiCTR2300077564",
  "registry": "ChiCTR via WHO ICTRP",
  "source_register": "ChiCTR",
  "_provenance": {
    "source": "ictrp_csv",
    "retrieved_at": "2026-10-04T00:00:00.000Z",
    "ictrp_last_refreshed": "2024-01-15",
    "data_currency_warning": "ICTRP 每周由各注册库同步，非 ChiCTR 原站实时数据；记录可能滞后。",
    "source_url": "https://trialsearch.who.int/"
  }
}
```

**缺失字段必须是 `null` + 说明**，不可用空字符串掩盖。

---

## 5. 合规与数据条款

### 5.1 可用的免费通道（本项目的依据）

WHO 官方页面原文：**"ICTRP data are publicly available for downloading from the Search Portal to all requesters, at no charge."** / **"ICTRP is updated weekly."**

### 5.2 WHO 数据条款（必须遵守）

- 标注来源为 WHO ICTRP；
- 保持数据更新；
- **清楚显示 WHO 处理该数据的日期**；
- **"You shall not assert any proprietary rights to any portion of the ICTRP database."**
- 不得用于营销/推广/商业用途；
- 不得使用 WHO 名称或徽标；
- **"These Terms and Conditions apply to all data obtained from the WHO ICTRP, independent of format and method of acquisition."**

### 5.3 必须实现

- 每个返回结果附 `source_url: "https://trialsearch.who.int/"`；
- 每个返回结果附 `ictrp_last_refreshed` / `ictrp_export_date` 与时效警告；
- README 中的来源与免责声明；
- **不做**：把数据打包成"ChiCTR 数据集"再分发；任何商业用途；使用 WHO 徽标。

### 5.4 不采用的通道（已排除）

XML Web Service（禁本地存储）、Crawling Service（不可用）、SharePoint 全量 CSV（仅限机构 + 年费，申请地址 `https://extranet.who.int/dataformv6/index.php/643633?lang=en`）。

---

## 6. 错误、缓存与安装行为

### 6.1 P0：修复「封锁静默为空结果」

**这项独立于本改造，且优先级最高。** 当前 `src/services/search.ts` 与 `src/services/detail.ts` 在 `page.goto()` 后没有任何 HTTP 状态检查（`grep "405\|status()\|checkStatus\|Tengine\|acw_sc" src/` 零命中）。WAF 页 `<title>405</title>` 会被 `HtmlParser.parseSearchResults()` 解析成空数组，**使封锁与真正的「没有试验」不可区分**。

必须检测并在 `src/runtime/errors.ts` 中新增：

```ts
WAF_BLOCKED       = "WAF_BLOCKED"
SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE"
NOT_SYNCED        = "NOT_SYNCED"
```

检测信号：HTTP 403/405/429；`<title>4xx</title>`；阿里云盾拦截文案；`acw_sc__v2` 等挑战特征；非空 HTML 中缺失应有数据结构。

`WAF_BLOCKED` / `SOURCE_UNAVAILABLE` **不能**序列化为空数组或字段全空的 detail。

### 6.2 缓存

缓存键必须包含 schema 版本：

```text
ictrp:v1:search:<normalized-query>
ictrp:v1:detail:<trial-id>
```

缓存值须含 provenance、抓取时间与字段完整度。ICTRP 每周更新，搜索缓存的 TTL 应与之匹配（建议 ≥ 24 h，而非现有 ChiCTR 的 5 min）。

### 6.3 安装与浏览器

- **删除** `package.json` 的 `"postinstall": "playwright install chromium"`；
- **移除** `playwright` 依赖（当前 `^1.56.1`，锁定安装为 1.62.1，缓存 557 MB）。若需保留可选能力，放入 `optionalDependencies` 并在 README 说明；
- `src/index.ts` 中无条件的 `if (!browserManager) { browserManager = new BrowserManager(); await browserManager.initialize(); }` 必须移除——当前**任何**工具调用（含 `get_cache_stats`、`clear_cache`）都会启动 Chromium；
- 若保留 `BrowserManager`，只能在显式启用时按需加载，初始化失败不得影响 ICTRP 查询与缓存工具。

---

## 7. 分阶段实施与退出条件

### Phase 0 — 离线测试资产与失败可见性（不改默认数据源）

1. 在 `dev/browser-removal/fixtures/` 创建脱敏的 ICTRP 表单、结果页与 CSV fixture；
2. 断言表单 state 提取、Cookie 回传、导出 POST **不含** `Button1` / `TextBox1`；
3. 断言 CSV 解析 58 列；含 `ChiCTR2300077564` 的样本正确映射；
4. 为 403/405/WAF/缺表格场景增加回归测试，确保不返回伪空结果。

**退出条件**：provider/parser 行为可离线重放；403/405 与「真实零结果」可明确区分。

### Phase 1 — IctrpProvider 与 CSV parser

1. 实现 `IctrpProvider`（三步链）与 `IctrpCsvParser`；
2. 复用 `RequestOrchestrator` 与 `CacheManager`，使用新缓存键与 provenance；
3. 保留现有 ChiCTR 路径不动（暂时可并存）。

**退出条件**：fixture 与单元测试通过；低频真实 smoke test 通过；**未安装 Playwright 时正常工作**。

### Phase 2 — 切换默认通道并移除浏览器依赖

1. `search_trials` / `get_trial_detail` 默认走 ICTRP；
2. 移除 `src/index.ts` 的无条件浏览器初始化；
3. 移除 postinstall 下载与 `playwright` 依赖；
4. 决定 `src/browser.ts` / `src/services/*.ts` 的处置（见下）。

**退出条件**：`npm install` 不下载 Chromium；clean install 后所有工具可用。

### Phase 3 — 文档与清理

1. 更新 README：数据来源、WHO 条款、时效警告、字段限制；
2. 删除或归档已失效的 ChiCTR 直接访问代码路径。

**关于 `src/browser.ts`（需决策）**：本规格**不**要求立即删除它。它已无调用方，删除是安全的，但会与「保留未来在合法授权环境恢复直接访问」的可能性冲突。建议在 Phase 2 结束后单独决断，本规格不预设。

---

## 8. 验收标准

| # | 验收项 | 验证方法 |
|---|---|---|
| 1 | 默认安装不下载 Chromium | clean install 后 `~/Library/Caches/ms-playwright/` 无新增；无 `playwright install` 输出。 |
| 2 | `npm install` 在无网络浏览器下载时成功 | 断网或屏蔽 CDN 后安装成功。 |
| 3 | WAF/405 不返回空结果 | WAF fixture 产生 `WAF_BLOCKED`，不是 `[]`。 |
| 4 | 零浏览器可检索 | 移除 Playwright 后跑 fixture 与 smoke test。 |
| 5 | 来源透明 | 每个结果含 `_provenance`；ICTRP 记录标为 `ChiCTR via WHO ICTRP`。 |
| 6 | 时效可见 | 结果含 `Last Refreshed on` 与每周同步警告。 |
| 7 | ASP.NET 导出链正确 | 导出请求仅用结果页 hidden inputs + `Button7`；响应为 CSV 而非 `NoAccess.aspx`。 |
| 8 | 缓存工具无浏览器副作用 | 调用 `get_cache_stats` / `clear_cache`，确认无 Chromium 进程。 |
| 9 | CSV 是权威载体 | 断言 CSV 行数 > 页面可见行数（复现 10 vs 12 与 10354 records）。 |
| 10 | 字段名原样匹配 | 断言解析器正确处理 `Inclusion agemin` / `Date enrollement` 等拼写。 |

---

## 9. 风险与待验证项

| 风险/未知项 | 当前判断 | 缓解/下一步 |
|---|---|---|
| **ICTRP 是否载有 ChiCTR 全量** | **未确认**。样本 `Last refreshed on` 明显滞后 | 用关键词/注册号矩阵统计：总行数、ChiCTR 行数、唯一 ID、空值率、同步时延。**在量化前不得宣称覆盖完整。** |
| **同步时延** | 官方称每周更新，但单条记录可能滞后数月甚至数年 | 展示 `Last Refreshed on`；文档明示滞后可能。 |
| **中文关键词命中** | ICTRP 以英文为主，中文 query 效果未测 | 实测中英文关键词并记录差异。 |
| **大结果集导出上限** | 9,273 行 / 39 MB 未截断；更大未测 | 测试更大结果集与服务端上限。 |
| **CSV 服务端行为变化** | 依赖 ASP.NET 表单 state，站点改版即失效 | 保留离线 fixture；失败时明确报错而非静默。 |
| **ICTRP 无 ChiCTR 全部字段** | 结构性缺失可能（如部分中文特有字段） | 字段级 provenance + `null` 说明；不臆造。 |
| **依赖第三方服务的稳定性** | ICTRP 是外部且可能不可用 | 结构化错误 + 现有 `RequestOrchestrator`；README 说明依赖。 |

---

## 10. 对主版本的影响

本规格仅更新 `dev/browser-removal/` 下的文档：

- `REFACTOR_PLAN.md`（本文档，v2）
- `WAF_RESEARCH.md`（调研证据）
- `DUAL_CHANNEL_ARCHITECTURE.md`（**已被本文档取代**，其双通道设计因第二通道无实现而废弃）

截至本规格编写时，**未修改** `src/**`、`package.json`、`tsconfig.json` 或构建产物。实际实施应从独立 dev 分支或 worktree 开始，因为当前工作区已有与本改造无关的未提交变更。

**产品承诺建议**：

> 数据来自 WHO ICTRP 官方免费 CSV 通道，因此安装不再下载浏览器。系统在每次返回中标注数据来源、WHO 的处理日期与同步时效警告。WHO ICTRP 是每周同步的聚合副本，可能滞后于 ChiCTR 原站；未命中不表示该试验不存在。系统不绕过任何站点的访问控制，也不再将 WHO 聚合数据伪装为 ChiCTR 实时数据。
