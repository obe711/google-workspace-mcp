import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGmailTools } from "./tools/gmail.js";
import { registerDriveTools } from "./tools/drive.js";
import { registerAdminTools } from "./tools/admin.js";
import { registerSheetsTools } from "./tools/sheets.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerCalendarTools } from "./tools/calendar.js";

const server = new McpServer({
  name: "google-workspace",
  version: "1.0.0",
});

// Register all tools
registerGmailTools(server);
registerDriveTools(server);
registerAdminTools(server);
registerSheetsTools(server);
registerDocsTools(server);
registerCalendarTools(server);

// Connect via stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("Google Workspace MCP server running on stdio");
