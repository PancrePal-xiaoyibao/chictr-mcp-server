# WHO ICTRP 抓取协议实测结论

> 实测日期：2026-10-04 · 全部结论由本机 curl 实测得出，非推测

## 0. 核心结论（最重要）

**不需要 F12 抓包搜索请求，也不需要 HTML 解析。**

ICTRP 高级搜索页在**提交搜索后**，结果页会渲染一个导出面板，其中有一个按钮
`ctl00$ContentPlaceHolder1$ucExportDefault$butExportAllTrials`
（界面上写 **"Export all trials to XML"**）。

点它 → 直接返回 **`application/xml` 附件**，包含**当前查询命中的全部记录**（不受分页限制）。

实测：查 `pancreatic cancer` → `3359 records for 3030 trials found!` → 导出 XML 22.1 MB / 3030 条 `<Trial>`。

这意味着整条链路是：
```
GET  AdvSearch.aspx              -> 拿 __VIEWSTATE/__EVENTVALIDATION + SessionId cookie
POST AdvSearch.aspx (填表单)      -> 结果页 HTML（含导出按钮 + 新 VIEWSTATE）
POST AdvSearch.aspx (btnLaunchDialogTerms) -> 弹条款对话框 HTML
POST AdvSearch.aspx (butExportAllTrials)   -> XML 全文附件
```
**4 次请求拿到全部结构化数据**，无需 Playwright、无分页、无验证码、无 WAF。

---

## 1. 关键请求参数

### 1.1 必须回传的 ASP.NET 隐藏字段

每次 POST 都要带上**上一步响应里最新**的：
- `__VIEWSTATE`
- `__VIEWSTATEGENERATOR`（初始为 `F6350304`）
- `__EVENTVALIDATION`
- `__EVENTTARGET`（空）、`__EVENTARGUMENT`（空）
- `ctl00_ContentPlaceHolder1_ToolkitScriptManager_HiddenField`（空）

> ⚠️ 用户提供的 `curl_ictrp_sample.md` 里**完全没有这些**——那份只有页面加载的 GET（css/js/图片/GA），
> 所以无法用于搜索。但既然 XML 导出可用，**根本不需要抓搜索的 POST**。

### 1.2 高级搜索表单字段（`ctl00$ContentPlaceHolder1$` 前缀）

| 字段 | 说明 | 取值 |
|---|---|---|
| `ddlTitle` | 标题逻辑 | `OperatorNone` / `OperatorNOT` |
| `txtTitle` | 标题关键词 | 自由文本 |
| `ddlOperatorCondition` | 条件逻辑 | `OperatorAND` / `OperatorANDNOT` / `OperatorOR` |
| `txtCondition` | **适应症/疾病**（本次用这个） | 自由文本，如 `pancreatic cancer` |
| `cbWithoutSynonymsCondition` | 不做同义词扩展 | checkbox |
| `ddlOperatorIntervention` | 干预逻辑 | `OperatorAND` / `OperatorANDNOT` / `OperatorOR` |
| `txtIntervention` | **干预/药物** | 自由文本 |
| `cbWithoutSynonymsIntervention` | 干预不做同义词 | checkbox |
| `chkRestrictToCOVID` | 限 COVID-19 | checkbox |
| `chkSearchClinical` | 搜索范围开关 | checkbox |
| `ddlRecruitingStatus` | 招募状态 | `1` = Recruiting / `ALL` = ALL |
| `txtPrimarySponsor` | 主要申办方 | 自由文本 |
| `txtSecondaryID` | 次要 ID | 自由文本 |
| `lstCountries` / `txtFreeCountry` / `lstCountriesSelected` | 国家（需但 `butAdd` 加入） | 199 国 |
| `txtDateStart` / `txtDateEnd` | 注册日期区间 | 日期 |
| `ListBoxPhase` | 分期 | `All` / `Phase 0` / `1` / `2` / `3` / `4` |
| `chkWithResultsOnly` | 仅含有结果的 | checkbox |
| `chkRareDiseasesOnly` | 仅罕见病 | checkbox |
| `chkGeneEditing` | 基因编辑 | checkbox |
| `postbacktextbox` | 固定 | `Advanced` |
| `postbacktextbox1` | 固定 | `True` |
| `btnSearch` | 提交按钮 | `Search` |

### 1.3 导出链路字段

| 步骤 | 提交字段 |
|---|---|
| 第 2 步（结果页） | `ctl00$ContentPlaceHolder1$ddlPageSize`=10、`...$btnLaunchDialogTerms`=`Export results to XML` |
| 第 3 步（条款弹窗） | `ctl00$ContentPlaceHolder1$ucExportDefault$butExportAllTrials`=`Export all trials to XML` |

另有 `ucExportDefault$butExportSelectedRecord`（仅导出勾选）。

---

## 2. XML Schema

根节点 `<Trials_downloaded_from_ICTRP>`，每条 `<Trial>`。字段填充率实测：

```
Trial                        3030   (100%)
Export_date                  3030
Internal_Number              3030   <- 去重主键
TrialID                      3030   <- 注册号
Last_Refreshed_on            3030
Public_title                 3030
Prospective_registration     3030
Date_registration3           3030   (YYYYMMDD)
Date_registration            3030   (YYYY-MM-DD)
Source_Register              3030
web_address                  3030
other_records                3030
Study_type                   3030
Condition                    3030
Primary_sponsor              3029
Inclusion_Criteria           3028
Scientific_title             3016
Date_enrollement             3014
Recruitment_Status           3006
Target_size                  2961
Primary_outcome              2953
Inclusion_gender             2943
Source_Support               2863
Countries                    2793
Inclusion_agemin             2761
Study_design                 2759
Intervention                 2743
Inclusion_agemax             2704
Phase                        2700
Contact_Affiliation          2465
Contact_Firstname            2421
Secondary_outcome            2322
Contact_Lastname             2092
Secondary_ID                 2015
Contact_Email                1912
Contact_Tel                  1906
Exclusion_Criteria           1414
Ethics_review_approval_date  1303
Ethics_review_status         1245
Contact_Address              1238
Secondary_Sponsor             748
results_yes_no                694
results_ipd_plan              437
Acronym                       327
results_url_link              296
results_summary               107
```

### 样例记录（精简）

```xml
<Trial>
  <Export_date>10/04/2026 04:51:51</Export_date>
  <Internal_Number>16104120</Internal_Number>
  <TrialID>ChiCTR2600132949</TrialID>
  <Last_Refreshed_on>21 September 2026</Last_Refreshed_on>
  <Public_title>A Clinical Study of Maintenance Chemotherapy Regimens After Resectable Pancreatic Cancer: ...</Public_title>
  <Primary_sponsor>Fujian Medical University Union Hospital</Primary_sponsor>
  <Prospective_registration>Yes</Prospective_registration>
  <Date_registration3>20260920</Date_registration3>
  <Date_registration>2026-09-20</Date_registration>
  <Source_Register>ChiCTR</Source_Register>
  <web_address>https://www.chictr.org.cn/showproj.html?proj=344425</web_address>
  <Recruitment_Status>Not Recruiting</Recruitment_Status>
  <Inclusion_agemin>18</Inclusion_agemin>
  <Inclusion_agemax>80</Inclusion_agemax>
  <Inclusion_gender>Both</Inclusion_gender>
  <Target_size>Capecitabine maintenance group:49;S-1 maintenance group:49;follow-up group:49;</Target_size>
  <Study_type>Interventional study</Study_type>
  <Study_design>Parallel</Study_design>
  <Phase>N/A</Phase>
  <Countries>China</Countries>
  <Contact_Email>fengchun160@fjmu.edu.cn</Contact_Email>
  <Inclusion_Criteria>Inclusion criteria: 1.Histologically confirmed pancreatic cancer;&#x0D;&lt;br&gt;...</Inclusion_Criteria>
  <Exclusion_Criteria>Exclusion criteria: 1.Distant metastasis...</Exclusion_Criteria>
  <Condition>pancreatic cancer</Condition>
  <Intervention>Capecitabine maintenance group:Oral capecitabine monotherapy...</Intervention>
  <Primary_outcome>Recurrence-free survival(RFS);</Primary_outcome>
  <Secondary_outcome>Incidence of adverse events;Overall survival (OS);</Secondary_outcome>
</Trial>
```

### 注意点
- 文本里残留 HTML 实体：`&#x0D;`（CR）、`&lt;br&gt;`（字面量 `<br>`）——**必须二次清洗**。
- `Scientific_title` 有大量尾随空白。
- `Date_registration` 是 `YYYY-MM-DD`，`Date_registration3` 是 `YYYYMMDD`。
- **`Internal_Number` 是稳定去重键**，比 `TrialID` 更适合做增量同步（TrialID 在部分注册库会变）。

### 本次查询的来源注册库分布（3030 trials）

| 注册库 | 条数 |
|---|---|
| ClinicalTrials.gov | 1614 |
| JPRN | 640 |
| ChiCTR | 379 |
| EU Clinical Trials Register | 164 |
| NL-OMON | 76 |
| ANZCTR | 58 |
| ISRCTN | 39 |
| Clinical Trials Information System | 32 |
| TCTR / CTRI | 7 / 7 |
| ITMCTR | 6 |
| IRCT | 4 |
| German Clinical Trials Register | 3 |
| RPCEC | 1 |

---

## 3. 复现脚本（curl 三步）

```bash
# 1) 拿页面 + cookie
curl -s -c ck.txt -o p1.html 'https://trialsearch.who.int/AdvSearch.aspx' -H 'User-Agent: Mozilla/5.0'

# 2) POST 表单（Python 解析 p1.html 的隐藏字段后拼接表单字段）-> p2.html
# 3) POST btnLaunchDialogTerms -> p3.html
# 4) POST ucExportDefault$butExportAllTrials -> ICTRP-Results.xml  (application/xml, ~22MB)
```

实测 HTTP 头：
```
Content-Type: application/xml
Content-Disposition: attachment;filename=ICTRP-Results.xml
```

---

## 4. 与现有代码的关系

- 现有仓库 `chictr-mcp-server` 面向 **ChiCTR (chictr.org.cn)**，走 Playwright + cheerio HTML 解析。
- ICTRP XML 里 **`Source_Register=ChiCTR` 的 379 条** 带 `web_address` 直指
  `https://www.chictr.org.cn/showproj.html?proj=XXXXX`
  → 正好补齐现有 `search.ts` 解析出的 `project_id`，可做跨库 join。
- ICTRP 单次查询即覆盖 14 个注册库，**是全球视图**，比 ChiCTR 单库宽得多。
