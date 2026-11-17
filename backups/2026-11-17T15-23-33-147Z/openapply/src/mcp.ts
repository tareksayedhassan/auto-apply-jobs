#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { registerTools, INSTRUCTIONS } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({ name: "openapply", version }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}

const server = createServer();
await server.connect(new StdioServerTransport());

const shutdown = async () => {
  try { (await import("./apply/engine.js")).closeBrowser(); } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
