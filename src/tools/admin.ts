import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google } from "googleapis";
import { z } from "zod";
import { createAuthClient } from "../auth.js";

export function registerAdminTools(server: McpServer): void {
  server.tool(
    "list_users",
    "List all users in the Google Workspace organization. The userEmail must be a Workspace admin.",
    {
      userEmail: z
        .string()
        .email()
        .describe(
          "Email of a Workspace admin to impersonate (must have admin privileges)"
        ),
      domain: z
        .string()
        .optional()
        .describe(
          "Workspace domain to list users for (defaults to all domains)"
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Admin SDK search query (e.g., orgUnitPath=/Engineering, name:John)"
        ),
      maxResults: z
        .number()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of users to return (default: 100)"),
    },
    async ({ userEmail, domain, query, maxResults }) => {
      try {
        const auth = createAuthClient(userEmail);
        const admin = google.admin({ version: "directory_v1", auth });

        const allUsers: Array<{
          email: string;
          name: string;
          orgUnit: string;
          isAdmin: boolean;
          suspended: boolean;
          lastLogin: string;
          creationTime: string;
        }> = [];

        let pageToken: string | undefined;

        do {
          const response = await admin.users.list({
            customer: "my_customer",
            domain: domain || undefined,
            query: query || undefined,
            maxResults: Math.min(maxResults - allUsers.length, 500),
            orderBy: "email",
            pageToken,
            fields:
              "users(primaryEmail,name,orgUnitPath,isAdmin,suspended,lastLoginTime,creationTime),nextPageToken",
          });

          if (response.data.users) {
            for (const user of response.data.users) {
              allUsers.push({
                email: user.primaryEmail || "",
                name: `${user.name?.givenName || ""} ${user.name?.familyName || ""}`.trim(),
                orgUnit: user.orgUnitPath || "/",
                isAdmin: user.isAdmin || false,
                suspended: user.suspended || false,
                lastLogin: user.lastLoginTime || "Never",
                creationTime: user.creationTime || "",
              });
            }
          }

          pageToken = response.data.nextPageToken || undefined;
        } while (pageToken && allUsers.length < maxResults);

        if (allUsers.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No users found." }],
          };
        }

        const lines = allUsers.map(
          (u) =>
            `- ${u.email} (${u.name}) — OU: ${u.orgUnit}, Admin: ${u.isAdmin ? "yes" : "no"}, Suspended: ${u.suspended ? "yes" : "no"}, Last login: ${u.lastLogin}, Created: ${u.creationTime}`
        );

        const text = `Found ${allUsers.length} user(s):\n\n${lines.join("\n")}`;

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[list_users] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing users: ${message}\n\nEnsure the userEmail is a Workspace admin and that domain-wide delegation includes the admin.directory.user.readonly scope.`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
