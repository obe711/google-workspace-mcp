---
name: gw
description: Query Google Workspace (Gmail, Drive, Sheets, Docs, Admin, Calendar, Slides). Use when searching emails, drive files, calendar events, presentations, reading docs/sheets, or listing users.
argument-hint: [query]
---

# Google Workspace Query

When using any Google Workspace MCP tool, **omit the `userEmail` parameter** — the server defaults to the email configured in its `.env` file (`GW_USER_EMAIL`). Only pass `userEmail` if the user explicitly wants to query as a different account.

This applies to all tools: search_emails, get_email, list_labels, search_drive_files, get_file_content, get_file_metadata, get_spreadsheet, read_sheet_range, batch_read_sheet_ranges, get_document, get_document_structure, list_users.

Perform the user's request: $ARGUMENTS
