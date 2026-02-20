import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google, type docs_v1 } from "googleapis";
import { z } from "zod";
import { createAuthClient, getDefaultUserEmail } from "../auth.js";

/**
 * Recursively extract plain text from a Google Docs document body.
 * Walks structural elements (paragraphs, tables, lists) and concatenates text runs.
 */
function extractDocumentText(
  body: docs_v1.Schema$Body | undefined
): string {
  if (!body?.content) return "";

  const parts: string[] = [];

  for (const element of body.content) {
    if (element.paragraph) {
      const paraText = extractParagraphText(element.paragraph);
      parts.push(paraText);
    } else if (element.table) {
      parts.push(extractTableText(element.table));
    } else if (element.sectionBreak) {
      parts.push("\n");
    }
  }

  return parts.join("");
}

function extractParagraphText(
  paragraph: docs_v1.Schema$Paragraph
): string {
  if (!paragraph.elements) return "";

  let text = "";
  for (const element of paragraph.elements) {
    if (element.textRun?.content) {
      text += element.textRun.content;
    } else if (element.inlineObjectElement) {
      text += "[image]";
    } else if (element.horizontalRule) {
      text += "\n---\n";
    }
  }
  return text;
}

function extractTableText(table: docs_v1.Schema$Table): string {
  if (!table.tableRows) return "";

  const rows: string[] = [];
  for (const row of table.tableRows) {
    if (!row.tableCells) continue;
    const cells: string[] = [];
    for (const cell of row.tableCells) {
      // Each cell has its own content array
      const cellParts: string[] = [];
      if (cell.content) {
        for (const element of cell.content) {
          if (element.paragraph) {
            cellParts.push(extractParagraphText(element.paragraph).trim());
          }
        }
      }
      cells.push(cellParts.join(" "));
    }
    rows.push(cells.join("\t"));
  }
  return rows.join("\n") + "\n";
}

/**
 * Extract document heading structure for an outline view.
 */
function extractHeadings(
  body: docs_v1.Schema$Body | undefined
): Array<{ level: number; text: string }> {
  if (!body?.content) return [];

  const headings: Array<{ level: number; text: string }> = [];

  for (const element of body.content) {
    if (!element.paragraph) continue;
    const style = element.paragraph.paragraphStyle?.namedStyleType;
    if (!style || !style.startsWith("HEADING_")) continue;

    const level = parseInt(style.replace("HEADING_", ""), 10);
    if (isNaN(level)) continue;

    const text = extractParagraphText(element.paragraph).trim();
    if (text) {
      headings.push({ level, text });
    }
  }

  return headings;
}

export function registerDocsTools(server: McpServer): void {
  // ── get_document ──────────────────────────────────────────────────
  server.tool(
    "get_document",
    "Get the full text content of a Google Doc. " +
      "Returns the document title and body text with tables rendered as TSV. " +
      "Use search_drive_files first to find the document ID.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe("Email address of a user with access to the document (defaults to GW_USER_EMAIL)"),
      documentId: z
        .string()
        .describe(
          "Google Docs document ID (from search_drive_files results or the URL)"
        ),
    },
    async ({ userEmail, documentId }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const docs = google.docs({ version: "v1", auth });

        const response = await docs.documents.get({ documentId });
        const doc = response.data;

        const title = doc.title || "(untitled)";
        const bodyText = extractDocumentText(doc.body);

        let text = `Document: ${title}\nID: ${documentId}\n\n${bodyText}`;

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
        console.error(`[get_document] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting document: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_document_structure ────────────────────────────────────────
  server.tool(
    "get_document_structure",
    "Get the heading structure (outline) of a Google Doc. " +
      "Returns the document title and a list of headings with their levels. " +
      "Useful for understanding document organization before reading the full content.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe("Email address of a user with access to the document (defaults to GW_USER_EMAIL)"),
      documentId: z
        .string()
        .describe("Google Docs document ID"),
    },
    async ({ userEmail, documentId }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const docs = google.docs({ version: "v1", auth });

        const response = await docs.documents.get({ documentId });
        const doc = response.data;

        const title = doc.title || "(untitled)";
        const headings = extractHeadings(doc.body);

        let text = `Document: ${title}\nID: ${documentId}\n\n`;

        if (headings.length === 0) {
          text += "No headings found in this document.";
        } else {
          text += `Headings (${headings.length}):\n`;
          for (const h of headings) {
            const indent = "  ".repeat(h.level - 1);
            text += `${indent}${"#".repeat(h.level)} ${h.text}\n`;
          }
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[get_document_structure] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting document structure: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
