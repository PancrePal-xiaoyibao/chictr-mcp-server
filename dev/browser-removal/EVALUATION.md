# 取消 500MB 浏览器依赖 — 可行性评估

**日期**: 2026-10-04
**结论**: ❌ **不可行**（就"用 HTTP 直连替换 Playwright"而言）
**但发现了一个更重要的问题**: 🚨 **ChiCTR 目前对搜索/详情页面全面封锁，包括 Playwright 在内的所有方式当前都拿不到数据**

---

## 一、你的假设与实测结果

你的推理链条是：*列表页是 cheerio 静态解析 → 所以浏览器只负责"取 HTML" → 所以可以换 HTTP 直连*。

这个推理在**逻辑上成立**，但有一个前提被忽略了：**浏览器不只是"取 HTML"，它还是一个能执行 JavaScript 的引擎**。而 ChiCTR 恰恰在这一点上做了文章。

### 实测证据

| # | 请求 | Egress | 结果 |
|---|------|--------|------|
| 1 | `GET /searchproj.html` | 本机 IP | **405** + 阿里云盾拦截页（2657 bytes，`Server: Tengine`） |
| 2 | `GET /showproj.html?proj=…` | 本机 IP | **405** 同上 |
| 3 | `GET /index.html` | 本机 IP | **200** 正常内容（34719 bytes） |
| 4 | `GET /searchproj.html` | **第三方 egress** | **200** + 阿里云 `acw_sc__v2` JS 挑战页（17136 bytes，含 `var arg1='FC0C2D…'`） |
| 5 | `GET /index.html` | 同第三方 egress | **200** 正常内容，**无挑战** |

第 4 条是决定性的：**换一个出口 IP，searchproj.html 就不再是 405，而是一个需要解 JS 的挑战页。**

### 本机被封锁的页面清单（Playwright 实跑）

```
200  /index.html                      正常
200  /sponsorproj.html                正常
200  /regstatusproj.html              正常
200  /recruitmentstatusproj.html      正常
200  /ailmentcodeproj.html            正常
200  /measureproj.html                正常
200  /guide.html                      正常
405  /searchproj.html                 ← 搜索页，被封
405  /showproj.html?proj=219315       ← 详情页，被封
```

**站点基础设施正常，只有"搜索列表"和"项目详情"这两个数据入口被精准封锁。**

---

## 二、为什么 HTTP 直连救不了

### 2.1 这不是"反爬对抗"，是"JS 执行能力"要求

用不同 IP 拿到的挑战页长这样（截取）：

```html
<script>
    var arg1='FC0C2D8AD5673C5FB8B9EF3180ECC395B9A5F944';
    function setCookie(name,value){...document.cookie=name+"="+value+...}
    function reload(x) {setCookie("acw_sc__v2", x);document.location.reload();}
</script>
<script name="aliyunwaf_6a6f5ea8">var _0x4818=[...];(function(_0x4c97f0,_0x1742fd){
   ... while(--_0x48181e){_0x4c97f0['push'](_0x4c97f0['shift']());} ...
}(_0x4818,0x15b)); ...</script>
```

这是阿里云盾经典的 `acw_sc__v2` 挑战：
1. 服务端下发一段**每个请求都不同**的混淆 JS（`arg1` 每次都变，我两次抓取分别是 `FC0C2D8A…` 和 `AD62C220…`）
2. 页面 JS 计算出 `arg2`
3. `setCookie("acw_sc__v2", arg2)` 然后 `location.reload()`
4. 带着这个 cookie 重新请求，才拿到真实 HTML

**关键点**：`curl` 做不到第 2 步。这正是浏览器存在的意义——不是渲染，是**执行**。

### 2.2 用 Node 直接跑这段脚本也不行

我把挑战脚本抽出来（16,715 bytes）在 Node 里 eval，加了 DOM shim：

```js
globalThis.document = { cookie: ..., location:{reload(){}} };
globalThis.reload = (x)=>{ solved = x; };
(0,eval)(code);
```

结果：**进程静默无输出地死掉**——`console.log('after')` 永远执行不到。脚本里埋了反分析逻辑：

```js
while(window['__phantomas']){}        // 反 PhantomJS 死循环
_0x355d23(++_0x450614);               // 递归到栈溢出，靠 try/catch 兜住
setInterval(function(){_0x4db1c();},0xfa0);  // 持续重入
```

用真实 Chromium 加载同一个挑战页文件，**同样卡死**（我起了个 120 秒的 job，超时后手动 kill）。它需要真实的浏览器环境语义才肯完成计算。

### 2.3 所以"换 HTTP 直连"的收益是假的

- 直连 → 405（本机）或挑战页（换 IP），**拿不到 `table.table1`**
- 要过挑战 → 必须执行 JS → 又回到了浏览器/JS 引擎
- 真正能省掉浏览器的前提（"服务端返回静态 HTML，不需要执行任何 JS"）**在当前版本的 ChiCTR 上不成立**

---

## 三、更紧急的问题：现在所有方式都拿不到数据

这才是我建议你优先关注的：

1. **本机 IP 已被阿里云盾拉黑 405**。11 次连续请求（跨 60+ 秒）全部 405，包括带完整 `sec-ch-ua` / `Sec-Fetch-*` 头、HTTP/2、历史 cookie 重放。`dev/plan.md:65` 和 `dev/plan.md:91` 里那两个"手工 curl 成功"的样本带了 `ssxmod_itna` cookie——那是**真实浏览器里跑出来的会话指纹**，不是 curl 能自己生成的。
2. **Playwright 也已经失效**。项目里 `playwright@1.62.1` 期望 `chromium-1234`，本机缓存只有 `chromium-1243`，启动直接报 `Executable doesn't exist at .../chromium_headless_shell-1234/...`。我绕过版本绑定、用 `executablePath` 强制指向 1243 才跑起来——**跑起来后 searchproj 依然是 405**。
3. 换言之：**这不是"要不要用浏览器"的取舍，而是"当前这套方案整体已经不能用了"。**

### 项目正在承担的浏览器成本（你的 500MB 说法是准确的）

```
/Users/qinxiaoqiang/Library/Caches/ms-playwright   557 MB
  chromium-1243
  chromium_headless_shell-1243
  ffmpeg-1011
package.json:  "postinstall": "playwright install chromium"
```

`package.json` 的 `postinstall` 会在每次 `npm install` 时拉整套 Chromium——对使用者是 500MB+ 的固定入场费，而它现在**连一次有效的搜索都换不来**。

---

## 四、可行的方向（按投入产出排序）

### 方案 A：修复 + 保留浏览器，但改掉"启动即下载"
**性价比最高，建议先做。**

- `postinstall` 里的 `playwright install chromium` 改为**懒加载 + 首次使用时提示**，或改成 `playwright install --dry-run` 检测
- 同时兼容本机已有 Chromium：用 `channel: 'chrome'` 或探测 `~/Library/Caches/ms-playwright/chromium-*` 任选可用版本，而不是死绑 `chromium-1234`
- 收益：不用再为一次都没成功的抓取付 500MB；同时修掉当下的启动崩溃

### 方案 B：把"过挑战"这一步独立出来（推荐与 A 组合）
阿里云 `acw_sc__v2` 挑战是**可以纯 JS 解**的（公开的 `unsbox` + `hexXor` 算法，不需要浏览器）。真正的障碍是那段反分析混淆，可以：
- 用 `jsdom` 而不是 Chromium 来提供 JS 环境（约 10MB vs 557MB），配 `--stack-size` 和超时护栏；
- 或者用成熟的第三方解法（不少开源项目已实现该算法的纯 JS 版本）。

**风险**：混淆版本会变（脚本 `<script name="aliyunwaf_6a6f5ea8">` 里的 hash 就是版本标识），属于持续对抗，需要维护成本。

### 方案 C：改从 WHO ICTRP 取数 —— ✅ **已打通，这是真正的解法**
**（本节于 2026-10-04 晚更正：原结论"手搓 postback 没打通"是错的，见下）**

ChiCTR 是 WHO ICTRP 的一级注册机构，数据会上报 ICTRP，因此可以**不经过阿里云盾**取数。

**✅ 出口畅通**
```
https://trialsearch.who.int/                  -> 200, 36418 bytes, 无挑战、无 405
https://trialsearch.who.int/Default.aspx      -> 200, 36430 bytes
```
本机 IP 直连 ICTRP **完全畅通**，不经过阿里云盾，也没有 `acw_sc__v2`。

**❌ 我最初的失败 → ✅ 已找到原因**

我最初只带了 `__VIEWSTATE` + `__VIEWSTATEGENERATOR`，所以拿到 108KB 的 AJAX 脚本载荷（`table` 数 0、无试验 ID）。**缺了两样东西**：

| 缺失 | 后果 |
|---|---|
| **`__EVENTVALIDATION`** | ASP.NET 拒绝 postback，只回脚本载荷 |
| **回传 `Set-Cookie`** | 会话不连续 |

补齐后**纯 HTTP 全链路一次跑通**（复现自 JAGAN666/chictr-mcp 的 `src/scraper.ts:547-628`）：
```
GET  Default.aspx  → 提取 __VIEWSTATE / __VIEWSTATEGENERATOR / __EVENTVALIDATION + cookies
POST Default.aspx  → 上述字段 + __VIEWSTATEENCRYPTED(空) + TextBox1=<词> + Button1=Search
                     Referer: https://trialsearch.who.int/Default.aspx
   -> HTTP=200 SIZE=69146 error_page=0，命中 10 个 Trial2.aspx?TrialID= 链接
      ChiCTR2600132941 / ChiCTR2600132949 / NCT07829471 / ...
GET  Trial2.aspx?TrialID=ChiCTR2600132941
   -> HTTP=200 SIZE=63101，含 60 个 DataList*_ctl*_*Label 控件
```
**全程 curl / axios，零浏览器、零 JS 引擎。** 这是唯一真正满足"取消 500MB 浏览器依赖"的路径。

**⚠️ 已知代价**：ICTRP 的部分字段填充率低。实测样本中 `PhaseLabel=N/A`、`AllocationLabel=`（空）、`AssignementLabel=`（空）——即**分期 / 随机化 / 盲法**常缺失，是相对 ChiCTR 原始详情页的真实差距。其余 27+ 字段（标题、疾病、干预、入排标准、样本量、申办方、注册日期等）均可用。

→ 详见 [EVAL_JAGAN666_chictr-mcp.md](EVAL_JAGAN666_chictr-mcp.md)

### 方案 D：用本机已装的真 Chrome（零下载）
`channel: 'chrome'` 直接调用 `/Applications/Google Chrome.app`，不占额外 500MB，且指纹是真实 Chrome，过挑战概率更高。**适合作为 A 的补充。**

---

## 五、关于"不要污染 main 版本"

本次评估**未改动任何 main 版本文件**：
- 所有探测均为只读 HTTP 请求 + 临时文件（`/tmp/`）
- 唯一新增物是本目录 `dev/browser-removal/`
- `git status` 中 `src/` 的既有改动**均为本次会话开始前就存在**，我没有触碰

---

## 六、建议的下一步

我建议**先回答一个问题**，它决定后面所有的投入方向：

> **ChiCTR 是不是可以换成 WHO ICTRP 作为数据源？**

- 如果**可以** → 走方案 C（ICTRP 出口已验证畅通、无阿里云盾），浏览器依赖自然消失；但需要专门攻关一轮把查询 postback 打通
- 如果**不可以**（业务上必须用 ChiCTR 原始详情页） → 走方案 A+B+D 组合，浏览器保留但瘦身，把 500MB 降到"用本机 Chrome"，并补上挑战求解

### 但无论选哪条，有两件事都是当前就该做的

1. **修 Playwright 版本绑定**（`chromium-1234` vs 本机 `1243`）——不然插件现在**一次都跑不起来**，这是比"要不要浏览器"更急的故障
2. **把 `postinstall: playwright install chromium` 拿掉或改成懒加载**——500MB 的下场是"换不来一次成功抓取"，这个成本必须先止住

要我先做哪一个？

---

## 七、必须说清的一点：本机 IP 已被拉黑，这会干扰后续所有测试

当前状态是「**本机出口 IP 对 searchproj/showproj 返回 405**」。这意味着：

- 在本机环境下，**无论你用 Playwright、curl 还是别的什么，都测不出真实结果**——全是 405
- 我判定"HTTP 直连不可行"的证据链里，**最硬的一条其实是来自换 IP 的对照实验**（第 4 条：换 egress 后 405 变成可过的 JS 挑战页），而不是本机的 405 本身
- 所以如果后面要继续验证，**需要先解决出口 IP 的问题**（换个网络 / 挂代理），否则所有实测都是在跟 405 较劲

这一点请务必知悉，否则容易把"本机被封"误判成"方案不行"。

---

## 附：本次探测的复现命令

```bash
# 本机 IP 直连（预期 405）
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' \
  'https://www.chictr.org.cn/searchproj.html?title=KRAS&btngo=btn'

# 换 egress 看挑战页（预期 200 + arg1=）
curl -sS 'https://api.allorigins.win/raw?url=https%3A%2F%2Fwww.chictr.org.cn%2Fsearchproj.html%3Ftitle%3DKRAS%26btngo%3Dbtn'

# Playwright 版本不匹配的症状
node -e "require('playwright').chromium.launch()" 
# -> Executable doesn't exist at .../chromium_headless_shell-1234/...
```
