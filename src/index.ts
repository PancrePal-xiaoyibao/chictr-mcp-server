#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BrowserManager } from "./browser.js";
import { searchTrials, getSearchCacheStats, clearSearchCache, getSearchCacheStatsV2, getProjectIdByRegistrationNumber } from "./services/search.js";
import { getTrialDetail, getDetailCacheStats, clearDetailCache } from "./services/detail.js";
import { RequestOrchestrator } from "./runtime/orchestrator.js";
import { toMcpErrorText } from "./runtime/errors.js";
import { ChallengeDetector } from "./runtime/challenge-detector.js";
import {
  pingSidecar,
  isSidecarEnabled,
  searchTrialsViaSidecar,
  getTrialDetailViaSidecar,
} from "./runtime/sidecar-client.js";
import { validateRegistrationNumber, validateSearchInput } from "./runtime/input-validation.js";
import { closeGlobalCacheManager } from "./runtime/cache-singleton.js";
import { getEnvReport, formatEnvReport } from "./runtime/env-probe.js";

// 定义工具
const TOOLS: Tool[] = [
  {
    name: "search_trials",
    description: "搜索ChiCTR临床试验。支持按标题关键词、注册号、年份进行搜索，返回试验列表。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          maxLength: 200,
          description: "注册题目关键词，如 'KRAS G12C'、'胰腺癌' 等（可选）",
        },
        registration_number: {
          type: "string",
          pattern: "^ChiCTR\\d{8,}$",
          maxLength: 32,
          description: "临床试验注册号，如 'ChiCTR2500111173'（可选）",
        },
        year: {
          type: "integer",
          minimum: 2000,
          description: "注册年份，最大为当前年份加一年（可选）",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "最大返回结果数，默认20，最大100",
          default: 20,
        },
      },
      required: [],
    },
  },
  {
    name: "get_trial_detail",
    description: "根据注册号查询临床试验的完整详细信息",
    inputSchema: {
      type: "object",
      properties: {
        registration_number: {
          type: "string",
          description: "临床试验注册号，如 'ChiCTR2400084905'",
        },
      },
      required: ["registration_number"],
    },
  },
  {
    name: "get_cache_stats",
    description: "获取缓存统计信息，包括搜索缓存和详情缓存的命中率等",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "clear_cache",
    description: "清除所有缓存数据",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_cache_stats_v2",
    description: "获取双层缓存统计（L1内存 + L2 SQLite）",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_runtime_metrics",
    description: "获取运行时编排指标（请求总数、重试次数、挑战次数等）",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_access_state",
    description: "获取访问状态机信息（NORMAL/SUSPECTED/CHALLENGED/COOLDOWN/RECOVERY）",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "check_environment",
    description:
      "检查本机运行环境（Python 虚拟环境、依赖包、浏览器内核、sidecar 是否在线），" +
      "并在缺失时给出修复建议。只读操作，不会下载或修改任何文件。",
    inputSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          description: "忽略缓存，强制重新探测（默认使用 30 秒缓存）",
          default: false,
        },
      },
    },
  },
  {
    name: "prepare_verification_session",
    description: "创建人工验证会话（用于挑战后人工恢复流程）",
    inputSchema: {
      type: "object",
      properties: {
        target_url: {
          type: "string",
          description: "目标URL（可选）",
        },
        timeout_ms: {
          type: "number",
          description: "会话超时时间，默认300000毫秒",
          default: 300000,
        },
      },
      required: [],
    },
  },
  {
    name: "resume_after_verification",
    description: "人工验证完成后恢复访问状态",
    inputSchema: {
      type: "object",
      properties: {
        verification_id: {
          type: "string",
          description: "prepare_verification_session返回的verification_id",
        },
      },
      required: ["verification_id"],
    },
  },
];

// 创建服务器
const server = new Server(
  {
    name: "chictr-mcp-server",
    version: "2.0.2",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 浏览器管理器
let browserManager: BrowserManager | null = null;
const orchestrator = RequestOrchestrator.createDefault();
const challengeDetector = new ChallengeDetector(
  Number(process.env.CHALLENGE_COOLDOWN_MS || 10 * 60 * 1000)
);

const verificationSessions = new Map<
  string,
  { id: string; targetUrl: string; createdAt: number; expiresAt: number; status: "pending" | "recovered" | "expired" }
>();

function cleanupVerificationSessions(now: number = Date.now()) {
  for (const [id, session] of verificationSessions.entries()) {
    if (session.status === "pending" && now > session.expiresAt) {
      session.status = "expired";
      verificationSessions.set(id, session);
    }
  }
}

// 列出可用工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // 惰性初始化浏览器：sidecar 可用时搜索/详情全程不需要浏览器，
    // 因此绝不能在这里无条件启动 Chromium（否则 sidecar 的意义就没了）。
    // 只有真正会走 Playwright 的工具（或 sidecar 回退）才触发初始化。
    const ensureBrowser = async (): Promise<BrowserManager> => {
      if (!browserManager) {
        browserManager = new BrowserManager();
        await browserManager.initialize();
      }
      return browserManager;
    };

    switch (name) {
      case "search_trials": {
        const { keyword, registrationNumber, year, maxResults } = validateSearchInput(
          args as Record<string, unknown> | undefined
        );

        // sidecar 优先：命中时完全不需要浏览器实例。
        if (isSidecarEnabled()) {
          const viaSidecar = await searchTrialsViaSidecar({
            keyword,
            registrationNumber,
            year,
            maxResults,
          });
          if (viaSidecar) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(viaSidecar.results, null, 2),
                },
              ],
            };
          }
        }

        const bm = await ensureBrowser();
        const results = await searchTrials(
          bm,
          orchestrator,
          challengeDetector,
          keyword,
          registrationNumber,
          year,
          maxResults
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case "get_trial_detail": {
        const registrationNumber = validateRegistrationNumber(args?.registration_number);

        // sidecar 优先：需要先把注册号解析成 project_id。
        if (isSidecarEnabled()) {
          const cachedProjectId = getProjectIdByRegistrationNumber(registrationNumber);
          let projectId = cachedProjectId;

          if (!projectId) {
            const found = await searchTrialsViaSidecar({
              registrationNumber,
              maxResults: 1,
            });
            projectId = found?.results[0]?.project_id;
          }

          if (projectId) {
            const detail = await getTrialDetailViaSidecar(projectId, registrationNumber);
            if (detail) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(detail, null, 2),
                  },
                ],
              };
            }
          }
        }

        const bm = await ensureBrowser();
        const detail = await getTrialDetail(
          bm,
          orchestrator,
          challengeDetector,
          registrationNumber
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(detail, null, 2),
            },
          ],
        };
      }

      case "get_cache_stats": {
        const searchStats = getSearchCacheStats();
        const detailStats = getDetailCacheStats();
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                search_cache: searchStats,
                detail_cache: detailStats
              }, null, 2),
            },
          ],
        };
      }

      case "clear_cache": {
        clearSearchCache();
        clearDetailCache();
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ message: "所有缓存已清除" }, null, 2),
            },
          ],
        };
      }

      case "get_cache_stats_v2": {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(getSearchCacheStatsV2(), null, 2),
            },
          ],
        };
      }

      case "get_runtime_metrics": {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                orchestrator: orchestrator.getMetrics(),
                sessions: browserManager?.getSessionStats() || null,
                access: challengeDetector.getSnapshot(),
                sidecar: await pingSidecar(),
              }, null, 2),
            },
          ],
        };
      }

      case "get_access_state": {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(challengeDetector.getSnapshot(), null, 2),
            },
          ],
        };
      }

      case "check_environment": {
        const force = args?.refresh === true;
        const report = await getEnvReport(force);
        const payload = {
          ready: report.canRunBrowserless || report.sidecar.status === "ok",
          summary: report.summary,
          actions: report.actions,
          root: report.root,
          checks: {
            node: report.node,
            venv: report.venv,
            python_deps: report.pythonDeps,
            browser: report.browser,
            sidecar_script: report.sidecarScript,
            sidecar: report.sidecar,
            playwright_fallback: report.playwrightBrowser,
          },
        };
        // 同一份结果以三种形态给出，让不同调用方各取所需：
        //   1) 可读文本 —— AI 直接转述给用户
        //   2) JSON 文本块 —— 只解析 content[*].text 的调用方也能拿到
        //   3) 尾随的内嵌 JSON —— 兼容"文本 + ---结构化结果"的历史读法
        // 这个是唯一需要被程序化分支（ready / actions）的工具，值得多给一种形态。
        return {
          content: [
            { type: "text", text: formatEnvReport(report) },
            { type: "text", text: JSON.stringify(payload, null, 2) },
          ],
        };
      }

      case "prepare_verification_session": {
        cleanupVerificationSessions();
        const targetUrl =
          (args?.target_url as string) || "https://www.chictr.org.cn/searchproj.html";
        const timeoutMs = Number(args?.timeout_ms || 300000);
        const clampedTimeout = Math.min(Math.max(timeoutMs, 60000), 10 * 60 * 1000);
        const now = Date.now();
        const id = `verify_${now}_${Math.random().toString(36).slice(2, 8)}`;
        verificationSessions.set(id, {
          id,
          targetUrl,
          createdAt: now,
          expiresAt: now + clampedTimeout,
          status: "pending",
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  verification_id: id,
                  status: "pending_manual_verification",
                  target_url: targetUrl,
                  expires_at: new Date(now + clampedTimeout).toISOString(),
                  note: "请在本地浏览器完成验证后调用 resume_after_verification。",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "resume_after_verification": {
        cleanupVerificationSessions();
        const verificationId = (args?.verification_id as string) || "";
        const session = verificationSessions.get(verificationId);
        if (!session) {
          throw new Error("verification_id 无效或不存在");
        }
        if (session.status !== "pending") {
          throw new Error(`verification_id 状态不可恢复: ${session.status}`);
        }
        if (Date.now() > session.expiresAt) {
          session.status = "expired";
          verificationSessions.set(verificationId, session);
          throw new Error("verification_id 已过期，请重新创建");
        }

        session.status = "recovered";
        verificationSessions.set(verificationId, session);
        challengeDetector.forceRecovery();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "recovered",
                  verification_id: verificationId,
                  access_state: challengeDetector.getSnapshot(),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`未知的工具: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: toMcpErrorText(errorMessage),
        },
      ],
      isError: true,
    };
  }
});

// 启动服务器
async function main() {
  // 解析命令行参数
  const args = process.argv.slice(2);
  const transportType = args.includes('--transport=http') ? 'http' : 
                       args.includes('--transport=sse') ? 'sse' : 'stdio';
  const port = parseInt(args.find(arg => arg.startsWith('--port='))?.split('=')[1] || '3000');

  // 启动时做一次轻量环境体检（带缓存，几百毫秒内完成）。
  // 目的不是拦住启动，而是把「缺依赖」这个事实**主动**告知用户——否则用户
  // 只有在第一次调用工具失败时才发现环境没装好。
  // 注意：只写 stderr，stdout 是 MCP 协议通道，绝不能污染。
  void reportEnvironmentOnBoot();

  // 当前版本仅支持 stdio 传输方式
  const transport = new StdioServerTransport();
  // console.log(`ChiCTR MCP Server started with ${transportType} transport on port ${port}`);

  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (browserManager) await browserManager.close();
      closeGlobalCacheManager();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

/** 启动体检：把结论写到 stderr，绝不阻塞或中断启动。 */
async function reportEnvironmentOnBoot(): Promise<void> {
  try {
    const report = await getEnvReport();
    const problems: string[] = [];

    if (report.node.status !== "ok") problems.push(report.node.detail);
    if (report.venv.status === "missing") problems.push("未找到 Python 虚拟环境");
    else if (report.pythonDeps.status === "missing") problems.push("缺少 Python 依赖");

    if (problems.length > 0) {
      console.error(
        `[chictr-mcp-server] 环境未就绪：${problems.join("；")}\n` +
          `                  运行 "chictr-mcp-server setup" 自动修复，` +
          `或调用环境诊断工具查看详情。`
      );
    } else if (isSidecarEnabled() && report.sidecar.status !== "ok") {
      console.error(
        `[chictr-mcp-server] sidecar 不可达（${report.sidecar.detail}）。` +
          `将回退到 Playwright 路径；如需启动运行 "chictr-mcp-server sidecar"。`
      );
    }
  } catch {
    // 体检本身失败绝不能影响服务启动。
  }
}

main().catch((error) => {
  console.error("服务器启动失败:", error);
  process.exit(1);
});
