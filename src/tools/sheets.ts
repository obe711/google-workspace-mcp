import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google } from "googleapis";
import { z } from "zod";
import { createAuthClient } from "../auth.js";

export function registerSheetsTools(server: McpServer): void {
  // ── get_spreadsheet ───────────────────────────────────────────────
  server.tool(
    "get_spreadsheet",
    "Get metadata about a Google Spreadsheet including its title and list of sheets " +
      "(tab names, row counts, column counts). Use search_drive_files first to find the spreadsheet ID.",
    {
      userEmail: z
        .string()
        .email()
        .describe("Email address of a user with access to the spreadsheet"),
      spreadsheetId: z
        .string()
        .describe("Google Spreadsheet ID (from search_drive_files results or the URL)"),
    },
    async ({ userEmail, spreadsheetId }) => {
      try {
        const auth = createAuthClient(userEmail);
        const sheets = google.sheets({ version: "v4", auth });

        const response = await sheets.spreadsheets.get({
          spreadsheetId,
          fields:
            "spreadsheetId,properties.title,properties.locale,properties.timeZone,sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount)))",
        });

        const { properties, sheets: sheetList } = response.data;
        const title = properties?.title || "(untitled)";

        let text = `Spreadsheet: ${title}\nID: ${spreadsheetId}\n`;
        if (properties?.locale) text += `Locale: ${properties.locale}\n`;
        if (properties?.timeZone) text += `Time zone: ${properties.timeZone}\n`;

        if (sheetList && sheetList.length > 0) {
          text += `\nSheets (${sheetList.length}):\n`;
          for (const sheet of sheetList) {
            const p = sheet.properties;
            if (!p) continue;
            const rows = p.gridProperties?.rowCount ?? "?";
            const cols = p.gridProperties?.columnCount ?? "?";
            text += `- [${p.index}] "${p.title}" (${p.sheetType}, ${rows} rows x ${cols} cols)\n`;
          }
        } else {
          text += "\nNo sheets found.\n";
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[get_spreadsheet] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting spreadsheet: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── read_sheet_range ──────────────────────────────────────────────
  server.tool(
    "read_sheet_range",
    "Read cell values from a Google Spreadsheet range. " +
      "Use A1 notation for the range, e.g. 'Sheet1!A1:D10', 'Sheet1!A:A', or just 'Sheet1' for the entire sheet. " +
      "Use get_spreadsheet first to see available sheet names.",
    {
      userEmail: z
        .string()
        .email()
        .describe("Email address of a user with access to the spreadsheet"),
      spreadsheetId: z
        .string()
        .describe("Google Spreadsheet ID"),
      range: z
        .string()
        .describe(
          "A1 notation range (e.g. 'Sheet1!A1:D10', 'Sheet1', 'Sheet1!A:C')"
        ),
      includeFormulas: z
        .boolean()
        .default(false)
        .describe(
          "If true, return formulas instead of computed values (default: false)"
        ),
    },
    async ({ userEmail, spreadsheetId, range, includeFormulas }) => {
      try {
        const auth = createAuthClient(userEmail);
        const sheets = google.sheets({ version: "v4", auth });

        const response = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
          valueRenderOption: includeFormulas ? "FORMULA" : "FORMATTED_VALUE",
          dateTimeRenderOption: "FORMATTED_STRING",
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No data found in range: ${range}`,
              },
            ],
          };
        }

        // Format as TSV for readability
        const tsv = rows
          .map((row) => row.map((cell) => String(cell ?? "")).join("\t"))
          .join("\n");

        const text =
          `Range: ${response.data.range}\n` +
          `Rows: ${rows.length}\n\n` +
          tsv;

        // Truncate if very large
        const maxLen = 100000;
        if (text.length > maxLen) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  text.slice(0, maxLen) +
                  `\n\n[... truncated at ${maxLen.toLocaleString()} characters]`,
              },
            ],
          };
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[read_sheet_range] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading sheet range: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── batch_read_sheet_ranges ───────────────────────────────────────
  server.tool(
    "batch_read_sheet_ranges",
    "Read multiple ranges from a Google Spreadsheet in a single request. " +
      "Useful for reading data from multiple sheets or non-contiguous ranges efficiently.",
    {
      userEmail: z
        .string()
        .email()
        .describe("Email address of a user with access to the spreadsheet"),
      spreadsheetId: z
        .string()
        .describe("Google Spreadsheet ID"),
      ranges: z
        .array(z.string())
        .min(1)
        .describe(
          "Array of A1 notation ranges (e.g. ['Sheet1!A1:D10', 'Sheet2!A1:B5'])"
        ),
    },
    async ({ userEmail, spreadsheetId, ranges }) => {
      try {
        const auth = createAuthClient(userEmail);
        const sheets = google.sheets({ version: "v4", auth });

        const response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId,
          ranges,
          valueRenderOption: "FORMATTED_VALUE",
          dateTimeRenderOption: "FORMATTED_STRING",
        });

        const valueRanges = response.data.valueRanges || [];
        if (valueRanges.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No data found in any of the requested ranges." },
            ],
          };
        }

        const sections: string[] = [];
        for (const vr of valueRanges) {
          const rows = vr.values;
          if (!rows || rows.length === 0) {
            sections.push(`--- ${vr.range} ---\n(empty)`);
            continue;
          }
          const tsv = rows
            .map((row) => row.map((cell) => String(cell ?? "")).join("\t"))
            .join("\n");
          sections.push(`--- ${vr.range} (${rows.length} rows) ---\n${tsv}`);
        }

        let text = sections.join("\n\n");
        const maxLen = 100000;
        if (text.length > maxLen) {
          text =
            text.slice(0, maxLen) +
            `\n\n[... truncated at ${maxLen.toLocaleString()} characters]`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[batch_read_sheet_ranges] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading sheet ranges: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
