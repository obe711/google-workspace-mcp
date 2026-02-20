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
          for (const att of parsed.attachments) {
            text += `\n- ${att.filename} (${att.mimeType}, ${formatFileSize(att.size)})`;
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
