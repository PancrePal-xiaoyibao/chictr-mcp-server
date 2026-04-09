#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BrowserManager } from "./browser.js";
import { searchTrials, getSearchCacheStats, clearSearchCache, getSearchCacheStatsV2 } from "./services/search.js";
import { getTrialDetail, getDetailCacheStats, clearDetailCache } from "./services/detail.js";
import { RequestOrchestrator } from "./runtime/orchestrator.js";
import { toMcpErrorText } from "./runtime/errors.js";
import { ChallengeDetector } from "./runtime/challenge-detector.js";

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
          description: "注册题目关键词，如 'KRAS G12C'、'胰腺癌' 等（可选）",
        },
        registration_number: {
          type: "string",
          description: "临床试验注册号，如 'ChiCTR2500111173'（可选）",
        },
        year: {
          type: "number",
          description: "注册年份，如 2024、2025，默认为当前年份（可选）",
        },
        max_results: {
          type: "number",
          description: "最大返回结果数，默认20",
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
    version: "1.2.1",
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
    // 确保浏览器已初始化
    if (!browserManager) {
      browserManager = new BrowserManager();
      await browserManager.initialize();
    }

    switch (name) {
      case "search_trials": {
        const keyword = (args?.keyword as string) || undefined;
        const registrationNumber = (args?.registration_number as string) || undefined;
        const year = (args?.year as number) || undefined;
        const maxResults = (args?.max_results as number) || 20;

        const results = await searchTrials(
          browserManager,
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
        const registrationNumber = (args?.registration_number as string) || "";

        if (!registrationNumber) {
          throw new Error("registration_number 参数是必需的");
        }

        const detail = await getTrialDetail(
          browserManager,
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

  // 当前版本仅支持 stdio 传输方式
  const transport = new StdioServerTransport();
  // console.log(`ChiCTR MCP Server started with ${transportType} transport on port ${port}`);

  await server.connect(transport);

  // 优雅关闭
  process.on("SIGINT", async () => {
    if (browserManager) {
      await browserManager.close();
    }
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    if (browserManager) {
      await browserManager.close();
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("服务器启动失败:", error);
  process.exit(1);
});
