# 评估：JAGAN666/chictr-mcp

**日期**: 2026-10-04
**结论**: ⭐ **非常值得借鉴——他解决了我上一轮卡住的那个问题**
**但也要看清**: 这位作者**没有真正取消浏览器**，他只是把浏览器**变成了可选项**。真正"零浏览器"的是他的 **Basic Mode（默认）**，走 WHO ICTRP 纯 HTTP。

---

## 一、一句话总结这个项目

| | 我们的 chictr-mcp-server | JAGAN666 的 louiza-chictr-mcp |
|---|---|---|
| 数据源 | 只有 ChiCTR（走 Playwright） | **双源**：ChiCTR + WHO ICTRP |
| 浏览器 | **硬依赖**（`dependencies` + `postinstall` 下载 557MB） | **`optionalDependencies`，且源码里根本没 import** |
| 默认模式 | 没有浏览器就完全不可用 | **Basic Mode 纯 HTTP，零配置可用** |
| 403/405 时的行为 | 抛错，全盘失败 | **自动回退到 ICTRP，仍能出数据** |
| 代码量 | ~3000 行 | 1997 行（`scraper.ts` 665 行是核心） |
| 提交数 | v2.0.2，多轮迭代 | **1 个 commit**（`84859de Initial release`） |

作者确实厉害，但**厉害在架构判断，不是代码量**。他用一个"双源 + 优雅降级"的设计，把我们的单点故障变成了可选路径。

---

## 二、⭐ 最重要的借鉴：他找到了我上一轮卡住的突破口

上一轮我的结论是「ICTRP 手搓 postback 没打通」。**是错的**。我复现了他的代码后，全链路一次跑通：

### 我上一轮缺了两样东西

| 缺的东西 | 后果 |
|---|---|
| **`__EVENTVALIDATION`** | 只带 `__VIEWSTATE` + `__VIEWSTATEGENERATOR` 时，ASP.NET 直接拒绝 postback |
| **回传 `Set-Cookie`** | 会话不连续，JSESSIONID 丢了 |

补上之后：

```
GET  https://trialsearch.who.int/Default.aspx
     -> 提取 __VIEWSTATE / __VIEWSTATEGENERATOR / __EVENTVALIDATION + cookies

POST 同 URL，字段集：
     __VIEWSTATE / __VIEWSTATEGENERATOR / __VIEWSTATEENCRYPTED(空) / __EVENTVALIDATION
     TextBox1=<关键词> / Button1=Search
     Referer: https://trialsearch.who.int/Default.aspx

     -> HTTP=200  SIZE=69146  error_page=0
     -> 命中 10 个 Trial2.aspx?TrialID= 链接
        ChiCTR2600132941 / ChiCTR2600132949 / ChiCTR2600132873 /
        ChiCTR2600132792 / ChiCTR2600132854 / NCT07829471 / ...

GET  https://trialsearch.who.int/Trial2.aspx?TrialID=ChiCTR2600132941
     -> HTTP=200  SIZE=63101，含 60 个 DataList*_ctl*_*Label 控件
```

**全程 curl / axios，零浏览器。** 从 GET 表单到解析出结构化的试验详情，一个 JS 引擎都不需要。

### 详情页字段实测（我逐个验证过）

```
TrialIDLabel              = ChiCTR2600132941
Public_titleLabel         = Remote Ischemic Preconditioning Combined with Micromovement for Prevention of Pressure Inj…
Scientific_titleLabel     = Effect of Remote Ischemic Preconditioning Combined with Intraoperative Micromovement on Pr…
Study_typeLabel           = Interventional study
Recruitment_statusLabel   = Pending
Target_sizeLabel          = Control Group:84;Intervention Group:84;
Primary_sponsorLabel      = Tianjin Medical University General Hospital Airport Site
Study_designLabel         = Parallel
Date_registrationLabel    = 2026-09-20
Last_updatedLabel         = 21 September 2026
Condition_FreeTextLabel   = Intraoperative Acquired Pressure Injury
Intervention_FreeTextLabel= Control Group:Sham RIPC + Standard Dressing Care;Intervention Group:RIPC + Micromovement +…
Inclusion_criteriaLabel   = Inclusion criteria: 1.Age >= 60 years; 2.ASA grade II-III; 3.Elective hepatobiliary and pa…
Exclusion_criteriaLabel   = Exclusion criteria: 1.Unplanned intraoperative position change; 2.Peripheral artery diseas…
```

**⚠️ 但有真实差距**，这点必须诚实说：

```
PhaseLabel       = N/A        ← 分期没填
AllocationLabel  = (空)       ← 随机化方法没填
AssignementLabel = (空)       ← 盲法没填
```

作者用 `AllocationLabel` / `AssignementLabel` 映射 `randomization_method` 和 `blinding`，**但在这个样本里它们是空的**。ICTRP 的"随机化/盲法/分期"字段**填充率明显低于 ChiCTR 原始详情页**。这是 Basic Mode 的真实代价，不是理论担忧。

---

## 三、他的三个设计决策，值得直接抄

### 3.1 双源 + 自动降级（最值钱）

```ts
// src/scraper.ts:634-665
export async function getTrialDetail(chictrId) {
  if (await checkFlaresolverr()) {          // 有 FlareSolverr 就走 ChiCTR
    try { return await chictrGetTrialDetail(chictrId); }
    catch { flareSession = null; /* 回退 */ }
  }
  return await ictrpGetTrialDetail(chictrId);  // 否则纯 HTTP 走 ICTRP
}
```

**"有则用、无则降级"**——这正是我们现在最缺的。当前我们的代码是：ChiCTR 一 405，整个工具就废了。

### 3.2 浏览器放进 `optionalDependencies`（且从不 import）

```json
"optionalDependencies": { "playwright": "^1.50.0" }
```

而且我 grep 过全仓：**`playwright` 在 `src/` 里一次都没被 import**——是个**死依赖**。作者实际上把所有取数都交给了 axios：ChiCTR 走 FlareSolverr 的 HTTP API（`http://localhost:8191/v1`），ICTRP 走纯 axios。

也就是说：**他自己一行浏览器代码都没写**，FlareSolverr 是外部的可选 Docker 服务。

### 3.3 ⚠️ 但要说清楚：FlareSolverr 里还是浏览器

这一点我看完特意确认了。作者 README 说 Full Mode 用 FlareSolverr 拿 34+ 字段。**FlareSolverr 本身就是一个基于浏览器的反爬绕过服务**（它内部跑 Chrome）。

所以：
- **Basic Mode（默认）** → 真的零浏览器 ✅
- **Full Mode** → 557MB 的 Playwright 换成了"需要跑 Docker 容器" ❌ 并没有省掉"需要 JS 引擎"这件事

**他消除的不是浏览器，是"浏览器作为项目硬依赖"。** 这个区别很重要——它决定了你如果要抄，抄的是"降级架构"，而不是"无浏览器方案"。

### 3.4 顺带一提：EN 变体路径没用

作者用 `searchprojen.html` / `showprojen.html`（英文变体），我们用 `searchproj.html` / `showproj.html`。我实测了：

```
searchprojen.html?title=KRAS&btngo=btn  -> 405 (2657 bytes)
showprojen.html?proj=219315             -> 405 (2657 bytes)
searchproj.html?title=KRAS&btngo=btn    -> 405 (2657 bytes)
showproj.html?proj=219315               -> 405 (2657 bytes)
indexEN.html                            -> 200 (31961 bytes)  ← 只有首页能通
```

**四个路径全 405，字节数一模一样。** 换路径绕不过封锁（本机是 IP 级封锁），这条不用试了。

---

## 四、其他可借鉴的工程细节

### 4.1 ClinicalTrials.gov 交叉核验（`src/verifier.ts`，267 行）

三层递进，设计得干净：

| Tier | 方法 | 结果 |
|---|---|---|
| 1 | `searchBySecondaryId`（`query.term=ChiCTR...`，比 `secondaryIdInfos[].id`，剥 `[-\s]` 后比） | 命中 → `HIGH` / `secondary_id` |
| 2 | `searchByTitle`（取英文标题前 5 个 >3 字符的词，`tokenOverlap` 算 Jaccard） | `>0.7`→`MEDIUM`，`>0.5`→`LOW` |
| 3 | 都不中 | `UNVERIFIED` / `none` |

还有 `findDiscrepancies()` 输出人类可读差异，如 `Enrollment mismatch: ChiCTR=X vs CT.gov=Y`。
重试策略也讲究：**429/503 指数退避重试，其它 4xx 直接 break 不重试**。

> 这对"胰腺癌临床试验情报"场景特别有用——**ChiCTR 和 CT.gov 常有同一试验的双注册，能自动关联并发现数据不一致**。

### 4.2 质量分 + 丢弃（`computeQualityScore`）

```ts
populated >= 18  → HIGH
populated >= 10  → MEDIUM
否则              → LOW
```
`bulk_ingest` 时 **LOW 的直接丢弃并记入 `skipped`**。简单粗暴但有效——避免脏数据进 RAG。

### 4.3 每个字段带 3 个来源 URL

`source_url` / `who_ictrp_url` / `chictr_source_url`——**为引用溯源设计的**，对医疗数据合规很有价值。

### 4.4 翻译走单次批处理（`src/translator.ts`）

把所有待翻字段拼成 `[1] value... [n] value` 走**一次** API 调用（NVIDIA `llama-3.1-nemotron-70b-instruct`），再按 `^\[(\d+)\]` 回填。**无 API key 时打印一行提示并返回 `{}` 优雅降级**，不崩。省 token 的做法值得学。

### 4.5 结构化错误（`src/types.ts`）

```ts
ScraperErrorCode = 'CAPTCHA_DETECTED' | 'PAGE_LOAD_TIMEOUT' | 'RATE_LIMITED'
                 | 'PARSE_ERROR' | 'BROWSER_ERROR' | 'NETWORK_ERROR'
class ScraperError extends Error { code; retryable; toJSON() }
```
`toJSON()` 输出 `{error, code, retryable, source, timestamp}`——**对 MCP 客户端友好**，错误是可编程处理的而不是一坨字符串。

### 4.6 并发控制用 `p-limit`

`bulk_ingest` 默认 `BULK_CONCURRENCY=3`，逐条 try/catch 记 `errors`，不因一条失败中断整批。比我们手写的 orchestrator（`maxConcurrency:1` 串行）更适合批量场景。

---

## 五、客观评价：他强在哪，弱在哪

### 强
1. **架构判断准确**：识别出"ChiCTR 是单点故障"，用双源 + 降级解决——这是他最厉害的地方
2. **ICTRP postback 摸对了**（`__EVENTVALIDATION` + cookie 回传），这是他相对大多数人领先的地方
3. **产品思维**：`optionalDependencies`、零配置可用、优雅降级、来源可追溯、质量分——**都是"给用户用"的设计，不是炫技**
4. 代码短（1997 行）但覆盖完整：搜索 / 详情 / 核验 / 翻译 / 批量入库 / 缓存

### 弱（要抄就得知道这些）
1. **1 个 commit、v1.0.0、无测试文件**——成熟度存疑，`test-scrape.ts` 是个手跑脚本不是测试
2. **`playwright` 是死依赖**——声明了从不 import，说明迭代中有遗留
3. **缓存纯内存**（4 个 `NodeCache`），重启即失；我们双层 L1+L2 sqlite 在持久化上更好
4. **Full Mode 的真实成本被淡化**：README 说"no browser automation needed"，但那是 Basic Mode；Full Mode 需要 Docker + 一个内部跑 Chrome 的服务
5. **ICTRP 字段填充率问题没在 README 里说明**（`Phase`/`Allocation`/`Assignment` 常为空）——这个坑他不提，抄的人会踩

---

## 六、对我们项目的具体建议

### 建议 1：把 ICTRP 作为**主路径**，ChiCTR 降为**可选增强**（强烈推荐）

这是作者最核心的洞察，也正好解决我们的困境：

```
默认：ICTRP 纯 HTTP  → 零浏览器、零 Docker、零配置，本机 IP 通畅（实测 200）
可选：ChiCTR 直连    → 仅在需要"分期/随机化/盲法"等 ICTRP 缺失字段时才用
```

**实测 ICTRP 本机直连完全畅通**（`Default.aspx -> 200`），而 ChiCTR 是 `405`。**把主路径换成 ICTRP，你的 500MB 浏览器依赖就自然消失了**——不是靠绕过封锁，是靠不经过封锁。

### 建议 2：立刻修掉"405 即全盘失败"

参考 `src/scraper.ts:634-665`，加降级链：
```
ChiCTR → （失败/不可用）→ ICTRP
```
而不是现在的直接抛错。

### 建议 3：`postinstall: playwright install chromium` 必须拿掉

作者**没有 `postinstall`**。我们的 `postinstall` 每次 `npm install` 都拉 557MB，而它现在换不来一次成功抓取。

### 建议 4：把 `playwright` 挪到 `optionalDependencies`

配合 3，让"不想装浏览器的用户"能用 Basic Mode。

### 建议 5：**先别急着抄 Full Mode**

FlareSolverr 需要 Docker，且国内 Docker Hub 拉取可能受阻。**先把 Basic Mode（ICTRP）跑通**，这是投入产出比最高的一步。

---

## 七、待你决策

我上一轮的判断（"ICTRP 手搓 postback 没打通"）**被这个项目推翻了，我应该更正**。现在事实很清楚：

> **纯 HTTP 走 ICTRP 是可行的，且本机 IP 通畅。这是一条真正能去掉 500MB 浏览器的路。**

问题只剩一个：**ICTRP 的字段够不够用？**

- 如果 `Phase` / `Allocation` / `Assignment`（分期、随机化、盲法）**够用** → 直接切 ICTRP 为主路径，浏览器可以彻底删掉
- 如果**不够用**（临床研究常需要这些） → 采用作者的**双源方案**：ICTRP 做默认，ChiCTR 做可选补充

我倾向后者，因为这也是作者的选择——**但他有 FlareSolverr 兜底，我们目前没有**。

**你想让我先做哪个？**
1. 写一个 ICTRP 纯 HTTP 的原型（不改 main，放 `dev/`），实测字段覆盖率到底够不够
2. 直接出改造方案（双源 + 降级 + 去 postinstall + optionalDependencies）
3. 先把 FlareSolverr 这条 Full Mode 路验一下（需要 Docker）

---

## 附：复现命令

```bash
git clone --depth 50 git@github.com:JAGAN666/chictr-mcp.git /tmp/chictr-mcp-eval

# 关键文件
sed -n '547,628p' /tmp/chictr-mcp-eval/src/scraper.ts   # ictrpSearchTrials + getFormState
sed -n '634,665p' /tmp/chictr-mcp-eval/src/scraper.ts   # 双源降级入口

# 我在 /tmp 写的复现脚本（已实测 200 + 10 条结果）
#   /tmp/ictrp_full.py   ICTRP 完整 postback
```
