#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BrowserManager } from "./browser.js";
import { searchTrials, getSearchCacheStats, clearSearchCache } from "./services/search.js";
import { getTrialDetail, getDetailCacheStats, clearDetailCache } from "./services/detail.js";

// 定义工具
const TOOLS: Tool[] = [
  {
    name: "search_trials",
    description: "搜索ChiCTR临床试验。支持关键词搜索和时间范围筛选，返回试验列表。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "搜索关键词，如 'KRAS G12C'、'胰腺癌' 等",
        },
        months: {
          type: "number",
          description: "时间范围（月），默认6个月。查询过去N个月的试验",
          default: 6,
        },
        max_results: {
          type: "number",
          description: "最大返回结果数，默认10",
          default: 10,
        },
      },
      required: ["keyword"],
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
];

// 创建服务器
const server = new Server(
  {
    name: "chictr-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 浏览器管理器
let browserManager: BrowserManager | null = null;

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
        const keyword = (args?.keyword as string) || "";
        const months = (args?.months as number) || 6;
        const maxResults = (args?.max_results as number) || 10;

        if (!keyword) {
          throw new Error("keyword 参数是必需的");
        }

        const results = await searchTrials(
          browserManager,
          keyword,
          months,
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

        const detail = await getTrialDetail(browserManager, registrationNumber);

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

      default:
        throw new Error(`未知的工具: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: errorMessage }, null, 2),
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
