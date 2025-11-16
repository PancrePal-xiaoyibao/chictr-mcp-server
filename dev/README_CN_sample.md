# Clinical Trials MCP 服务器

[English](./README.md) | 简体中文

基于 ClinicalTrials.gov API v2 的 MCP 服务器，提供智能临床试验查询功能，默认优化为查找相关的、正在招募的试验。

## 功能特性

- 🔍 **智能搜索**：支持关键词、疾病类型、地理位置搜索
- 📍 **地理定位**：支持国家、城市或地理坐标查询
- ⏰ **时间过滤**：默认查询过去3个月（招募中的试验）
- 📊 **详细信息**：包含 PI、联系方式、入选标准的完整试验详情
- 🌐 **双语支持**：支持中英文查询

## 快速开始

**无需安装！直接运行：**

```bash
npx xiaoyibao-clinical-trials
```

## MCP 客户端配置

添加到你的 MCP 客户端设置：

### 使用 npx（推荐）

```json
{
  "mcpServers": {
    "clinical-trials": {
      "command": "npx",
      "args": ["-y", "xiaoyibao-clinical-trials"]
    }
  }
}
```

### 使用本地安装

```bash
npm install -g xiaoyibao-clinical-trials
```

```json
{
  "mcpServers": {
    "clinical-trials": {
      "command": "xiaoyibao-clinical-trials"
    }
  }
}
```

## 可用工具

### 1. `search_clinical_trials`

搜索临床试验，使用智能默认值。

**默认行为：**
- 状态：`RECRUITING`（正在招募）
- 时间：过去3个月（更有可能开放）
- 结果：30个最相关试验，按最近更新排序

**参数：**
- `keywords` (string): 关键词，如 "KRAS G12D"、"PD-1"、"Pembrolizumab"
- `condition` (string): 疾病/状况，如 "胰腺癌"、"Pancreatic Cancer"
- `country` (string): 国家名称，如 "中国"、"China"、"United States"
- `city` (string): 城市名称，如 "北京"、"上海"、"New York"
- `months` (number): 时间范围（月），默认：3
- `status` (string): 招募状态，默认："RECRUITING"
- `pageSize` (number): 每页结果数，默认：30，最大：100
- `pageToken` (string): 分页令牌

**示例：**

```json
{
  "keywords": "KRAS G12D",
  "condition": "胰腺癌",
  "country": "中国"
}
```

### 2. `get_trial_details`

获取全面的试验详情，包括：
- 主要研究者（PI）信息
- 各城市医院地点
- 联系方式（电话、邮箱）
- 详细研究介绍
- 入选/排除标准
- 主要/次要结果指标

**参数：**
- `nctId` (string, 必需): NCT 编号，如 "NCT04852770"

**示例：**

```json
{
  "nctId": "NCT04852770"
}
```

### 3. `search_by_location`

根据地理坐标搜索试验。

**参数：**
- `latitude` (number, 必需): 纬度
- `longitude` (number, 必需): 经度
- `radius` (number): 搜索半径（英里），默认：50
- `condition` (string): 疾病/状况（可选）
- `keywords` (string): 关键词（可选）
- `status` (string): 招募状态，默认："RECRUITING"
- `months` (number): 时间范围，默认：3
- `pageSize` (number): 每页结果数，默认：30

**示例：**

```json
{
  "latitude": 39.9042,
  "longitude": 116.4074,
  "radius": 50,
  "condition": "肺癌"
}
```

## 输出格式

所有响应均为 JSON 格式，优化供 LLM 处理。

### 搜索结果

```json
{
  "totalCount": 13,
  "count": 13,
  "studies": [
    {
      "nctId": "NCT06218914",
      "title": "Phase 1 Study to Investigate TCRTs KRAS Mutation...",
      "status": "RECRUITING",
      "conditions": ["Pancreatic Cancer", "KRAS G12D"],
      "interventions": [{"type": "Drug", "name": "NT-112"}],
      "sponsor": "AstraZeneca",
      "studyType": "INTERVENTIONAL",
      "phase": ["PHASE1"],
      "lastUpdate": "2024-10-15"
    }
  ]
}
```

### 试验详情

包含所有搜索字段，以及：
- `investigators[]` - PI 和研究团队
- `overallOfficials[]` - 研究负责人
- `centralContacts[]` - 全局联系信息（电话、邮箱）
- `locations[]` - 所有医院地点及当地联系人
- `locationsSummary` - 统计信息（国家、城市、总地点数）
- `eligibility` - 详细入选/排除标准
- `primaryOutcomes[]`, `secondaryOutcomes[]` - 研究终点
- `briefSummary`, `detailedDescription` - 完整研究描述

## API 参考

- [ClinicalTrials.gov API 文档](https://clinicaltrials.gov/data-api/api)
- [构建复杂查询](https://clinicaltrials.gov/find-studies/constructing-complex-search-queries)
- [搜索区域](https://clinicaltrials.gov/data-api/about-api/search-areas)

## 开发

```bash
# 克隆仓库
git clone git@github.com:PancrePal-xiaoyibao/xiaoyibao-clinical-trials-mcp-server.git
cd xiaoyibao-clinical-trials-mcp-server

# 安装依赖
npm install

# 运行测试
npm test

# 启动服务器
npm start
```

## 发布到 npm

```bash
# 登录 npm
npm login

# 发布包
npm publish
```

## 许可证

MIT

## 贡献

欢迎贡献！请提交 issue 或 pull request。
