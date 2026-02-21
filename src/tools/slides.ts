import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google, type slides_v1 } from "googleapis";
import { z } from "zod";
import { createAuthClient, getDefaultUserEmail } from "../auth.js";
import { formatFileSize } from "../utils.js";

// ── Helpers ─────────────────────────────────────────────────────────────

const EMU_PER_INCH = 914400;

function formatDimension(dim: slides_v1.Schema$Dimension | undefined): string {
  if (!dim?.magnitude || !dim.unit) return "?";
  if (dim.unit === "EMU") return `${(dim.magnitude / EMU_PER_INCH).toFixed(2)}in`;
  if (dim.unit === "PT") return `${dim.magnitude}pt`;
  return `${dim.magnitude} ${dim.unit}`;
}

/**
 * Extract plain text from a Slides TextContent (array of text runs).
 */
function extractTextFromTextContent(
  textContent: slides_v1.Schema$TextContent | undefined
): string {
  if (!textContent?.textElements) return "";

  const parts: string[] = [];
  for (const el of textContent.textElements) {
    if (el.textRun?.content) {
      parts.push(el.textRun.content);
    }
  }
  return parts.join("").trim();
}

/**
 * Extract table content as TSV (matches docs convention).
 */
function extractTextFromTable(
  table: slides_v1.Schema$Table | undefined
): string {
  if (!table?.tableRows) return "";

  const rows: string[] = [];
  for (const row of table.tableRows) {
    if (!row.tableCells) continue;
    const cells: string[] = [];
    for (const cell of row.tableCells) {
      cells.push(extractTextFromTextContent(cell.text));
    }
    rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

/**
 * Extract text from a single page element (shape, table, group, word art).
 */
function extractTextFromPageElement(
  element: slides_v1.Schema$PageElement
): string {
  if (element.shape) {
    const text = extractTextFromTextContent(element.shape.text);
    if (text) return text;
  }
  if (element.table) {
    const text = extractTextFromTable(element.table);
    if (text) return `[Table]\n${text}`;
  }
  if (element.elementGroup?.children) {
    const parts: string[] = [];
    for (const child of element.elementGroup.children) {
      const text = extractTextFromPageElement(child);
      if (text) parts.push(text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (element.wordArt?.renderedText) {
    return element.wordArt.renderedText;
  }
  return "";
}

/**
 * Extract speaker notes text from a slide.
 */
function extractSpeakerNotes(
  slide: slides_v1.Schema$Page
): string {
  const notesPage = slide.slideProperties?.notesPage;
  if (!notesPage?.pageElements) return "";

  for (const el of notesPage.pageElements) {
    if (el.shape?.placeholder?.type === "BODY") {
      const text = extractTextFromTextContent(el.shape.text);
      if (text) return text;
    }
  }
  return "";
}

/**
 * Build a one-line summary for a slide (title + subtitle + notes indicator).
 */
function extractSlideSummary(
  slide: slides_v1.Schema$Page,
  index: number
): string {
  let title = "";
  let subtitle = "";

  if (slide.pageElements) {
    for (const el of slide.pageElements) {
      const phType = el.shape?.placeholder?.type;
      if (phType === "TITLE" || phType === "CENTERED_TITLE") {
        title = extractTextFromTextContent(el.shape?.text) || title;
      } else if (phType === "SUBTITLE") {
        subtitle = extractTextFromTextContent(el.shape?.text) || subtitle;
      }
    }
  }

  const hasNotes = extractSpeakerNotes(slide).length > 0;
  let summary = `Slide ${index + 1} (ID: ${slide.objectId})`;
  if (title) summary += `: ${title}`;
  if (subtitle) summary += ` — ${subtitle}`;
  if (hasNotes) summary += ` [has notes]`;
  return summary;
}

// ── Tool Registration ───────────────────────────────────────────────────

export function registerSlidesTools(server: McpServer): void {
  // ── search_presentations ────────────────────────────────────────────
  server.tool(
    "search_presentations",
    "Search for Google Slides presentations in a user's Drive. " +
      "Automatically filters to presentation files. " +
      "Provide a query to search by name/content, or omit to list recent presentations. " +
      "Examples: \"name contains 'Q4'\", \"fullText contains 'roadmap'\"",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe("Email address of the user whose Drive to search (defaults to GW_USER_EMAIL)"),
      query: z
        .string()
        .optional()
        .describe("Optional Drive search query to further filter presentations (Drive API query syntax)"),
      maxResults: z
        .number()
        .min(1)
        .max(100)
        .default(10)
        .describe("Maximum number of presentations to return (default: 10)"),
    },
    async ({ userEmail, query, maxResults }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const drive = google.drive({ version: "v3", auth });

        const mimeFilter =
          "mimeType = 'application/vnd.google-apps.presentation'";
        const fullQuery = query
          ? `${mimeFilter} and (${query})`
          : mimeFilter;

        const response = await drive.files.list({
          q: fullQuery,
          fields:
            "files(id,name,mimeType,modifiedTime,size,owners,webViewLink,shared)",
          pageSize: maxResults,
          orderBy: "modifiedTime desc",
          spaces: "drive",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        const files = response.data.files || [];
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: query
                  ? `No presentations found for query: "${query}"`
                  : "No presentations found.",
              },
            ],
          };
        }

        const lines = files.map((file) => {
          const owner =
            file.owners && file.owners.length > 0
              ? file.owners[0].emailAddress || "unknown"
              : "unknown";
          return (
            `📊 ${file.name}\n` +
            `   ID: ${file.id}\n` +
            `   Modified: ${file.modifiedTime}\n` +
            `   Size: ${formatFileSize(file.size)}\n` +
            `   Owner: ${owner}\n` +
            `   Shared: ${file.shared ? "yes" : "no"}\n` +
            `   Link: ${file.webViewLink || "N/A"}`
          );
        });

        const header = query
          ? `Found ${files.length} presentation(s) for query: "${query}":`
          : `Found ${files.length} presentation(s):`;

        const text = `${header}\n\n${lines.join("\n\n")}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[search_presentations] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching presentations: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_presentation ────────────────────────────────────────────────
  server.tool(
    "get_presentation",
    "Get metadata and slide overview for a Google Slides presentation. " +
      "Returns the title, page size, and a summary of each slide (ID, title, subtitle, notes indicator). " +
      "Use search_presentations or search_drive_files first to find the presentation ID.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe("Email address of a user with access to the presentation (defaults to GW_USER_EMAIL)"),
      presentationId: z
        .string()
        .describe(
          "Google Slides presentation ID (from search results or the URL)"
        ),
    },
    async ({ userEmail, presentationId }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const slides = google.slides({ version: "v1", auth });

        const response = await slides.presentations.get({
          presentationId,
        });
        const presentation = response.data;

        const title = presentation.title || "(untitled)";
        const pageSize = presentation.pageSize;
        const width = formatDimension(pageSize?.width);
        const height = formatDimension(pageSize?.height);

        let text =
          `Presentation: ${title}\n` +
          `ID: ${presentationId}\n` +
          `Page size: ${width} x ${height}\n`;

        const slideList = presentation.slides || [];
        text += `Slides: ${slideList.length}\n\n`;

        if (slideList.length === 0) {
          text += "No slides found.";
        } else {
          for (let i = 0; i < slideList.length; i++) {
            text += extractSlideSummary(slideList[i], i) + "\n";
          }
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[get_presentation] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting presentation: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_slide ───────────────────────────────────────────────────────
  server.tool(
    "get_slide",
    "Get the full text content of a single slide from a Google Slides presentation. " +
      "Returns all text from shapes, tables (as TSV), and speaker notes. " +
      "Use get_presentation first to see slide IDs.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe("Email address of a user with access to the presentation (defaults to GW_USER_EMAIL)"),
      presentationId: z
        .string()
        .describe("Google Slides presentation ID"),
      slideId: z
        .string()
        .describe(
          "The object ID of the slide to read (from get_presentation results)"
        ),
    },
    async ({ userEmail, presentationId, slideId }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const slides = google.slides({ version: "v1", auth });

        const response = await slides.presentations.pages.get({
          presentationId,
          pageObjectId: slideId,
        });
        const slide = response.data;

        let text = `Slide: ${slideId}\n`;

        // Extract title/subtitle if present
        const elements = slide.pageElements || [];
        const contentParts: string[] = [];

        for (const el of elements) {
          const phType = el.shape?.placeholder?.type;
          const elText = extractTextFromPageElement(el);
          if (!elText) continue;

          if (phType === "TITLE" || phType === "CENTERED_TITLE") {
            text += `Title: ${elText}\n`;
          } else if (phType === "SUBTITLE") {
            text += `Subtitle: ${elText}\n`;
          } else {
            contentParts.push(elText);
          }
        }

        text += "\n";

        if (contentParts.length > 0) {
          text += "Content:\n" + contentParts.join("\n\n") + "\n";
        } else {
          text += "Content: (no text content)\n";
        }

        // Speaker notes
        const notes = extractSpeakerNotes(slide);
        if (notes) {
          text += `\nSpeaker Notes:\n${notes}\n`;
        }

        // Truncate if very large
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
        console.error(`[get_slide] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting slide: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
