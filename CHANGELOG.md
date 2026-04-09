# Changelog

## v2.0.1 (2026-04-09)

- 修复 Cherry Studio / GUI 启动场景下缓存目录 `ENOENT` 问题
- 默认缓存路径改为 `~/.chictr/cache/chictr_cache.db`
- 新增路径创建失败时的 `/tmp/chictr/cache/chictr_cache.db` 兜底

## v2.0.0 (2026-04-09)

- 新增请求编排层（限速、重试、熔断）
- 新增 Session 池化与生命周期回收
- 新增挑战状态机与访问恢复工具：
  - `get_access_state`
  - `prepare_verification_session`
  - `resume_after_verification`
- 新增双层缓存（L1 NodeCache + L2 SQLite）与 `get_cache_stats_v2`
- 统一运行时指标输出：`get_runtime_metrics`
- 优化 npm 全打包交付路径与最简 MCP JSON 配置
