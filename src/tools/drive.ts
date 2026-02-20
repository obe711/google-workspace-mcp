import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google } from "googleapis";
import { z } from "zod";
import { createAuthClient } from "../auth.js";
import { truncate, formatFileSize } from "../utils.js";

/**
 * Map of Google Workspace native MIME types to their export format.
 */
const GOOGLE_DOC_EXPORT_MAP: Record<
  string,
  { exportMimeType: string; label: string }
> = {
  "application/vnd.google-apps.document": {
    exportMimeType: "text/plain",
    label: "Google Doc",
  },
  "application/vnd.google-apps.spreadsheet": {
    exportMimeType: "text/csv",
    label: "Google Sheet (first sheet only)",
  },
  "application/vnd.google-apps.presentation": {
    exportMimeType: "text/plain",
    label: "Google Slides",
  },
  "application/vnd.google-apps.drawing": {
    exportMimeType: "image/svg+xml",
    label: "Google Drawing",
  },
};

/**
 * MIME types that can be downloaded and displayed as text.
 */
const READABLE_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/xml",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "text/javascript",
  "text/css",
  "text/tab-separated-values",
  "application/x-yaml",
  "text/yaml",
]);

export function registerDriveTools(server: McpServer): void {
  // ── search_drive_files ────────────────────────────────────────────
  server.tool(
    "search_drive_files",
    "Search a user's Google Drive files using Drive query syntax. " +
      "Examples: \"name contains 'budget'\", " +
      "\"mimeType = 'application/vnd.google-apps.spreadsheet'\", " +
      "\"modifiedTime > '2024-01-01'\", " +
      "\"fullText contains 'quarterly report'\". " +
      "Combine with 'and': \"name contains 'report' and mimeType = 'application/pdf'\"",
    {
      userEmail: z
        .string()
        .email()
        .describe("Email address of the user whose Drive to search"),
      query: z
        .string()
        .describe("Drive search query (Drive API query syntax)"),
      maxResults: z
        .number()
        .min(1)
        .max(100)
        .default(10)
        .describe("Maximum number of files to return (default: 10)"),
    },
    async ({ userEmail, query, maxResults }) => {
      try {
        const auth = createAuthClient(userEmail);
        const drive = google.drive({ version: "v3", auth });

        const response = await drive.files.list({
          q: query,
          fields:
            "files(id,name,mimeType,modifiedTime,size,owners,webViewLink,shared)",
          pageSize: maxResults,
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
                text: `No files found for query: "${query}"`,
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
            `📄 ${file.name}\n` +
            `   ID: ${file.id}\n` +
            `   Type: ${file.mimeType}\n` +
            `   Modified: ${file.modifiedTime}\n` +
            `   Size: ${formatFileSize(file.size)}\n` +
            `   Owner: ${owner}\n` +
            `   Shared: ${file.shared ? "yes" : "no"}\n` +
            `   Link: ${file.webViewLink || "N/A"}`
          );
        });

        const text =
          `Found ${files.length} file(s) for query: "${query}":\n\n` +
          lines.join("\n\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[search_drive_files] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching Drive: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_file_content ──────────────────────────────────────────────
  server.tool(
    "get_file_content",
    "Read the content of a Google Drive file. " +
      "Google Docs are exported as plain text, Google Sheets as CSV (first sheet only), " +
      "and Google Slides as plain text. Text-based files are downloaded directly. " +
      "Binary files (PDFs, images, etc.) return metadata only with a link to view.",
    {
      userEmail: z
        .string()
        .email()
        .describe("Email address of the user who owns the file"),
      fileId: z
        .string()
        .describe(
          "Google Drive file ID (from search_drive_files results)"
        ),
    },
    async ({ userEmail, fileId }) => {
      try {
        const auth = createAuthClient(userEmail);
        const drive = google.drive({ version: "v3", auth });

        // Step 1: Get file metadata
        const meta = await drive.files.get({
          fileId,
          fields: "id,name,mimeType,size,webViewLink",
          supportsAllDrives: true,
        });

        const { mimeType, name, size, webViewLink } = meta.data;

        // Step 2: Google Workspace native doc? Export it.
        const exportInfo = mimeType
          ? GOOGLE_DOC_EXPORT_MAP[mimeType]
          : undefined;

        if (exportInfo) {
          try {
            const exported = await drive.files.export(
              { fileId, mimeType: exportInfo.exportMimeType },
              { responseType: "text" }
            );

            const content = truncate(
              String(exported.data),
              100000
            );
            const text = `[${exportInfo.label}: ${name}]\n\n${content}`;
            return { content: [{ type: "text" as const, text }] };
          } catch (exportError: unknown) {
            const msg =
              exportError instanceof Error
                ? exportError.message
                : String(exportError);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `[${exportInfo.label}: ${name}]\n\nFailed to export: ${msg}\n\nThe file may be too large to export (10 MB limit). View it at: ${webViewLink || "N/A"}`,
                },
              ],
              isError: true,
            };
          }
        }

        // Step 3: Readable text file? Download directly.
        if (
          mimeType &&
          (READABLE_MIME_TYPES.has(mimeType) ||
            mimeType.startsWith("text/"))
        ) {
          const downloaded = await drive.files.get(
            { fileId, alt: "media", supportsAllDrives: true },
            { responseType: "text" }
          );

          const content = truncate(
            String(downloaded.data),
            100000
          );
          const text = `[File: ${name} (${mimeType})]\n\n${content}`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Step 4: Binary file — return metadata only
        const text =
          `[Binary file: ${name}]\n` +
          `Type: ${mimeType}\n` +
          `Size: ${formatFileSize(size)}\n` +
          `Link: ${webViewLink || "N/A"}\n\n` +
          `Cannot display binary content. Use the link to view in browser.`;

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[get_file_content] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading file: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_file_metadata ─────────────────────────────────────────────
  server.tool(
    "get_file_metadata",
    "Get detailed metadata for a specific Google Drive file without downloading its content.",
    {
      userEmail: z
        .string()
        .email()
        .describe("Email address of the user who owns the file"),
      fileId: z
        .string()
        .describe("Google Drive file ID"),
    },
    async ({ userEmail, fileId }) => {
      try {
        const auth = createAuthClient(userEmail);
        const drive = google.drive({ version: "v3", auth });

        const response = await drive.files.get({
          fileId,
          fields:
            "id,name,mimeType,description,starred,trashed,parents,owners,permissions(emailAddress,role,type),createdTime,modifiedTime,size,webViewLink,webContentLink,shared,sharingUser",
          supportsAllDrives: true,
        });

        const file = response.data;

        let text =
          `File: ${file.name}\n` +
          `ID: ${file.id}\n` +
          `Type: ${file.mimeType}\n` +
          `Size: ${formatFileSize(file.size)}\n` +
          `Created: ${file.createdTime}\n` +
          `Modified: ${file.modifiedTime}\n` +
          `Starred: ${file.starred ? "yes" : "no"}\n` +
          `Trashed: ${file.trashed ? "yes" : "no"}\n` +
          `Shared: ${file.shared ? "yes" : "no"}\n` +
          `View link: ${file.webViewLink || "N/A"}\n` +
          `Download link: ${file.webContentLink || "N/A"}`;

        if (file.description) {
          text += `\nDescription: ${file.description}`;
        }

        if (file.owners && file.owners.length > 0) {
          text += `\n\nOwner(s):`;
          for (const owner of file.owners) {
            text += `\n- ${owner.displayName || "Unknown"} (${owner.emailAddress || "N/A"})`;
          }
        }

        if (file.permissions && file.permissions.length > 0) {
          text += `\n\nPermissions:`;
          for (const perm of file.permissions) {
            text += `\n- ${perm.emailAddress || perm.type || "Unknown"}: ${perm.role}`;
          }
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[get_file_metadata] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting file metadata: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
