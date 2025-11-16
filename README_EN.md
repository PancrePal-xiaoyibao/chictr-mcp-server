# ChiCTR MCP Server

ChiCTR MCP Server is a Model Context Protocol (MCP) based clinical trial query service, specifically designed to query clinical trial information from the Chinese Clinical Trial Registry (ChiCTR).

[简体中文](./README.md) | English

## 🎯 Supported MCP Service Types

- **stdio**: Standard input/output communication (default)
- **http**: HTTP REST API service (planned)
- **sse**: Server-Sent Events real-time communication service (planned)

## 🌟 Key Features

- **MCP Protocol Compatible**: Fully supports Model Context Protocol standards
- **Smart Search**: Supports keyword search and time range filtering
- **Detailed Information**: Provides complete clinical trial details
- **High Performance**: Built-in intelligent caching mechanism to improve query speed
- **Anti-Crawler Handling**: Uses browser automation technology to handle website protection mechanisms

## 🚀 Quick Start

### Install Dependencies
```bash
npm install
```

### Build Project
```bash
npm run build
```

### Start Server

#### STDIO Mode (Default)
```bash
npm start
# or
node dist/index.js
```

#### HTTP Mode (Planned)
```bash
# node dist/index.js --transport=http --port=3000
```

#### SSE Mode (Planned)
```bash
# node dist/index.js --transport=sse --port=3000
```

## 📋 Available Tools

### search_trials
Search clinical trials
```json
{
  "name": "search_trials",
  "arguments": {
    "keyword": "KRAS G12D",
    "months": 6,
    "max_results": 10
  }
}
```

### get_trial_detail
Get trial details
```json
{
  "name": "get_trial_detail",
  "arguments": {
    "registration_number": "ChiCTR2500108082"
  }
}
```

### get_cache_stats
Get cache statistics
```json
{
  "name": "get_cache_stats",
  "arguments": {}
}
```

### clear_cache
Clear all cache
```json
{
  "name": "clear_cache",
  "arguments": {}
}
```

## 🛠️ CLI Command Line Tool

### Install CLI
```bash
npm install -g chictr-mcp-server
```

### Use CLI
```bash
# Global installation
npm install -g chictr-mcp-server

# Or use npx directly (recommended)
npx -y chictr-mcp-server

# Start STDIO service
chictr-mcp-server

# Or use npx
npx -y chictr-mcp-server

# Start with parameters (future version support)
# chictr-mcp-server --transport=http --port=3000
# chictr-mcp-server --transport=sse --port=3000
# chictr-mcp-server --help
```

## 🛠️ Technology Stack

- **TypeScript**: Type-safe JavaScript superset
- **Playwright**: Browser automation tool
- **Cheerio**: Server-side jQuery implementation
- **Node-Cache**: High-performance caching library
- **MCP SDK**: Official Model Context Protocol SDK

## 📡 MCP Configuration Guide

### MCP Client Configuration

#### Using npx (Recommended)
```json
{
  "mcpServers": {
    "chictr": {
      "command": "npx",
      "args": ["-y", "chictr-mcp-server"]
    }
  }
}
```

#### Using Local Installation
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

#### HTTP Mode Configuration (Planned)
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

#### SSE Mode Configuration (Planned)
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

## 🚀 MCP service testing

To test the MCP service, you can use the following command:

```bash
npx @modelcontextprotocol/inspector npx -y chictr-mcp-server
```

You may need to install first
```bash
npm install -g @modelcontextprotocol/inspector

```

## 📊 Performance Optimization

- **Intelligent Caching**: Search results cached for 5 minutes, detailed data cached for 10 minutes
- **Browser Automation**: Uses Playwright to simulate real browser behavior
- **Anti-Crawler Handling**: Built-in User-Agent and delay mechanisms

## 🧪 Usage Examples

### Search for KRAS G12D Related Trials
```bash
# Search for KRAS G12D related trials in the last 6 months
{
  "name": "search_trials",
  "arguments": {
    "keyword": "KRAS G12D",
    "months": 6,
    "max_results": 10
  }
}
```

### Get Specific Trial Details
```bash
# Get details for trial with registration number ChiCTR2500108082
{
  "name": "get_trial_detail",
  "arguments": {
    "registration_number": "ChiCTR2500108082"
  }
}
```

## 📈 Query Results Example

### Search Results
```json
{
  "results": [
    {
      "registration_number": "ChiCTR2500108082",
      "title": "A Single-arm Phase II Exploratory Study of Glutamine Combined with Oxaliplatin, Capecitabine (XELOX) and Bevacizumab as First-line Treatment for KRAS G12D Mutation-positive Advanced Colorectal Cancer",
      "study_type": "Interventional Study",
      "registration_date": "2025/08/25",
      "institution": "The Second Affiliated Hospital of Zhejiang University School of Medicine"
    }
  ]
}
```

## 🤝 Integration Methods

ChiCTR MCP Server currently supports STDIO communication method and can be easily integrated into any application that supports the MCP protocol:

### STDIO Mode (Default)
Communicates with clients through standard input/output, suitable for most MCP clients.

### HTTP Mode (Planned)
Communicates with clients through HTTP REST API, supporting cross-network access.
- Endpoint: `http://localhost:3000/mcp`
- Method: POST
- Content-Type: application/json

### SSE Mode (Planned)
Communicates with clients through Server-Sent Events, supporting real-time push.
- Endpoint: `http://localhost:3000/mcp`
- Event Type: `message`

## 🔧 Configuration

### TypeScript Configuration
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

### Cache Configuration
- Search results cache: 5 minutes (300 seconds)
- Detailed data cache: 10 minutes (600 seconds)

## 📄 License

MIT License

## 📞 Support

If you have any issues, please submit a GitHub Issue.

## 🙏 Acknowledgements

This project uses public data from the Chinese Clinical Trial Registry (ChiCTR). We thank ChiCTR for their contributions to medical research.