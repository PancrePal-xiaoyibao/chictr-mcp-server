# Scrapling 过阿里盾实测：405 问题已解决

**日期**：2026-10-04
**状态**：**实测验证通过**（非推测）。本机真实执行，全部结论附复现命令。
**前置文档**：本目录 `WAF_RESEARCH.md` 的 §2.2 结论（「Node/Chromium 均死循环，过盾不可行」）**已被本次实测推翻**。

---

## 0. 结论摘要

**阿里盾 405 可以解决，且不需要每次都用浏览器。**

| 问题 | 旧结论（WAF_RESEARCH.md） | 本次实测结论 |
|---|---|---|
| `/searchproj.html` 直连 | **405 硬拦截** | 405（curl 依旧） |
| Scrapling `Fetcher`（TLS 指纹伪装） | 未测试 | **200，但返回 17,136 字节挑战页** |
| Scrapling `StealthyFetcher` | 判定「死循环、跑不通」 | ✅ **200，42,178 字节真实页面** |
| 挑战脚本能否执行 | ❌ Node + Chromium 均死循环 | ✅ **patchright 驱动下正常完成** |

**根因差异**：WAF_RESEARCH.md 用的是**原生 Playwright + `page.setContent()`** 让它跑挑战脚本；Scrapling 的 `StealthyFetcher` 底层用的是 **patchright**（Playwright 的反检测 fork）+ 真实导航，指纹补丁让挑战脚本得以走完并计算出 `acw_sc__v2`。

**最关键发现（决定架构）**：挑战解出的 `acw_sc__v2` cookie **可以脱离浏览器复用**。
用真实 HTTP 客户端只带这组 cookie，连续 5 次分页请求 **5/5 全部拿到真实内容**，无挑战页。

---

## 1. 环境

```bash
cd /Users/qinxiaoqiang/Downloads/chictr_trials
python3 -m venv .venv
.venv/bin/pip install "scrapling[fetchers]"
# → scrapling 0.4.15 / patchright 1.63.0 / playwright 1.63.0 / curl_cffi 0.16.3
```

> `pip3 install --user` 在本机**失败**：`OSError: [Errno 1] Operation not permitted:
> '/Users/qinxiaoqiang/Library/Python/3.10/lib/python/site-packages/w3lib'`。
> **必须用 venv**（已建于工作区内 `.venv/`）。

---

## 2. 三层实测证据

### 2.1 第一层：`Fetcher`（TLS 指纹伪装）→ 只把 405 降级为挑战页

```python
from scrapling.fetchers import Fetcher
p = Fetcher.get("https://www.chictr.org.cn/searchproj.html",
                impersonate="chrome", stealthy_headers=True, timeout=45)
```

```
status=200  len=17136  title=''
  arg1            @ 24
  acw_sc__v2      @ 315
  aliyunwaf       @ 384
  __phantomas     @ -1      <-- 注意：本次样本无 __phantomas 反分析循环
```

**17,136 字节 = 阿里盾挑战页**（与 WAF_RESEARCH.md §1.1 的样本尺寸一致）。
TLS 指纹伪装足以让请求**不被硬 405**，但**不能解挑战**。

### 2.2 第二层：`StealthyFetcher` → ✅ 拿到真实页面（核心突破）

```python
from scrapling.fetchers import StealthyFetcher
p = StealthyFetcher.fetch("https://www.chictr.org.cn/searchproj.html",
                          headless=True, solve_cloudflare=True, timeout=90000)
```

```
[ERROR] No Cloudflare challenge found.        <-- 正常：阿里盾不是 CF，Scrapling 找不到 CF 挑战
[INFO]  Fetched (200) <GET .../searchproj.html>
status: 200  len: 42178
title: 中国临床试验注册中心 - 世界卫生组织国际临床试验注册平台一级注册机构
challenge present (acw_sc__v2): False
has real content: True
count: 共&nbsp;13125
scripts: ['//g.alicdn.com/.../antidom.js', './js/retrieve.js', './js/myPagination.js', './libs/laydate/laydate.js']
```

**判据（三者同时满足才算成功）**：
- `"acw_sc__v2" not in html`（不是挑战页）
- 页面含真实站点 JS（`retrieve.js` / `myPagination.js`）
- 页面含真实数据（`共&nbsp;13125`）

> `solve_cloudflare=True` 对阿里盾**不起作用也不报错**（只打印 "No Cloudflare challenge found"）。
> **真正起作用的是 `StealthyFetcher` 的 patchright 指纹补丁 + 真实导航**，不是 Cloudflare solver。

### 2.3 第三层：关键词搜索端到端 → ✅ 真实试验数据

```python
URL = "https://www.chictr.org.cn/searchproj.html?page=1&btngo=btn&title=%E8%83%B0%E8%85%BA%E7%99%8C"
# title = 胰腺癌
with StealthySession(headless=True, solve_cloudflare=True) as s:
    p = s.fetch(URL, google_search=False, timeout=90000)
```

```
status: 200  len: 42378   challenge: False
total: 共 47
proj links found: 10  ['245719','292686','344543','344425','298822','334514','286329','275373','335014','339235']
ROWS:
  ChiCTR2600133371  阿得贝利单抗联合NALIRIFOX用于可切除胰腺癌新辅助治疗   浙江大学医学院附属第一医院  干预性研究  2026/09/24
  ChiCTR2600133365  转移性胰腺癌的多模态识别                        中国医学科学院北京协和医院  观察性研究  2026/09/24
  ChiCTR2600133048  动脉灌注化疗栓塞联合双免疫检查点抑制剂一线治疗胰腺癌肝转移的多中心单臂前瞻性临床研究  山东省立医院  干预性研究  2026/09/21
```

**搜索是 URL query 参数驱动的，不需要 AJAX/API 抓包**：`?page=&btngo=btn&title=&regno=&createyear=`
（与 `src/services/search.ts:57-72` 现有参数完全一致）

### 2.4 详情页 → ✅ 同样可用

```
https://www.chictr.org.cn/showproj.html?proj=344425
status: 200  len: 147085  challenge: False
注册号：ChiCTR2600132949  注册时间：2026-09-20  注册题目：可切除胰腺癌术后维持化疗方案的临床研究——多中心、前瞻性、随机对照试验
```

---

## 3. 关键架构发现：cookie 可脱离浏览器复用

### 3.1 挑战产出的 cookie

浏览器完成挑战后 `context.cookies()`：

```json
[
 {"name":"acw_tc",     "domain":"www.chictr.org.cn","httpOnly":true},
 {"name":"acw_sc__v2", "value":"6ac1fba3a969a6195fb1041c1f1e5299f447a1e8",
  "domain":"www.chictr.org.cn","expires":1791101363.667081,"httpOnly":false},
 {"name":"ssxmod_itna",  "..."},
 {"name":"ssxmod_itna2", "..."}
]
```

`acw_sc__v2` 有效期约 **1 小时**（`expires` 与获取时刻差 ≈ 3600 s）。

### 3.2 复用实测：**5/5 成功**

用**纯 HTTP 客户端**（`Fetcher`，无浏览器）只带这组 cookie：

```python
p = Fetcher.get(url, impersonate="chrome", stealthy_headers=True, cookies=cookies_dict)
```

```
  page 1: status=200 len=41081 real=True
  page 2: status=200 len=41174 real=True
  page 3: status=200 len=40942 real=True
  page 4: status=200 len=41158 real=True
  page 5: status=200 len=41086 real=True
OK pages: 5 /5
```

**含义**：
- 浏览器只在**挑战过期时**出现（约每小时一次），而不是每个请求一次。
- 日常分页抓取走**纯 HTTP + cookie**，速度与资源开销接近普通 HTTP 客户端。
- 这把「浏览器硬依赖」降级为「**低频的 cookie 刷新器**」。

---

## 4. 推荐架构（相对 REFACTOR_PLAN.md 的修订）

REFACTOR_PLAN.md v2 主张「**删除所有浏览器、只留 ICTRP CSV 单通道**」。本次实测表明
**可以保留 ChiCTR 原站直连**，成本仅为每小时一次的无头浏览器挑战：

```text
                    MCP tools: search_trials / get_trial_detail
                                   │
                    CookieProvider（挑战状态机）
                    ├── 命中有效 acw_sc__v2 cookie → 直接返回
                    └── 过期/缺失 → 启动 StealthySession 过一次挑战（~每小时1次）
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
      ChiCTR 直连通道（首选）                 ICTRP CSV/XML 通道（并行/兜底）
      Fetcher + cookie，零浏览器              trialsearch.who.int，零浏览器
      searchproj.html / showproj.html         官方免费、覆盖 14 库
```

**两条通道互补，不再二选一**：

| 维度 | ChiCTR 直连 | WHO ICTRP |
|---|---|---|
| 浏览器 | 仅刷新 cookie 时（~1次/小时） | 无 |
| 数据时效 | **实时**（原站） | 每周同步（实测有滞后） |
| ChiCTR 覆盖 | **全量 131,125+** | 子集（`pancreatic cancer` 命中 579 条） |
| 中文原文 | ✅ 完整中英双语 | 部分英文 |
| 合规 | re3data：数据访问 "restricted"、Copyrights | 官方明确 "at no charge"，需署名 |

---

## 5. 复现命令

```bash
cd /Users/qinxiaoqiang/Downloads/chictr_trials

# 1) 环境
python3 -m venv .venv
.venv/bin/pip install "scrapling[fetchers]"

# 2) 一次 StealthyFetcher 拿真实页（验证挑战可解）
.venv/bin/python -c "
from scrapling.fetchers import StealthyFetcher
p=StealthyFetcher.fetch('https://www.chictr.org.cn/searchproj.html',
                        headless=True, solve_cloudflare=True, timeout=90000)
t=p.body.decode('utf-8','replace') if isinstance(p.body,bytes) else str(p.body)
print(p.status, len(t), 'challenge:', 'acw_sc__v2' in t, '| real:', 'retrieve.js' in t)
"
# 期望: 200 42178 challenge: False | real: True

# 3) 关键词搜索
.venv/bin/python -c "
from scrapling.fetchers import StealthySession
with StealthySession(headless=True, solve_cloudflare=True) as s:
    p=s.fetch('https://www.chictr.org.cn/searchproj.html?page=1&btngo=btn&title=%E8%83%B0%E8%85%BA%E7%99%8C',
              google_search=False, timeout=90000)
    t=p.body.decode('utf-8','replace') if isinstance(p.body,bytes) else str(p.body)
    print(p.status, len(t), 'challenge:', 'acw_sc__v2' in t)
"
```

---

## 6. 与 WAF_RESEARCH.md 的冲突处理

WAF_RESEARCH.md §0/§2 的三条否决理由，逐条重新评估：

| 旧理由 | 本次结论 |
|---|---|
| 「技术层：挑战版本已演化为反自动化陷阱，Node 与真实 Chromium 均死循环」 | **不成立**。旧测试用 `page.setContent()` 注入脚本；patchright **真实导航**下挑战正常完成。本次样本亦**未见 `__phantomas`**。 |
| 「架构层：solver 不减少浏览器依赖，只是换个 JS 引擎」 | **部分成立但不致命**。确实需要浏览器，但只在 **cookie 过期时（~1/小时）**，不是每次请求。 |
| 「合规层：绕过是与站点访问决策对抗」 | **仍成立，需正视**。本条是**政策判断**而非技术判断，交由项目决策。技术结论：**访问是可行的**。 |

> 合规提示仍然有效：ChiCTR 的 re3data 登记为**数据访问 "restricted" + 许可 "Copyrights"**，
> 站点页脚 `All rights reserved.`。**可获得 ≠ 可再分发**。若项目要长期依赖 ChiCTR 直连，
> 建议同时推进对 `chictr-s7@wchscu.cn` 的正式授权问询。

---

### 3.3 并发复用实测：**并发 5/5 成功**

同一组 cookie，用 `ThreadPoolExecutor(max_workers=5)` 同时发起 5 个分页请求：

```
  concurrent page 1: 200 real=True
  concurrent page 2: 200 real=True
  concurrent page 3: 200 real=True
  concurrent page 4: 200 real=True
  concurrent page 5: 200 real=True
```

**含义**：cookie 不是「一次一用」的，可安全支撑并发抓取。阿里盾在本次测试规模下未对并发二次拦截。

---

## 7. 待验证

- `acw_sc__v2` 的**并发上限**未探明（本次仅并发 5；更高并发是否触发频率拦截未测）。
- cookie 刷新失败时的降级路径未实现。
- `StealthySession` 长驻（复用同一 session 而非每次新建）的稳定性未测。
- 请求频率上限（阿里盾是否在更高 QPS 下二次拦截）未测。
- `acw_sc__v2` 过期瞬间（约 1 小时）的续期行为未测。
