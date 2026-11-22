#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createKanbanerMcpServer } from "./mcp-server.ts";

await createKanbanerMcpServer().connect(new StdioServerTransport());
