# Changelog

## v3.0.0 (2026-04-10)

引入 Python sidecar 数据通道与环境自举能力。真正解决阿里盾 405 的是 Scrapling 捆绑的
curl_cffi（TLS 指纹伪装）与 patchright（Chromium 反检测补丁），Scrapling 只是把它们包成
易用的 API —— 因此本版的能力扩展也伴随着依赖体积的显著增长（约 1GB，含 Python 运行时与
浏览器内核），配套提供探测/自举/体检三层工具来管理这一成本。

- 新增 Python sidecar 通道（`sidecar/chictr_sidecar.py`），随 npm 包分发：
  - 过一次阿里盾挑战取得 cookie，之后全程纯 HTTP；搜索 ~1.5s/页、详情 ~2s
  - 顺带修掉旧路径每页 5–10s 的人为随机延时
- 新增环境探测层 `src/runtime/env-probe.ts`：只读体检（Node / venv / Python 版本 / 依赖 /
  浏览器内核 / sidecar），带 30s 缓存与并发合并，绝不抛异常
- 新增环境自举层 `src/runtime/bootstrap.ts`：幂等创建 venv、装依赖（镜像自动回退）、
  按需安装浏览器内核（需显式授权）
- 新增 CLI `src/cli/setup-cli.ts`：`doctor` / `setup` / `clean` / `sidecar` / `postinstall`
  （退出码 0 就绪、1 需用户动作、2 自举失败）
- 新增 MCP 工具 `check_environment`（工具总数 9 → 10）
- 修复浏览器惰性初始化：原先任何工具调用都会先拉起 Chromium，抵消 sidecar 的全部收益
- 修复 `MIN_PYTHON` 从未生效：低版本 Python 会被误判为环境就绪
- 修复打包缺陷：不再把编译出的测试文件与 Python 字节码缓存打进发布包
- 启动时在 stderr 输出环境体检结论（仅未就绪时告警，不阻塞启动）

## v2.0.2 (2026-04-09)

- 修复详情查询空对象缓存命中问题：空详情缓存自动失效并触发重查
- 增强详情链路稳定性：优先保证可获取到有效内容

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
