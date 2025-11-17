# ChiCTR MCP Server 开发日志

## 项目概述
开发一个基于 Model Context Protocol (MCP) 的临床试验查询服务，专门用于查询中国临床试验注册中心 (ChiCTR) 的临床试验信息。

## 开发过程

### 1. 项目初始化
- 创建项目目录结构
- 初始化 package.json 配置文件
- 配置 TypeScript 编译选项
- 添加必要的依赖包：
  - @modelcontextprotocol/sdk: MCP 协议支持
  - playwright: 浏览器自动化处理反爬虫
  - cheerio: HTML 解析库
  - node-cache: 缓存机制

### 2. 核心架构设计
- 采用 Playwright 浏览器自动化方案应对 ChiCTR 反爬虫机制
- 实现 STDIO 通信方式支持 MCP 协议
- 设计模块化架构：
  - BrowserManager: 浏览器管理
  - HtmlParser: HTML 解析器
  - SearchService: 搜索服务
  - DetailService: 详情查询服务

### 3. 功能实现

#### 3.1 浏览器管理器 (browser.ts)
- 配置 Playwright 浏览器参数
- 设置 User-Agent 和请求头模拟真实浏览器
- 实现随机延迟避免被识别为爬虫

#### 3.2 HTML 解析器 (html-parser.ts)
- 实现搜索结果页面解析
- 实现试验详情页面解析
- 提取关键字段信息：
  - 注册号、标题、研究类型、注册日期、机构等

#### 3.3 搜索服务 (search.ts)
- 实现关键词搜索功能
- 支持时间范围筛选
- 集成 Node-Cache 缓存机制（5分钟缓存）
- 处理 ChiCTR 搜索 URL 参数

#### 3.4 详情服务 (detail.ts)
- 根据注册号查询试验详情
- 集成 Node-Cache 缓存机制（10分钟缓存）
- 处理页面未找到等异常情况

#### 3.5 MCP 服务入口 (index.ts)
- 实现 MCP 协议工具定义：
  - search_trials: 搜索临床试验
  - get_trial_detail: 获取试验详情
  - get_cache_stats: 获取缓存统计信息
  - clear_cache: 清除缓存数据
- 处理 STDIO 通信协议

## 测试和修复过程

### 1. 初期测试问题
**问题**: 使用 `@modelcontextprotocol/inspector` 测试时，搜索返回空结果 []

**原因分析**: 
- 搜索 URL 格式不正确，使用了 `.aspx` 而不是 `.html`
- 缺少必要的查询参数 `btngo=btn`
- 缺少浏览器请求头模拟

**修复措施**:
- 修正 URL 格式为 `https://www.chictr.org.cn/searchproj.html`
- 添加完整的查询参数
- 配置完整的浏览器请求头：
  - Accept
  - Accept-Language
  - User-Agent 等

### 2. MCP Inspector 兼容性问题
**问题**: MCP Inspector 无法正确解析服务器响应

**原因分析**:
- 服务器启动时输出非 JSON 文本干扰 MCP 协议通信
- 缓存命中/未命中等调试信息直接输出到 stdout

**修复措施**:
- 移除所有 `console.log` 调试输出
- 确保只有标准的 MCP JSON-RPC 响应通过 stdout 输出

### 3. 缓存机制优化
**问题**: 缓存键设计不合理可能导致冲突

**优化措施**:
- 搜索缓存键：`search_${keyword}_${months}_${maxResults}`
- 详情缓存键：`detail_${registrationNumber}`
- 设置合理的缓存过期时间：
  - 搜索结果：5分钟
  - 详情信息：10分钟

## 性能优化

### 1. 缓存机制
- 实现两级缓存：搜索缓存和详情缓存
- 添加缓存统计功能，可监控命中率
- 提供缓存清除功能

### 2. 浏览器自动化优化
- 配置合理的浏览器参数避免被识别为爬虫
- 实现随机延迟模拟人类行为
- 复用浏览器实例减少资源消耗

## 发布过程

### 1. 包配置完善
- 完善 package.json 元数据信息
- 配置 bin 字段支持 CLI 命令行使用
- 添加关键词和描述信息
- 配置 postinstall 脚本自动安装 Chromium 浏览器

### 2. 版本发布历史

#### v1.0.0 (初始版本)
- 基础搜索和详情查询功能
- MCP 协议支持
- 缓存机制

#### v1.1.0 (分页和优化)
- ✅ 修复分页功能，支持多页结果获取
- ✅ 优化验证码检测，提供友好错误提示
- ✅ 增加请求延迟（5-10秒/页 + 3-6秒页间延迟）
- ✅ 支持代理配置（HTTP_PROXY/HTTPS_PROXY）
- ✅ 修改为 headless 模式，适配 npx 和服务器环境
- ✅ 默认 max_results 从 10 改为 50

#### v1.1.1 (版本号修复)
- ✅ 修正 MCP 服务器显示的版本号

#### v1.2.0 (多维度搜索)
- ✅ 新增按注册号搜索（registration_number 参数）
- ✅ 新增按年份搜索（year 参数，默认当前年份）
- ✅ 移除 months 参数，改用 year
- ✅ 所有搜索参数改为可选
- ✅ 添加 project_id 字段到搜索结果
- ✅ 实现项目ID缓存映射机制
- ✅ 修复详情查询 400 错误（使用正确的 project_id）
- ✅ 默认 max_results 改为 20

#### v1.2.1 (文档更新)
- ✅ 更新 README，添加多维度搜索示例
- ✅ 添加版本升级指南
- ✅ 提供 Cherrystudio 缓存清除方案
- ✅ 更新开发文档（dev_log.md, plan.md, tasks.md）
- ✅ 添加测试文件到 .gitignore
- ✅ 完善 Git 提交信息和版本管理

## 最终功能验证
- ✅ 工具列表获取成功
- ✅ 搜索功能正常工作，返回 KRAS G12D 相关试验
- ✅ 详情查询功能正常工作
- ✅ 缓存机制正常工作
- ✅ MCP Inspector 兼容性测试通过
- ✅ npm 包发布成功

## 技术要点总结

1. **反爬虫处理**: 使用 Playwright 浏览器自动化 + 真实请求头模拟
2. **MCP 协议**: 严格遵循 JSON-RPC 2.0 标准，避免非 JSON 输出
3. **缓存优化**: 合理的缓存键设计和过期策略
4. **错误处理**: 完善的异常处理和错误信息返回
5. **模块化设计**: 清晰的架构分离，便于维护和扩展