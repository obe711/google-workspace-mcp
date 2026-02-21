import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google } from "googleapis";
import { z } from "zod";
import { createAuthClient, getDefaultUserEmail } from "../auth.js";

export function registerCalendarTools(server: McpServer): void {
  // ── list_calendars ───────────────────────────────────────────────
  server.tool(
    "list_calendars",
    "List all calendars a user has access to. " +
      "Returns calendar ID, name, description, primary flag, access role, and timezone.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe(
          "Email address of the user (defaults to GW_USER_EMAIL)"
        ),
    },
    async ({ userEmail }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const calendar = google.calendar({ version: "v3", auth });

        const response = await calendar.calendarList.list();
        const calendars = response.data.items || [];

        if (calendars.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No calendars found." },
            ],
          };
        }

        const lines = calendars.map((cal) => {
          const parts = [
            `${cal.summary || "(unnamed)"}`,
            `ID: ${cal.id}`,
            `Role: ${cal.accessRole}`,
            `Timezone: ${cal.timeZone || "N/A"}`,
          ];
          if (cal.primary) parts.push("PRIMARY");
          if (cal.description) parts.push(`Description: ${cal.description}`);
          return `- ${parts.join(" | ")}`;
        });

        const text = `Calendars for ${resolvedEmail}:\n\n${lines.join("\n")}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[list_calendars] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing calendars: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── search_events ────────────────────────────────────────────────
  server.tool(
    "search_events",
    "Search or list events on a Google Calendar within a date range. " +
      "Returns event ID, summary, start/end times, location, organizer, attendees, and meet link.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe(
          "Email address of the user (defaults to GW_USER_EMAIL)"
        ),
      calendarId: z
        .string()
        .optional()
        .default("primary")
        .describe(
          "Calendar ID to search (default: 'primary')"
        ),
      query: z
        .string()
        .optional()
        .describe("Free-text search query to filter events"),
      timeMin: z
        .string()
        .optional()
        .describe(
          "Start of time range as ISO 8601 datetime (e.g. '2026-01-01T00:00:00Z')"
        ),
      timeMax: z
        .string()
        .optional()
        .describe(
          "End of time range as ISO 8601 datetime (e.g. '2026-12-31T23:59:59Z')"
        ),
      maxResults: z
        .number()
        .min(1)
        .max(100)
        .default(10)
        .describe("Maximum number of events to return (default: 10)"),
    },
    async ({ userEmail, calendarId, query, timeMin, timeMax, maxResults }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const calendar = google.calendar({ version: "v3", auth });

        const response = await calendar.events.list({
          calendarId,
          singleEvents: true,
          orderBy: "startTime",
          maxResults,
          q: query || undefined,
          timeMin: timeMin || undefined,
          timeMax: timeMax || undefined,
        });
        const events = response.data.items || [];

        if (events.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No events found${query ? ` for query: "${query}"` : ""}.`,
              },
            ],
          };
        }

        const results = events.map((event: { id?: string | null; summary?: string | null; start?: { dateTime?: string | null; date?: string | null } | null; end?: { dateTime?: string | null; date?: string | null } | null; location?: string | null; organizer?: { displayName?: string | null; email?: string | null } | null; attendees?: Array<{ displayName?: string | null; email?: string | null; responseStatus?: string | null }> | null; hangoutLink?: string | null; status?: string | null }) => {
          const start =
            event.start?.dateTime || event.start?.date || "N/A";
          const end =
            event.end?.dateTime || event.end?.date || "N/A";

          const parts = [
            `📅 ${event.summary || "(no title)"}`,
            `   ID: ${event.id}`,
            `   Start: ${start}`,
            `   End: ${end}`,
          ];

          if (event.location) parts.push(`   Location: ${event.location}`);
          if (event.organizer) {
            parts.push(
              `   Organizer: ${event.organizer.displayName || event.organizer.email}`
            );
          }
          if (event.attendees && event.attendees.length > 0) {
            const attendeeList = event.attendees
              .map(
                (a: { displayName?: string | null; email?: string | null; responseStatus?: string | null }) =>
                  `${a.displayName || a.email} (${a.responseStatus || "unknown"})`
              )
              .join(", ");
            parts.push(`   Attendees: ${attendeeList}`);
          }
          if (event.hangoutLink) {
            parts.push(`   Meet: ${event.hangoutLink}`);
          }
          if (event.status) parts.push(`   Status: ${event.status}`);

          return parts.join("\n");
        });

        const text =
          `Found ${events.length} event(s)${query ? ` for query: "${query}"` : ""}:\n\n` +
          results.join("\n\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[search_events] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching events: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_event ────────────────────────────────────────────────────
  server.tool(
    "get_event",
    "Get full details of a specific Google Calendar event by event ID. " +
      "Returns summary, description, start/end, location, organizer, attendees with RSVP status, " +
      "recurrence rules, meet link, attachments, reminders, and timestamps.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe(
          "Email address of the user (defaults to GW_USER_EMAIL)"
        ),
      calendarId: z
        .string()
        .optional()
        .default("primary")
        .describe(
          "Calendar ID (default: 'primary')"
        ),
      eventId: z.string().describe("The event ID (from search_events results)"),
    },
    async ({ userEmail, calendarId, eventId }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const calendar = google.calendar({ version: "v3", auth });

        const response = await calendar.events.get({
          calendarId,
          eventId,
        });
        const event = response.data;

        const start =
          event.start?.dateTime || event.start?.date || "N/A";
        const end =
          event.end?.dateTime || event.end?.date || "N/A";

        let text =
          `Summary: ${event.summary || "(no title)"}\n` +
          `Status: ${event.status || "N/A"}\n` +
          `Start: ${start}\n` +
          `End: ${end}\n`;

        if (event.location) text += `Location: ${event.location}\n`;
        if (event.visibility) text += `Visibility: ${event.visibility}\n`;

        if (event.organizer) {
          text += `Organizer: ${event.organizer.displayName || ""} <${event.organizer.email}>\n`;
        }

        if (event.attendees && event.attendees.length > 0) {
          text += `\n--- Attendees (${event.attendees.length}) ---\n`;
          for (const a of event.attendees) {
            const name = a.displayName || a.email || "unknown";
            text += `- ${name} (${a.responseStatus || "unknown"})`;
            if (a.organizer) text += " [organizer]";
            if (a.optional) text += " [optional]";
            text += "\n";
          }
        }

        if (event.description) {
          text += `\n--- Description ---\n${event.description}\n`;
        }

        if (event.recurrence && event.recurrence.length > 0) {
          text += `\nRecurrence: ${event.recurrence.join("; ")}\n`;
        }

        if (event.hangoutLink) {
          text += `Meet link: ${event.hangoutLink}\n`;
        }
        if (event.conferenceData?.entryPoints) {
          text += `\n--- Conference ---\n`;
          for (const ep of event.conferenceData.entryPoints) {
            text += `- ${ep.entryPointType}: ${ep.uri || ep.label}\n`;
          }
        }

        if (event.attachments && event.attachments.length > 0) {
          text += `\n--- Attachments (${event.attachments.length}) ---\n`;
          for (const att of event.attachments) {
            text += `- ${att.title} (${att.mimeType}) ${att.fileUrl}\n`;
          }
        }

        if (event.reminders) {
          if (event.reminders.useDefault) {
            text += `\nReminders: default\n`;
          } else if (event.reminders.overrides) {
            text += `\nReminders:\n`;
            for (const r of event.reminders.overrides) {
              text += `- ${r.method}: ${r.minutes} minutes before\n`;
            }
          }
        }

        text += `\nCreated: ${event.created || "N/A"}\n`;
        text += `Updated: ${event.updated || "N/A"}\n`;

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[get_event] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting event: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_freebusy ─────────────────────────────────────────────────
  server.tool(
    "get_freebusy",
    "Query free/busy status for one or more users over a time range. " +
      "Returns per-user busy intervals (start/end pairs) and any errors.",
    {
      userEmail: z
        .string()
        .email()
        .optional()
        .describe(
          "Email of the impersonated caller (defaults to GW_USER_EMAIL)"
        ),
      emails: z
        .array(z.string().email())
        .min(1)
        .describe(
          "Array of email addresses to check free/busy status for"
        ),
      timeMin: z
        .string()
        .describe(
          "Start of time range as ISO 8601 datetime (e.g. '2026-01-01T00:00:00Z')"
        ),
      timeMax: z
        .string()
        .describe(
          "End of time range as ISO 8601 datetime (e.g. '2026-01-07T23:59:59Z')"
        ),
    },
    async ({ userEmail, emails, timeMin, timeMax }) => {
      try {
        const resolvedEmail = userEmail || getDefaultUserEmail();
        const auth = createAuthClient(resolvedEmail);
        const calendar = google.calendar({ version: "v3", auth });

        const response = await calendar.freebusy.query({
          requestBody: {
            timeMin,
            timeMax,
            items: emails.map((email) => ({ id: email })),
          },
        });

        const calendars = response.data.calendars || {};
        const results: string[] = [];

        for (const email of emails) {
          const info = calendars[email];
          if (!info) {
            results.push(`${email}: No data available`);
            continue;
          }

          if (info.errors && info.errors.length > 0) {
            const errs = info.errors
              .map((e) => `${e.domain}/${e.reason}`)
              .join(", ");
            results.push(`${email}: Error — ${errs}`);
            continue;
          }

          const busy = info.busy || [];
          if (busy.length === 0) {
            results.push(`${email}: Free (no busy intervals)`);
          } else {
            const intervals = busy
              .map((b) => `  ${b.start} → ${b.end}`)
              .join("\n");
            results.push(
              `${email}: ${busy.length} busy interval(s)\n${intervals}`
            );
          }
        }

        const text =
          `Free/busy from ${timeMin} to ${timeMax}:\n\n` +
          results.join("\n\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(`[get_freebusy] Error: ${message}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error querying free/busy: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
