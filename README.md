# ChiCTR MCP Server

[![npm version](https://img.shields.io/npm/v/chictr-mcp-server.svg)](https://www.npmjs.com/package/chictr-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

ChiCTR MCP Server 是一个基于 Model Context Protocol (MCP) 的临床试验查询服务，专门用于查询中国临床试验注册中心 (ChiCTR) 的临床试验信息。

**当前版本**: v2.0.0

## 🔔 版本更新

### v2.0.0 (2026-04-09)
- ✅ 新增请求编排层（限速/重试/熔断）
- ✅ 新增 Session 池化与生命周期回收
- ✅ 新增挑战状态机与恢复工具（get_access_state / prepare_verification_session / resume_after_verification）
- ✅ 新增双层缓存（L1 内存 + L2 SQLite）与 get_cache_stats_v2

### v1.2.1 (2025-01-17)
- ✅ 更新 README，添加多维度搜索示例
- ✅ 添加版本升级指南
- ✅ 提供 Cherrystudio 缓存清除方案

### v1.2.0 (2025-01-17)
- ✅ 新增按注册号搜索（registration_number 参数）
- ✅ 新增按年份搜索（year 参数，默认当前年份）
- ✅ 所有搜索参数改为可选
- ✅ 修复详情查询 400 错误（使用正确的 project_id）

### v1.1.0 (2025-01-17)
- ✅ 修复分页功能，支持多页结果获取
- ✅ 支持代理配置（HTTP_PROXY/HTTPS_PROXY）
- ✅ 增加验证码检测与友好错误提示

## 📍 快速导航

- [🎯 支持的 MCP 服务类型](#-支持的-mcp-服务类型)
- [🌟 功能特点](#-功能特点)
- [🚀 快速开始](#-快速开始)
- [📋 可用工具](#-可用工具)
- [📡 MCP 配置说明](#-mcp-配置说明)

## 🐛 已知问题

- 频繁请求可能触发滑动验证码，建议使用代理或增加请求间隔
- headless 模式下无法手动处理验证码

## 🎯 支持的 MCP 服务类型

- **stdio**: 标准输入输出通信（默认）
- **http**: HTTP REST API 服务（计划中）
- **sse**: Server-Sent Events 实时通信服务（计划中）

## 🌟 功能特点

- **MCP 协议兼容**: 完全支持 Model Context Protocol 标准
- **多维度搜索**: 支持按标题关键词、注册号、年份搜索
- **详细信息**: 提供临床试验的完整详细信息
- **高性能**: 内置智能缓存机制，提升查询速度
- **反爬虫处理**: 使用浏览器自动化技术应对网站防护机制

## 🚀 快速开始

### 安装依赖
```bash
npm install
```

### 编译项目
```bash
npm run build
```

### 启动服务器

#### STDIO 模式（默认）
```bash
npm start
# 或
node dist/index.js

# 带参数启动（未来版本支持）
# node dist/index.js --transport=http --port=3000
```

## 📋 可用工具

### search_trials
搜索临床试验，支持按标题关键词、注册号、年份进行搜索

```json
// 按关键词搜索
{
  "name": "search_trials",
  "arguments": {
    "keyword": "KRAS",
    "max_results": 20
  }
}

// 按注册号搜索
{
  "name": "search_trials",
  "arguments": {
    "registration_number": "ChiCTR2500111173"
  }
}

// 按年份搜索
{
  "name": "search_trials",
  "arguments": {
    "year": 2024,
    "max_results": 20
  }
}

// 组合搜索
{
  "name": "search_trials",
  "arguments": {
    "keyword": "KRAS",
    "year": 2024,
    "max_results": 10
  }
}
```

**参数说明**：
- `keyword` (可选): 注册题目关键词
- `registration_number` (可选): 临床试验注册号
- `year` (可选): 注册年份，默认当前年份
- `max_results` (可选): 最大返回结果数，默认20

### get_trial_detail
查询试验详情
```json
{
  "name": "get_trial_detail",
  "arguments": {
    "registration_number": "ChiCTR2500108082"
  }
}
```

### get_cache_stats
获取缓存统计信息
```json
{
  "name": "get_cache_stats",
  "arguments": {}
}
```

### clear_cache
清除所有缓存
```json
{
  "name": "clear_cache",
  "arguments": {}
}
```

## 🛠️ CLI 命令行工具

### 安装 CLI
```bash
# 全局安装
npm install -g chictr-mcp-server

# 或者直接使用 npx（推荐）
npx -y chictr-mcp-server
```

### 使用 CLI
```bash
# 启动 STDIO 服务
chictr-mcp-server

# 或使用 npx
npx -y chictr-mcp-server

# 带参数启动（未来版本支持）
# chictr-mcp-server --transport=http --port=3000
# chictr-mcp-server --transport=sse --port=3000
# chictr-mcp-server --help
```

## 🛠️ 技术栈

- **TypeScript**: 类型安全的 JavaScript 超集
- **Playwright**: 浏览器自动化工具
- **Cheerio**: 服务器端 jQuery 实现
- **Node-Cache**: 高性能缓存库
- **MCP SDK**: Model Context Protocol 官方 SDK

## 🔧 高级配置

### 代理设置（可选）

如果您需要使用代理访问 ChiCTR，可以通过环境变量配置：

```bash
# 设置 HTTP 代理
export HTTP_PROXY=http://your-proxy-server:port

# 或者 HTTPS 代理
export HTTPS_PROXY=http://your-proxy-server:port

# 然后启动服务
npx -y chictr-mcp-server
```

#### MCP 客户端中使用代理
```json
{
  "mcpServers": {
    "chictr": {
      "command": "npx",
      "args": ["-y", "chictr-mcp-server"],
      "env": {
        "HTTP_PROXY": "http://your-proxy-server:port"
      }
    }
  }
}
```

**注意**：
- 代理配置是可选的，大多数情况下不需要
- 如果频繁触发验证码，建议使用代理或更换 IP
- 本项目不提供代理服务，需要用户自行准备

## 📡 MCP 配置说明

### MCP 客户端配置

#### 使用 npx（推荐，最简配置）
```json
{
  "mcpServers": {
    "chictr": {
      "command": "npx",
      "args": ["-y", "chictr-mcp-server@latest"]
    }
  }
}
```

#### 使用本地安装
```bash
npm install -g chictr-mcp-server
```

```json
{
  "mcpServers": {
    "chictr": {
      "command": "chictr-mcp-server"
    }
  }
}
```

#### HTTP 模式配置（计划中）
```json
{
  "mcpServers": {
    "chictr": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

#### SSE 模式配置（计划中）
```json
{
  "mcpServers": {
    "chictr": {
      "type": "sse",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## 🚀 MCP 测试

要测试 MCP 服务，您可以使用以下命令：

```bash
npx @modelcontextprotocol/inspector npx -y chictr-mcp-server
```

需要提前安装 @modelcontextprotocol/inspector
```bash
npm install -g @modelcontextprotocol/inspector

```

## 📊 性能优化

- **智能缓存**: 搜索结果缓存 5 分钟，详情数据缓存 10 分钟
- **浏览器自动化**: 使用 Playwright 模拟真实浏览器行为
- **反爬虫处理**: 内置 User-Agent 和延迟机制

## 🧪 使用示例

### 查询 KRAS G12D 相关试验
```bash
# 搜索最近 6 个月的 KRAS G12D 相关试验
{
  "name": "search_trials",
  "arguments": {
    "keyword": "KRAS G12D",
    "months": 6,
    "max_results": 10
  }
}
```

### 查询特定试验详情
```bash
# 查询注册号为 ChiCTR2500108082 的试验详情
{
  "name": "get_trial_detail",
  "arguments": {
    "registration_number": "ChiCTR2500108082"
  }
}
```

## 📈 查询结果示例

### 搜索结果
```json
{
  "results": [
    {
      "registration_number": "ChiCTR2500108082",
      "title": "谷氨酰胺联合奥沙利铂、卡培他滨（XELOX）和贝伐珠单抗一线治疗KRAS G12D基因突变型晚期结直肠癌的单臂Ⅱ期探索性研究",
      "study_type": "干预性研究",
      "registration_date": "2025/08/25",
      "institution": "浙江大学医学院附属第二医院"
    }
  ]
}
```

## 🔧 配置说明

### TypeScript 配置
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

### 缓存配置
- 搜索结果缓存: 5 分钟 (300 秒)
- 详情数据缓存: 10 分钟 (600 秒)

## 🤝 集成方式

ChiCTR MCP Server 当前支持 STDIO 通信方式，可以轻松集成到任何支持 MCP 协议的应用中：

### STDIO 模式（默认）
通过标准输入输出与客户端通信，适用于大多数 MCP 客户端。

### HTTP 模式（计划中）
通过 HTTP REST API 与客户端通信，支持跨网络访问。
- 端点: `http://localhost:3000/mcp`
- 方法: POST
- Content-Type: application/json

### SSE 模式（计划中）
通过 Server-Sent Events 与客户端通信，支持实时推送。
- 端点: `http://localhost:3000/mcp`
- 事件类型: `message`

## 📄 许可证

MIT License

## 📞 支持

如有问题，请提交 GitHub Issue。

## 🙏 致谢

本项目使用中国临床试验注册中心 (ChiCTR) 的公开数据，感谢 ChiCTR 为医学研究做出的贡献。
特别感谢[小胰宝](www.xiaoyibao.com.cn)和 [小x宝社区](https://info.xiao-x-bao.com.cn)的❤️贡献与付出，用爱心与人工智能为癌症/罕见病患者及其家庭提供支持！
