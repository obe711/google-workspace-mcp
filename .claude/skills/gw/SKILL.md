---
name: gw
description: Query Google Workspace (Gmail, Drive, Sheets, Docs, Admin) as $GW_USER_EMAIL. Use when searching emails, drive files, reading docs/sheets, or listing users.
argument-hint: [query]
---

# Google Workspace Query

When using any Google Workspace MCP tool, always set `userEmail` to **$GW_USER_EMAIL**.

This applies to all tools: search_emails, get_email, list_labels, search_drive_files, get_file_content, get_file_metadata, get_spreadsheet, read_sheet_range, batch_read_sheet_ranges, get_document, get_document_structure, list_users.

Perform the user's request: $ARGUMENTS
