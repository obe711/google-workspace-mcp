import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google } from "googleapis";
import { z } from "zod";
import { createAuthClient, getDefaultUserEmail } from "../auth.js";
import {
  extractEmailBody,
  getReadableBody,
  getHeader,
  truncate,
  formatFileSize,
} from "../utils.js";

export function registerGmailTools(server: McpServer): void {
  // ── search_emails ─────────────────────────────────────────────────
  server.tool(
    "search_emails",
    "Search a user's Gmail messages using Gmail query syntax. " +
      "Examples: 'from:boss@co.com subject:budget', 'is:unread newer_than:7d', " +
      "'has:attachment filename:pdf'. Returns subject, from, date, and snippet for each result.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe("Email address of the user to search (defaults to GW_USER_EMAIL)"),
      query: z
        .string()
        .describe(
          "Gmail search query (same syntax as Gmail search bar)"
        ),
      maxResults: z
        .number()
        .min(1)
        .max(100)
        .default(10)
        .describe("Maximum number of messages to return (default: 10)"),
    },
    async ({ userEmail, query, maxResults }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const gmail = google.gmail({ version: "v1", auth });

        // Step 1: Get message IDs matching the query
        const listResponse = await gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults,
        });

        const messages = listResponse.data.messages;
        if (!messages || messages.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No messages found for query: "${query}"`,
              },
            ],
          };
        }

        // Step 2: Fetch metadata for each message
        const results: string[] = [];

        for (const msg of messages) {
          if (!msg.id) continue;

          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });

          const headers = detail.data.payload?.headers;
          const from = getHeader(headers, "From");
          const to = getHeader(headers, "To");
          const subject = getHeader(headers, "Subject") || "(no subject)";
          const date = getHeader(headers, "Date");
          const snippet = detail.data.snippet || "";

          results.push(
            `📧 ${subject}\n` +
              `   ID: ${msg.id}\n` +
              `   From: ${from}\n` +
              `   To: ${to}\n` +
              `   Date: ${date}\n` +
              `   Preview: ${snippet}`
          );
        }

        const total = listResponse.data.resultSizeEstimate || messages.length;
        const text =
          `Found ${total} result(s) for query: "${query}" (showing ${results.length}):\n\n` +
          results.join("\n\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[search_emails] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching emails: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_email ─────────────────────────────────────────────────────
  server.tool(
    "get_email",
    "Get the full content of a specific email by message ID. " +
      "Returns headers, body text, and attachment list. " +
      "Use search_emails first to find message IDs.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe("Email address of the user who owns the message (defaults to GW_USER_EMAIL)"),
      messageId: z
        .string()
        .describe("Gmail message ID (from search_emails results)"),
    },
    async ({ userEmail, messageId }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const gmail = google.gmail({ version: "v1", auth });

        const response = await gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });

        const msg = response.data;
        const headers = msg.payload?.headers;
        const from = getHeader(headers, "From");
        const to = getHeader(headers, "To");
        const cc = getHeader(headers, "Cc");
        const subject = getHeader(headers, "Subject") || "(no subject)";
        const date = getHeader(headers, "Date");

        // Parse the MIME body
        const parsed = msg.payload
          ? extractEmailBody(msg.payload)
          : { textBody: null, htmlBody: null, attachments: [] };
        const body = getReadableBody(parsed);

        // Format output
        let text =
          `From: ${from}\n` +
          `To: ${to}\n` +
          (cc ? `Cc: ${cc}\n` : "") +
          `Subject: ${subject}\n` +
          `Date: ${date}\n` +
          `Labels: ${(msg.labelIds || []).join(", ")}\n` +
          `\n--- Body ---\n\n` +
          truncate(body);

        if (parsed.attachments.length > 0) {
          text += `\n\n--- Attachments (${parsed.attachments.length}) ---\n`;
          text += `(Use get_email_attachment with the message ID and attachment ID to download)\n`;
          for (const att of parsed.attachments) {
            text += `\n- ${att.filename} (${att.mimeType}, ${formatFileSize(att.size)})`;
            if (att.attachmentId) {
              text += `\n  Attachment ID: ${att.attachmentId}`;
            }
          }
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[get_email] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting email: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_email_attachment ──────────────────────────────────────────
  server.tool(
    "get_email_attachment",
    "Download an email attachment by message ID and attachment ID. " +
      "Returns image content for image attachments (viewable by the LLM), " +
      "decoded text for text-based files, or base64 data for binary files. " +
      "Use get_email first to find attachment IDs.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe("Email address of the user who owns the message (defaults to GW_USER_EMAIL)"),
      messageId: z
        .string()
        .describe("Gmail message ID (from search_emails results)"),
      attachmentId: z
        .string()
        .describe("Attachment ID (from get_email results)"),
    },
    async ({ userEmail, messageId, attachmentId }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const gmail = google.gmail({ version: "v1", auth });

        // Fetch the full message to find attachment metadata (filename, mimeType)
        const msgResponse = await gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });

        const parsed = msgResponse.data.payload
          ? extractEmailBody(msgResponse.data.payload)
          : { textBody: null, htmlBody: null, attachments: [] };

        const attachmentMeta = parsed.attachments.find(
          (att) => att.attachmentId === attachmentId
        );
        const filename = attachmentMeta?.filename || "attachment";
        const mimeType = attachmentMeta?.mimeType || "application/octet-stream";

        // Download the attachment data
        const attResponse = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: attachmentId,
        });

        const base64UrlData = attResponse.data.data;
        if (!base64UrlData) {
          return {
            content: [{ type: "text" as const, text: "Attachment data is empty." }],
            isError: true,
          };
        }

        // Convert base64url to standard base64
        const base64Data = base64UrlData.replace(/-/g, "+").replace(/_/g, "/");

        // Return based on content type
        if (mimeType.startsWith("image/")) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Attachment: ${filename} (${mimeType}, ${formatFileSize(attResponse.data.size)})`,
              },
              {
                type: "image" as const,
                data: base64Data,
                mimeType,
              },
            ],
          };
        }

        // Text-based content types
        const textTypes = [
          "text/",
          "application/json",
          "application/xml",
          "application/javascript",
          "application/typescript",
          "application/x-yaml",
          "application/yaml",
          "application/csv",
          "application/sql",
        ];
        const isText = textTypes.some((t) => mimeType.startsWith(t));

        if (isText) {
          const decoded = Buffer.from(base64Data, "base64").toString("utf-8");
          return {
            content: [
              {
                type: "text" as const,
                text: `Attachment: ${filename} (${mimeType}, ${formatFileSize(attResponse.data.size)})\n\n${truncate(decoded)}`,
              },
            ],
          };
        }

        // Binary files — return as resource with base64 blob
        return {
          content: [
            {
              type: "text" as const,
              text: `Attachment: ${filename} (${mimeType}, ${formatFileSize(attResponse.data.size)})\n\nBinary file returned as base64-encoded resource below.`,
            },
            {
              type: "resource" as const,
              resource: {
                uri: `attachment:///${messageId}/${encodeURIComponent(filename)}`,
                mimeType,
                blob: base64Data,
              },
            },
          ],
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[get_email_attachment] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting attachment: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── list_labels ───────────────────────────────────────────────────
  server.tool(
    "list_labels",
    "List all Gmail labels for a user. Useful for understanding mailbox organization.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe("Email address of the user (defaults to GW_USER_EMAIL)"),
    },
    async ({ userEmail }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const gmail = google.gmail({ version: "v1", auth });

        const response = await gmail.users.labels.list({ userId: "me" });
        const labels = response.data.labels || [];

        if (labels.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No labels found." }],
          };
        }

        // Sort: system labels first, then user labels alphabetically
        const sorted = labels.sort((a, b) => {
          if (a.type === "system" && b.type !== "system") return -1;
          if (a.type !== "system" && b.type === "system") return 1;
          return (a.name || "").localeCompare(b.name || "");
        });

        const lines = sorted.map((label) => {
          const parts = [`${label.name} (${label.type})`];
          if (label.messagesTotal !== undefined) {
            parts.push(`messages: ${label.messagesTotal}`);
          }
          if (label.messagesUnread !== undefined) {
            parts.push(`unread: ${label.messagesUnread}`);
          }
          return `- [${label.id}] ${parts.join(", ")}`;
        });

        const text = `Gmail labels for ${resolvedEmail}:\n\n${lines.join("\n")}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[list_labels] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing labels: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
