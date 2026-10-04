# 阿里云盾 / Cloudflare「过盾」技术调研

**日期**：2026-10-04
**状态**：调研报告，仅位于 `dev/browser-removal/`。未修改 `src/`、`package.json` 或构建产物。
**调研动机**：用户提问「阿里云过盾技术或者 cf 过盾技术研究一下，看看有啥可以用的」。

---

## 0. 结论摘要（先看这里）

**「过盾」在技术上确实存在成熟方案，但对本项目而言基本不可用。** 三条独立理由：

1. **技术层**：成熟的 acw_sc__v2 solver 是 2024 年的产物，针对旧版挑战；ChiCTR 当前投放的挑战版本已演化为「反自动化陷阱」——本会话实测在 Node 与真实 Chromium 中**均死循环、不产生结果**（详见 §2.2）。
2. **架构层**：即使 solver 能跑通，它要求**一个能执行该 JS 的运行时**。Node 直接执行已实测失败；能在浏览器里跑通，就等于把浏览器依赖装了回来。**solver 不减少浏览器依赖，只是把 Chromium 换成别的 JS 引擎。**
3. **合规层**（决定性）：WHO ICTRP 的官方条款**明文禁止本地存储通过 web service 获取的数据**；而 ChiCTR 的拦截行为本身即是站点的访问决策。绕过它是与站点意图对抗，不是「技术中立」问题。

**真正的可用发现不在过盾，而在 WHO 官方通道**：本会话实测确认存在**无需任何浏览器、无需 WAF 绕过、官方明确「publicly available for downloading ... at no charge」**的完整数据集通道（§4）。这比过盾方案在每一个维度上都更优。

> **建议**：不要投入过盾。转向 §4 的 WHO 官方 CSV 全量数据集 + §5 的 `ictrpinfo@who.int` 申请通道。

---

## 1. 阿里云盾（acw_sc__v2）技术解剖

### 1.1 挑战页结构（本会话实测样本）

ChiCTR 由阿里云盾 WAF（Yundun）前置，`dig` 显示 CNAME 指向 `...yundunwaf5.com` / `47.110.215.234`。

挑战页（17136 bytes 样本）关键结构：

```html
<script>
    var arg1='FC0C2D8AD5673C5FB8B9EF3180ECC395B9A5F944';
    function setCookie(name,value){var expiredate=new Date();expiredate.setTime(expiredate.getTime()+(3600*1000));document.cookie=name+"="+value+";expires="+expiredate.toGMTString()+";max-age=3600;path=/";}
    function reload(x) {setCookie("acw_sc__v2", x);document.location.reload();}
</script>
<script name="aliyunwaf_6a6f5ea8">var _0x4818=[...];(function(_0x4c97f0,_0x1742fd){...}(_0x4818,0x15b));var _0x55f3=function(...){...}</script>
```

- `arg1` 每次请求随机生成（同会话两次取样不同）。
- 字符串表 `_0x4818` 56 条目，IIFE 以 `0x15b`(347) 为计数做旋转。
- 解码器 `_0x55f3(idx,key)` = `_0x4818[parseInt(idx,16)]` → `atob` base64 解码 → **RC4**（`j=(j+S[i]+key.charCodeAt(i%key.length))%256`）。

### 1.2 官方开源 solver 的现状

存在成熟的第三方 solver：[WangYihang/acw-sc-v2-py](https://github.com/WangYihang/acw-sc-v2-py)、[acw-sc-v2.js](https://github.com/WangYihang/acw-sc-v2.js)、[acw-sc-v2-go](https://github.com/WangYihang/acw-sc-v2-go)。

其工作模式（据其 README）：

```
检测到挑战 → 把挑战 JS 发给本地 Node solver 服务 → solver 算出 acw_sc__v2 → 重发请求并带上 cookie
```

README 声称可连续 8 次请求不被拦截，示例日志显示 `cookie generated acw_sc__v2=65b3bb36...`。

**但本方判定其对本项目不可用**：

- 该 solver 针对 2024 年的挑战版本。ChiCTR 当前投放的版本明显不同（见 §2.2 的死循环行为）。
- 即便版本匹配，solver 本身就是一个**必须能执行混淆 JS 的运行时**——`acw-sc-v2.js` 依赖 `npm install` 后的 Node 环境，README 明确要求 `node app.js` 起一个本地服务。**这不是消掉浏览器依赖，而是换一种解释器。**
- 手工逆向本方已实测失败（§2.1），且这类对抗是持续更新的，**版本一换就废**，维护成本不可接受。

---

## 2. 本方实测结果（负面但决定性）

### 2.1 手工逆向：失败

按 §1.1 的解剖，尝试用 56 个字符串字面量做 RC4 解码，枚举解码器体内全部 unique 第二参数作 key（`XWMWZ` / `jS1Y` / `n]fR` / `Pg54` / `)hRc` / `jE&^` / `V2KE` / `W1FE` / `MGrv` / `Z*DM` / `aH*N` / `z5O&`）→ **输出全部为不可打印乱码**。

修正解码顺序（先模拟 IIFE 旋转 0x15b → `\xNN` unescape → base64 → RC4）→ 仍为乱码。

**卡点**：同一索引在不同调用点使用了不同 key；`KEY(0x3)` 解出 `\x04\x9b\x11\xbf` 这类不可打印值，说明解码配方未对齐。

**教训**：不要在混淆细节上继续钻。这类商业对抗是持续更新的军备竞赛，手工逆向成本高且版本一换就废。

### 2.2 在真实 JS 引擎里执行挑战：**死循环，无输出**（决定性）

**Node + DOM shim**：注入 `document.cookie` getter/setter、`document.addEventListener`、`globalThis.reload=(x)=>solved=x`、`setTimeout` 走 `eval`、`setInterval` 空实现，然后 `eval` 那 16715 bytes 脚本：

```
进程正常退出码 0，但 stdout 为 0 字节
console.log('step4') 永不执行
```

即脚本进入**不可返回的死循环**。

**真实 Chromium**（`page.setContent(挑战页HTML)` 让它自己跑，监听 `console` / `pageerror`）：**同样卡死**，120s 超时。

挑战页中成对出现的反分析代码：

```js
while(window['__phantomas']){}          // 反 PhantomJS 死循环
_0x355d23(++_0x450614);                 // 无限递归，靠 try/catch 兜栈溢出
(function(){}['constructor'](...))();   // 构造器调用做环境探测
setInterval(function(){_0x4db1c();},0xfa0);  // 每 4 秒重入
```

**结论：这段挑战是为「卡死自动化环境」而设计的陷阱**，需要极特定的真实浏览器语义才肯完成计算。**「用 Node/jsdom 直接跑它」这条路在当前版本上不成立。**

> 这一条同时否定了通过 solver 减少浏览器依赖的整个思路：solver 也需要一个能跑通这段 JS 的运行时。

### 2.3 为什么 405 会出现在「换 IP」测试里

一个重要区分（本会话已实测）：

| 出口 | `/index.html` | `/searchproj.html` |
|---|---|---|
| 本机直连 | 200（真实内容） | **405**（硬拦截） |
| 第三方代理（不同出口 IP） | 200（真实内容） | **200 但返回 JS 挑战页** |

**即：405 是本机出口 IP 级别的封锁，不是路径级别。** 换 IP 只是把「硬 405」降级为「可过的 JS 挑战」——而该挑战在自动化环境下跑不通（§2.2）。因此这条路对本项目没有实际收益。

---

## 3. Cloudflare 侧

Cloudflare 的对应机制是 **IUAM（I'm Under Attack Mode，俗称「5 秒盾」）** 与 **Turnstile**。生态中同样有大量 solver（如 `scrapy-turnstile` 等）。

**对本项目的适用性判定：不适用。**

- 本项目面对的是**阿里云盾**，不是 Cloudflare。研究 CF solver 不能解决当前问题。
- CF solver 面临与 §2.2 完全相同的问题：需要能执行挑战 JS 的运行时。Turnstile 尤其如此——它的设计目标就是区别人与自动化客户端。
- 合规层同样成立：绕过 Turnstile 直接违反站点的明确访问控制意图。

**记录这一条仅为完整回答用户提问；不建议投入。**

---

## 4. 真正可用的发现：WHO ICTRP 官方全量数据集

这是本会话最重要的正面发现。**不需要浏览器、不需要过盾、官方明确免费。**

### 4.1 三条官方通道

| 通道 | 说明 | 状态 |
|---|---|---|
| **搜索门户 CSV/XML 导出** | `https://trialsearch.who.int/` 搜索后导出 | ✅ **已实测可用**（§4.2） |
| **全量数据集（SharePoint）** | 每周生成的全量 CSV（Zip），World Health Organization 安全 OneDrive 下载 | ✅ 官方页面明确提供，[申请表单](https://tinyurl.com/8vpjmnjr) |
| **ICTRP XML Web Service** | 实时 XML 查询接口，需申请账号 | ⚠️ 需申请且**可能收费**，见 §5 |

官方原文（[Downloading records from the ICTRP database](https://www.who.int/tools/clinical-trials-registry-platform/network/who-data-set/downloading-records-from-the-ictrp-database)）：

> "ICTRP data are publicly available for downloading from the Search Portal to all requesters, **at no charge**."
> "ICTRP is updated **weekly**."

以及（[ICTRP dataset in CSV format](https://www.who.int/news/item/08-03-2018-ictrp-dataset-in-csv-format)）：

> "All users can search and download the full ICTRP dataset in CSV or XML formats from the ICTRP Search Portal. In addition, It is also possible for research institutions to request downloading the full ICTRP dataset in CSV format compressed in a Zip file. The file is generated weekly and can be downloaded from a secure OneDrive server of WHO."

### 4.2 本方实测数据（2026-10-04）

对 `pancreatic` 执行完整 `GET → 搜索 POST → CSV 导出 POST` 链路：

```
搜索状态 200，页面显示 "10354 records"
CSV 导出状态 200，Content-Type: application/vnd.ms-excel
文件：39,462,912 bytes（约 39 MB，未落盘）
行数：9,273 数据行，58 列
```

**Source Register 分布（前 8）**：

| Registry | 记录数 |
|---|---|
| ClinicalTrials.gov | 5,276 |
| JPRN | 1,476 |
| **ChiCTR** | **990** |
| EU Clinical Trials Register | 426 |
| NL-OMON | 212 |
| CTRI | 185 |
| German Clinical Trials Register | 157 |
| Clinical Trials Information System | 129 |

**关键结论**：
- 单次 `pancreatic` 查询即取得 **990 条 ChiCTR 来源记录**（990 unique ChiCTR IDs）。
- ChiCTR 记录字段完整度高：`Scientific title` 990/990、`Phase` 990/990、`Recruitment Status` 990/990、`Primary outcome` 989/990、`Intervention` 988/990。
- 按此比例外推，全量 ICTRP 中的 ChiCTR 记录规模可观，且**一次导出即可覆盖**，无需逐条抓取。

### 4.3 58 列完整字段清单（实测）

```
 0 TrialID                     20 Phase                       40 Ethics Contact Address
 1 Last Refreshed on           21 Countries                   41 Ethics Contact Phone
 2 Public title                22 Contact Firstname           42 Ethics Contact Email
 3 Scientific title            23 Contact Lastname            43 results yes no
 4 Acronym                     24 Contact Address             44 results date posted
 5 Primary sponsor             25 Contact Email               45 results url link
 6 Date registration           26 Contact Tel                 46 results url protocol
 7 Date registration3          27 Contact Affiliation         47 results date completed
 8 Export date                 28 Inclusion Criteria          48 results date first publication
 9 Source Register             29 Exclusion Criteria          49 results summary
10 web address                 30 Condition                   50 results baseline char
11 Recruitment Status          31 Intervention                51 results adverse events
12 other records               32 Primary outcome             52 results outcome measures
13 Inclusion agemin            33 Secondary outcome           53 results ipd plan
14 Inclusion agemax            34 Secondary ID                54 results ipd description
15 Inclusion gender            35 Source Name                 55 Prospective registration
16 Date enrollement            36 Secondary Sponsor           56 Bridging flag truefalse
17 Target size                 37 Ethics Status               57 Bridged type
18 Study type                  38 Ethics Approval Date
19 Study design                39 Ethics Contact Name
```

**注意列名拼写**：`Date enrollement`（非 enrollment）、`Inclusion agemin`/`agemax`（无下划线）、`results yes no`（含空格）——解析器必须按字面匹配。

### 4.4 官方使用条款（必须遵守）

来自 [Terms and Conditions for Use of WHO ICTRP Data](https://www.who.int/tools/clinical-trials-registry-platform/network/who-data-set/downloading-records-from-the-ictrp-database)：

- **归属**：`you should ... attribute the source of the data as WHO ICTRP`
- **时效**：`you should update the data such that they are current at all times`
- **处理日期**：`you should clearly display the date the data were processed by WHO ICTRP`
- **不得主张所有权**：`You shall not assert any proprietary rights to any portion of the ICTRP database.`
- **禁止商业用途**：`You shall not use information extracted from the ICTRP database for marketing, promotional or commercial purposes.`
- **禁止使用 WHO 名称/徽标**：`You shall not use the name or emblem of WHO in association with the use of data from the ICTRP database.`

---

## 5. 需要申请的两条通道及其限制

### 5.1 ICTRP XML Web Service（实时）

[WHO ICTRP Search Portal Web Service](https://www.who.int/tools/clinical-trials-registry-platform/the-ictrp-search-portal/ictrp-search-portal-web-service)：

> "The ICTRP Web Service is available to the public for **research purposes only**."
> "The ICTRP Secretariat needs to recoup the costs of conducting the work necessary to provide the service to potential users. The **cost charged by ICTRP for accessing the ICTRP web service can be provided upon request**."

**条款中两条对本项目设计有决定性影响的限制**（来自 [Web Service Conditions of Use PDF](https://cdn.who.int/media/docs/default-source/medicines/regulatory-updates/gbt/2021-fair-pricing-forum/web_service_conditions_of_use6723ca30-e833-4d32-a20f-792cb1717352.pdf)，本方已下载解析，共 6338 字符）：

> **"You may not locally store any of the data accessed via the web service."**

> **"Users of the web service may not copy, reproduce, republish, frame, post, upload, distribute, transmit or modify in any way all or any part of the material accessed via this Web Service."**

**设计含义（重要）**：
- **该 Web Service 与本地缓存架构天然冲突**——若接入它，不能把结果写入 `src/runtime/cache-manager.ts` 的 L1/L2 缓存，也不能落盘。
- 它要求**强制署名 + 展示当前 ICTRP banner**，且**禁止使用 WHO 徽标**。
- 访问凭据：`Access to the ICTRP Web Service requires an electronic identification which consists of user name, password... You may not sell, share or publish your access information.` → **凭据绝不能进代码/Git/日志**（与本文档 §2 的 Cookie 处理原则一致）。
- 联系方式：`ictrpinfo@who.int`
- 终止：任一方可提前一个月书面通知终止。

**对比：CSV 导出通道没有「不得本地存储」这一条**，只有 §4.4 的署名/时效/非商业要求。**因此 CSV/全量数据集路径比 Web Service 路径更适合本项目的缓存型架构。**

### 5.2 ICTRP Crawling Service（当前不可用）

[ICTRP Search Portal Crawling Service](https://www.who.int/tools/clinical-trials-registry-platform/the-ictrp-search-portal/ictrp-search-portal-crawling-service)：

> "The ICTRP Crawling Service is available to the public for research purposes only."
> "**This service is currently not available.** If you wish to use this service in 2025 or when it is made available please [fill this survey](https://forms.gle/cJVp7X7kvyXLqoaB7)"

> "Only business entities will be charged for this service, whereas **non-business entities can use this service free of charge**."

**建议**：值得填表排队，但**不能作为近期依赖**（明确标注「currently not available」）。

---

## 6. 对改造规格的影响

| 影响项 | 内容 |
|---|---|
| **架构** | §4 的 WHO 官方 CSV 通道应提升为**首选默认通道**，而非仅作「降级 fallback」。它零浏览器、官方免费、单次可覆盖全量 ChiCTR 记录。 |
| **缓存设计** | CSV/全量数据集路径**允许**本地缓存（须标处理日期）；**XML Web Service 路径禁止任何本地存储**，若将来接入必须走独立的无缓存通道。两条路径的缓存策略必须分开实现，不可复用同一 cache key 前缀。 |
| **署名** | 所有输出须含 `WHO ICTRP` 归属 + `date the data were processed by WHO ICTRP`；禁止使用 WHO 徽标。 |
| **禁止项** | 未经申请不得接入 XML Web Service 并把数据落盘；不得用于商业/推广用途。 |
| **不投入项** | 过盾（阿里云盾 solver / CF solver）。技术、架构、合规三层均不成立，见 §0–§3。 |
| **待决** | 是否申请全量数据集 SharePoint 访问（[表单](https://tinyurl.com/8vpjmnjnr)）；是否申请 XML Web Service（需评估费用与「不得本地存储」对架构的冲击）。 |

---

## 7. ChiCTR 原站是否存在官方通道：**经系统排查，没有**

对 `chictr.org.cn` 及英文镜像做了完整导航排查（index / about / searchproj / file / guide / question 及 EN 变体）：

- **无 API、无 bulk export、无 dataset、无「数据共享」栏目。** 关键词扫描 API / 接口 / 数据导出 / 批量 / 开放 / web service / XML / CSV，只命中 **IPD 共享政策**讨论（研究者上传**自己**的数据），从未涉及 ChiCTR 发布的数据访问。
- **端点探测全部失败**：`/api` → Spring Boot 404 JSON；`/api/trials` → 404；`/robots.txt` → 404；`/sitemap.xml` → 404；`/swagger-ui.html` → 200 但正文是中文「404系统找不到页面」；`/bin/chictr/search` → 404。
- `file.html` / `fileEN.html`（「重要文件」）即全部下载区：只有 PDF + **一个** XLSX（一次性 COVID-19 专题索引 `.../2022/06/25/a1520a773971478091877bc0c5bf115f.xlsx`），**不是注册数据**。
- 站点页脚：`Copyright(c) (2005 - 2023) Chictr.org.cn. All rights reserved.` 蜀ICP备16010396号-9。
- ChiCTR 自报规模：**131,244** 条注册试验（106,400 前瞻性 / 24,445 回顾性；78,175 干预性 / 39,653 观察性）。

### 7.1 官方联系方式（存在，但**未被描述为数据访问通道**）

- 主任：吴泰相。地址：四川省成都市武侯区国学巷 37 号，四川大学华西医院，邮编 610041。香港办公室：香港九龍九龍塘聯福道 32 號浸會大學。
- 电话：+86 028 85424855（周一至周五 10:00–12:00, 14:00–16:00）、+86 028 85421743（周三、周五 14:30–16:30）。
- 服务邮箱（按 PID 尾号分配）：`chictr-s1@wchscu.cn` … `chictr-s7@wchscu.cn`；其他问题 → `chictr-s7@wchscu.cn`。
- 第三方登记的**不同**联系邮箱：re3data 记 `chictr001@chictr.org.cn`；medresman.org.cn 记 `chictr006@chictr.org.cn`。
- **关键**：以上**没有任何一个**被描述为 bulk data / API 申请入口。ChiCTR 站点上**不存在**成文的数据批量获取申请流程——发信等于向一个无关的支持邮箱冷启动。

### 7.2 ChiCTR 的访问限制性质

- re3data（权威第三方登记，`https://www.re3data.org/repository/r3d100013294`，2020-04-23 录入，2024-04-22 更新）原文：访问类型 **"open"**，但**数据访问类型 "restricted"**，限制类型 "other"，另有 "**embargoed**"；数据许可为 "**Copyrights**"。上传仅限注册，上传许可为《注册指南》。
- **即：受限访问 + 版权保护，不是开放许可，不可再分发。**
- **未能取得** ChiCTR 自身《Policy of the ChiCTR》PDF 的确切措辞：`DownloadFile` URL 在本环境**全部 405**（阿里云盾 2657 字节拦截页，body「很抱歉，由于您访问的URL有可能对网站造成安全威胁，您的访问被阻断。」），直接 `/uploads/documents/...` 路径 404。**因此：没有确认到明文反抓取条款，但同样没有确认到任何授权。**

### 7.3 ChiCTR 对原始数据（IPD）的官方立场 —— 已直接读到原文

《中国临床试验注册中心关于推进共享临床试验原始数据的公告》可经 `http://www.medresman.org.cn/html/ipd.pdf` 读到（HTTP 200，245,587 bytes，2 页）：

> 「1.原始数据必须能够共享，但公开共享时间由研究者决定；公开时间要求不迟于研究结果发表之后的 6个月内；2.**ResMan 网站可作为公众共享原始数据平台，但不提供下载，只能浏览，要下载数据必须与研究者联系，由研究者提供下载数据**；3.共享原始数据必须由伦理委员会批准，不得提供参试者的任何隐私信息。」

**即：ChiCTR 的官方立场是 IPD 只能在 ResMan 上浏览、不提供批量下载，下载须逐个联系研究者并获伦理批准。** 这是「存在但需逐个接洽」的通道，不是注册库级批量通道。

### 7.4 ResMan 平台现状（实测在线）

- `http://www.medresman.org.cn/` → 跳转 `login.aspx`（200）。公众访问入口 `/pub/cn/proj/search.aspx`（200）：列出 **11,172 条**记录 / 1,118 页，含公开题目、验证状态、研究疾病、研究类型、分期、申请人、研究负责人、主要申办方、地点等筛选，以及按国家/省份、疾病编码、实施机构、申办方的统计视图，每行有「参试者列表」。
- **注意语料规模差异**：ResMan 自持 **11,172** 条，远小于 ChiCTR 的 **131,244** 条——它是「研究者自愿存缴」的 IPD/EDC 平台，**不是注册库的镜像**。

### 7.5 已发表文献如何实际取得 ChiCTR 数据（旁证）

Fan R 等，《Chinese Clinical Trial Registry 13-year data collection and analysis》，Frontiers in Medicine，2023-10-12，DOI `10.3389/fmed.2023.1203346`，方法节原文：

> "**The records were extracted from the ChiCTR platform in batches from September 5 to October 21, 2020.**"
> "**We manually retrieved baseline characteristics from each trial record** including trial title, geographic location..."

即：一篇经过同行评议的 ChiCTR 全库数据集研究，是**逐批提取 + 人工誊录**建成的——论文**未引用任何 API、未提及任何官方批量导出、未提及任何豁免或 ChiCTR 提供的数据集**。截至本文档，**未发现任何描述「官方 ChiCTR 批量数据授予」的论文**。

---

## 8. 未确认 / 待验证

- **ICTRP 是否重新发布 ChiCTR 的完整记录集还是子集**，以及各注册库的同步时延——**未确认**。实测一条样本记录 `ChiCTR2000030254` 的 `Last refreshed on: 23 March 2020`，明显落后于其注册日期，且站点此后大幅增长。**不要把「完整集」当作已证事实。**
- 全量数据集 SharePoint 的实际内容与频率——需申请后确认。
- CSV 导出的服务端上限：本次 `pancreatic` 得 9,273 行 / 39 MB 未见截断，但未测试更大结果集。
- XML Web Service 的实际费用——官方仅称「可应要求提供」。
- 是否存在合法授权 ChiCTR 数据的商业聚合方（如药智网）——**未验证**。

### 8.1 全量数据集申请表单（已定位到真实地址）

[bit.ly 短链](https://tinyurl.com/8vpjmnjr) 实际指向：
**https://extranet.who.int/dataformv6/index.php/643633?lang=en**
标题：*Request access to the Sharepoint folder for downloading the ICTRP data files (CSV format)*

表单原文：

> "This form is to request access to the SharePoint folder for downloading the weekly ICTRP data files. **Identified institutions will be subject to a yearly fee based on their type and size. Please note that this form is not for individual requests; only forms submitted on behalf of institutions will be considered.** Searching the ICTRP Search Portal is free and downloading the search results from the Search Portal is also free and recommended for individual users."

表单字段：请求类型（个人研究者 / 机构或公司 1–499 / 500–4999 / >5000）、姓名、机构名称+类型（Non-Profit / For-Profit / Other）、地址、国家、邮箱、下载频率（Weekly/Monthly/Yearly/Other）、理由、强制接受条款。无截止日期。

**含义**：**个人用户走 Search Portal 免费导出即可，不要走这条路**；机构名义申请需按规模和类型缴年费。

### 8.2 第三方/未授权方案（全部基于抓取，无一获 ChiCTR 认可）

- GitHub `JAGAN666/chictr-mcp`、`PancrePal-xiaoyibao/chictr-mcp-server`（npm `chictr-mcp-server`）、聚合站 mcpworld.com 的「ChiCTR-MCP」条目、以及可能的药智网。
- **均属 (c) 类：未授权第三方。ChiCTR 未认可其中任何一个。**

### 8.3 按授权性质分类的汇总

| 类别 | 通道 | 可用性 |
|---|---|---|
| **(a) 官方、免申请** | WHO ICTRP Search Portal CSV/XML 导出 | ✅ 免费、每周更新、含 ChiCTR 记录、需署名、禁商业用途。**ChiCTR 自身：无任何此类通道。** |
| **(b) 需申请/接洽** | ICTRP XML Web Service | 邮件 `ictrpinfo@who.int`，费用可询；**但禁止本地存储与再分发 → 不适合本项目缓存架构** |
| | ICTRP 每周全量 CSV（SharePoint） | 仅限机构，缴年费，见 §8.1 |
| | ICTRP Crawling Service | **当前不可用**，填问卷排队 |
| | ChiCTR IPD（ResMan） | 仅公开浏览；逐条下载须联系研究者 + 伦理批准，可能收费 |
| **(c) 未授权第三方** | 各 ChiCTR MCP server、药智网等 | 均基于抓取，无认可 |

---

## 8. 复现命令

```bash
# 1) 确认 ChiCTR 被 WAF 前置
dig +short www.chictr.org.cn
# → swmw5wipdjs6vaheq64b4k93sq86rwgf.yundunwaf5.com. / 47.110.215.234

# 2) WHO ICTRP 完整链路（GET → 搜索 POST → CSV 导出 POST）
# 要点：必须回传 cookie；搜索提交全部隐藏字段 + TextBox1 + Button1；
#       导出只能提交「结果页」的隐藏字段 + Button7（不可带 TextBox1/Button1，否则 302 → NoAccess.aspx）
```

官方条款与通道入口：
- [Downloading records from the ICTRP database](https://www.who.int/tools/clinical-trials-registry-platform/network/who-data-set/downloading-records-from-the-ictrp-database)
- [ICTRP dataset in CSV format](https://www.who.int/news/item/08-03-2018-ictrp-dataset-in-csv-format)
- [WHO ICTRP Search Portal Web Service](https://www.who.int/tools/clinical-trials-registry-platform/the-ictrp-search-portal/ictrp-search-portal-web-service)
- [Web Service Conditions of Use (PDF)](https://cdn.who.int/media/docs/default-source/medicines/regulatory-updates/gbt/2021-fair-pricing-forum/web_service_conditions_of_use6723ca30-e833-4d32-a20f-792cb1717352.pdf)
- [ICTRP Crawling Service](https://www.who.int/tools/clinical-trials-registry-platform/the-ictrp-search-portal/ictrp-search-portal-crawling-service)
- 联系：`ictrpinfo@who.int`
