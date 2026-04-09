# ChiCTR MCP 2.0 Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有查询链路加入统一请求编排（限速、重试、熔断）并保持 MCP 兼容。

**Architecture:** 新增 `runtime` 层（`orchestrator` + `circuit-breaker` + `errors`），由 `search/detail` 通过编排层执行页面访问；`index.ts` 统一实例化并注入。

**Tech Stack:** TypeScript, Playwright, MCP SDK, Node built-in test runner

---

### Task 1: 新增错误分类与熔断器基础模块

**Files:**
- Create: `src/runtime/errors.ts`
- Create: `src/runtime/circuit-breaker.ts`
- Test: `src/runtime/circuit-breaker.test.ts`

- [ ] Step 1: 先写熔断器测试（开路/半开/闭合）
- [ ] Step 2: 实现 `CircuitBreaker`
- [ ] Step 3: 实现 `AppErrorCode` 与 `classifyError`
- [ ] Step 4: 运行测试并确认通过

### Task 2: 新增请求编排器

**Files:**
- Create: `src/runtime/orchestrator.ts`
- Test: `src/runtime/orchestrator.test.ts`

- [ ] Step 1: 先写编排器测试（重试与挑战不重试）
- [ ] Step 2: 实现令牌桶与并发控制
- [ ] Step 3: 实现 `execute()` 与 metrics
- [ ] Step 4: 运行测试并确认通过

### Task 3: 接入业务服务

**Files:**
- Modify: `src/services/search.ts`
- Modify: `src/services/detail.ts`

- [ ] Step 1: 注入 `RequestOrchestrator`
- [ ] Step 2: 用 `orchestrator.execute` 包装 `page.goto` 链路
- [ ] Step 3: 统一错误抛出为可分类文本

### Task 4: 接入 MCP 入口与指标接口

**Files:**
- Modify: `src/index.ts`

- [ ] Step 1: 初始化全局 orchestrator
- [ ] Step 2: 更新工具调用参数传递
- [ ] Step 3: 新增 `get_runtime_metrics` 工具（不破坏旧工具）

### Task 5: 构建与回归

**Files:**
- Modify: `package.json`

- [ ] Step 1: 增加 `test` 脚本
- [ ] Step 2: 执行 `npm run build`
- [ ] Step 3: 执行 `npm test`
- [ ] Step 4: 记录变更摘要，等待你确认后进入 Phase B

