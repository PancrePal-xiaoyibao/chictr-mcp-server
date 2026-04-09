# ChiCTR MCP Server 2.0 设计方案（修订版）

更新时间：2026-04-09（基于评估反馈修订）

## 1. 背景与问题

当前 1.x 版本在“二次访问”场景中容易触发站点风控（滑块/验证页），核心原因是访问策略架构不足，而非单点代码问题。

已识别的主要短板：

- 单 `browser + page` 长生命周期复用，风控画像易积累。
- 业务层直接 `page.goto`，缺少统一请求编排（限速/重试/熔断/会话轮换）。
- 验证检测逻辑较弱，仅依赖标题关键词。
- 仅内存缓存（NodeCache），重启后失效，重复请求增加触发概率。

---

## 2. 2.0 目标

1. 在不依赖“绕过机制”的前提下，提高稳定性与可恢复性。
2. 将请求治理从“业务代码内分散处理”升级为“统一编排层”。
3. 建立可观测、可降级、可人工介入（HITL）的访问体系。

---

## 3. 总体架构

### 3.1 Request Orchestrator（请求编排层）

统一接管外部访问，提供：

- 全局 + endpoint 级别 Token Bucket 限速
- 并发上限（建议 1~2）
- 指数退避 + 随机抖动
- 熔断器（连续失败/挑战后进入冷却）

### 3.2 Session Manager（会话治理）

- 从“单 page”升级为“Context 池化管理”
- 每个 context 设置 `maxRequests` 与 `TTL`
- 达到阈值自动回收，避免长期同指纹/同会话连续命中
- 支持 warmup 与 idle recycle

### 3.3 Challenge Detector + 状态机

状态流转建议：

`NORMAL -> SUSPECTED -> CHALLENGED -> COOLDOWN -> RECOVERY`

检测信号：

- 标题/URL/DOM 特征
- 异常跳转
- 连续空结果 + 请求成功率下降
- 连续导航失败模式

状态驱动动作：

- 降并发、拉长间隔
- 暂停当前会话
- 进入人工验证流程
- 优先返回缓存结果

### 3.4 HITL（人工验证通道）

新增 MCP 工具建议：

- `prepare_verification_session`
- `resume_after_verification`
- `get_access_state`

设计目标：在系统自动恢复失败时，允许人工介入完成验证后继续流程。

> 约束：HITL 仅用于“人工完成验证后恢复业务流程”，不作为自动对抗路径。

### 3.5 双层缓存

- L1：NodeCache（内存，低延迟）
- L2：SQLite（持久化，跨进程可用）

策略：

- 规范化 cache key
- stale-while-revalidate
- 挑战期间优先读缓存，避免继续触发风控

> 结论：**保持双层缓存不变**（L1+L2）。

### 3.6 可观测性

结构化日志字段建议：

- `request_id`
- `session_id`
- `state`
- `retry_count`
- `latency_ms`
- `challenge_signal`

运维工具建议：

- `get_runtime_metrics`
- `get_cache_stats_v2`
- `get_recent_failures`

---

## 4. 代码分层建议

建议目录结构：

- `src/runtime/session-manager.ts`
- `src/runtime/orchestrator.ts`
- `src/runtime/challenge-detector.ts`
- `src/runtime/circuit-breaker.ts`
- `src/runtime/cache-manager.ts`
- `src/services/search.ts`（仅保留业务解析）
- `src/services/detail.ts`（仅保留业务解析）

说明：

- `search/detail` 不再直接 `page.goto`，统一经 orchestrator 调度。

---

## 5. 分阶段实施计划

### Phase A（1~2天）

- 引入 Orchestrator
- 增加限速、重试、熔断
- 不改工具接口，保证外部兼容

### Phase B（1天）

- 引入 Session 池与生命周期回收
- 替换现有单 page 模式

### Phase C（1天）

- 完成 challenge 状态机
- 增加 HITL 工具

### Phase D（0.5天）

- 接入 SQLite 持久缓存
- 增加 metrics 与失败观测工具

---

## 6. MCP 工具与返回结构（补充）

### 6.1 `get_access_state`（新增）

返回结构（示例）：

```json
{
  "state": "COOLDOWN",
  "cooldown_remaining_ms": 384000,
  "last_transition_at": "2026-04-09T10:15:30.000Z",
  "recent_signals": [
    {"type": "TITLE", "confidence": 0.9, "details": "verification title matched"},
    {"type": "DOM", "confidence": 0.85, "details": "challenge component found"}
  ],
  "consecutive_failures": 3
}
```

字段说明：
- `state`: `NORMAL | SUSPECTED | CHALLENGED | COOLDOWN | RECOVERY`
- `cooldown_remaining_ms`: 非冷却态返回 `0`
- `recent_signals`: 最近一次检测窗口内的信号集合

### 6.2 `prepare_verification_session`（新增）

输入：
- `target_url`（可选，默认最近触发挑战的URL）
- `timeout_ms`（可选，默认 300000）

输出（示例）：

```json
{
  "verification_id": "verify_1744165630000",
  "session_id": "sess_abc123",
  "status": "pending_manual_verification",
  "expires_at": "2026-04-09T10:25:30.000Z"
}
```

### 6.3 `resume_after_verification`（新增）

输入：
- `verification_id`（必填）

输出（示例）：

```json
{
  "status": "recovered",
  "state": "RECOVERY",
  "session_id": "sess_abc123"
}
```

### 6.4 兼容性要求

- 现有 `search_trials` / `get_trial_detail` / `get_cache_stats` / `clear_cache` 保持兼容。
- 新增工具不改变旧工具字段定义。

---

## 7. 错误分类与重试策略（补充）

### 7.1 错误分类

- `NETWORK_ERROR`：超时、连接中断、DNS/代理波动
- `TARGET_5XX`：目标站点5xx
- `CHALLENGE_ERROR`：检测到验证页/挑战组件
- `PARSE_ERROR`：页面结构变更导致解析失败
- `INVALID_INPUT`：参数缺失/格式错误

### 7.2 重试规则

- `NETWORK_ERROR` / `TARGET_5XX`：指数退避重试（最多2~3次）
- `CHALLENGE_ERROR`：不立即重试，转状态机（`CHALLENGED/COOLDOWN`）
- `PARSE_ERROR`：不重试同请求，记录失败样本
- `INVALID_INPUT`：直接返回

### 7.3 返回规范

MCP错误文本统一含以下字段（JSON字符串）：
- `code`
- `message`
- `retryable`（布尔）
- `state`（可选，挑战相关场景必填）

---

## 8. 验收标准（建议）

1. 重复查询（同关键词/同注册号）命中率显著提升。
2. 在挑战触发时系统进入降级与冷却，不出现请求风暴。
3. 发生挑战后可通过 HITL 恢复，不需重启服务。
4. 关键运行指标可通过 MCP 工具查询并可复盘。

---

## 9. 风险与注意事项

- 不将“自动化绕过验证”作为主路径，避免不可控波动。
- 控制并发与请求频率，优先稳定可持续。
- 对错误分类（网络/目标站/挑战/解析）进行明确区分，避免误重试。
- 将“滑块自动处理/第三方解题服务”标记为可选实验能力，默认关闭。

---

## 10. 代码评审前置检查（补充）

实现时需先修复/规避以下常见问题：

1. 异步遗漏：`page.title()` 等异步调用必须 `await`。
2. 指标闭环：L1/L2 的 hit/miss 必须完整计数，避免命中率失真。
3. 依赖完整性：如使用 `CircularBuffer`，必须提供实现或替代结构。
4. 资源释放：`prepare_verification_session` 超时后必须回收 session/context。

---

## 11. 发布与交付方式（新增）

### 11.1 交付原则

- 以 **npm 全打包发布** 为最终交付方式（`npx -y chictr-mcp-server@latest` 可直接使用）。
- 不要求用户本地源码部署，不依赖本地额外服务启动脚本。

### 11.2 包发布要求

- `package.json` 中 `bin` 保持 `chictr-mcp-server` 命令入口。
- `npm run build` 产物统一到 `dist/`，随包发布。
- 发布前执行最小验收：工具可列出、搜索可用、缓存工具可用、状态工具可用。

### 11.3 MCP JSON 配置（精简）

推荐最简 STDIO 配置：

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

可选（全局安装后更短）：

```json
{
  "mcpServers": {
    "chictr": {
      "command": "chictr-mcp-server"
    }
  }
}
```
