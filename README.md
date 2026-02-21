# Google Workspace MCP Server

A read-only [MCP](https://modelcontextprotocol.io/) server that provides access to Google Workspace APIs — Gmail, Drive, Sheets, Docs, Slides, Calendar, and Admin Directory. It uses a GCP service account with domain-wide delegation to impersonate workspace users.

## Prerequisites

- Node.js 18+
- A Google Cloud project with a **service account** that has [domain-wide delegation](https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority) enabled
- The service account's JSON key file downloaded locally

### Required API Scopes

When configuring domain-wide delegation in your Google Workspace Admin Console, grant the service account these scopes:

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/admin.directory.user.readonly
https://www.googleapis.com/auth/spreadsheets.readonly
https://www.googleapis.com/auth/documents.readonly
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/presentations.readonly
```

## Google Cloud Setup

### 1. Create a GCP Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Click **Select a project** > **New Project**
3. Name it (e.g., `workspace-mcp-server`) and click **Create**
4. Select the newly created project

### 2. Enable APIs

Enable the following APIs in **APIs & Services > Library** (or click the links below):

- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
- [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
- [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com)
- [Admin SDK API](https://console.cloud.google.com/apis/library/admin.googleapis.com)
- [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
- [Google Slides API](https://console.cloud.google.com/apis/library/slides.googleapis.com)

For each one, click **Enable**.

### 3. Create a Service Account

1. Go to **IAM & Admin > Service Accounts**
2. Click **Create Service Account**
3. Give it a name (e.g., `workspace-mcp`) and click **Create and Continue**
4. Skip the optional "Grant this service account access" and "Grant users access" steps — click **Done**
5. Click on the newly created service account
6. Go to the **Keys** tab
7. Click **Add Key > Create new key > JSON** and click **Create**
8. Save the downloaded JSON key file somewhere secure (e.g., `~/.config/gcp/service-account-key.json`)

> **Warning:** This key file grants access to your Workspace data. Never commit it to version control.

### 4. Enable Domain-Wide Delegation

1. On the service account details page, click **Show Advanced Settings**
2. Under **Domain-wide delegation**, click **Enable Google Workspace Domain-wide Delegation**
3. Note the **Client ID** (a numeric string) — you'll need it in the next step

### 5. Grant Scopes in Google Workspace Admin

1. Go to the [Google Workspace Admin Console](https://admin.google.com/)
2. Navigate to **Security > Access and data control > API controls**
3. Click **Manage Domain Wide Delegation**
4. Click **Add new**
5. Enter the **Client ID** from step 4
6. In the **OAuth scopes** field, paste all seven scopes (comma-separated):

   ```
   https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/spreadsheets.readonly,https://www.googleapis.com/auth/documents.readonly,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/presentations.readonly
   ```

7. Click **Authorize**

> **Note:** The `admin.directory.user.readonly` scope requires the impersonated user to be a Workspace admin. The other scopes work for any user in the domain.

## Installation

```bash
git clone git@github.com:obe711/google-workspace-mcp.git
cd google-workspace-mcp
npm install
npm run build
```

## Configuration

1. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set:
   - **`GOOGLE_SERVICE_ACCOUNT_KEY_PATH`** — Absolute path to your service account JSON key file
   - **`GW_USER_EMAIL`** — The default Google Workspace email to impersonate when `userEmail` is not passed to a tool (e.g., `you@yourdomain.com`)

   ```dotenv
   GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/Users/me/keys/service-account-key.json
   GW_USER_EMAIL=you@yourdomain.com
   ```

> **Note:** `.env` is git-ignored and will not be committed. Never commit your service account key file.

## Usage with Claude Code

### 1. Register the MCP server

Add the server to your Claude Code MCP config (project-level `.mcp.json` or global `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["build/index.js"],
      "cwd": "/absolute/path/to/google-workspace-mcp"
    }
  }
}
```

The server reads all configuration from the `.env` file — no `env` overrides are needed in the MCP config.

### 2. Use the `/gw` skill

Once configured, use the `/gw` slash command in Claude Code:

```
/gw search my recent emails about project updates
/gw find spreadsheets modified this week
/gw read the Q4 budget document
/gw list workspace users
```

## Available Tools

| Tool                      | Description                                   |
| ------------------------- | --------------------------------------------- |
| `search_emails`           | Search Gmail using Gmail query syntax         |
| `get_email`               | Get full content of an email by message ID    |
| `list_labels`             | List all Gmail labels                         |
| `search_drive_files`      | Search Google Drive files                     |
| `get_file_content`        | Read the content of a Drive file              |
| `get_file_metadata`       | Get metadata for a Drive file                 |
| `get_spreadsheet`         | Get spreadsheet metadata (sheets, dimensions) |
| `read_sheet_range`        | Read cell values from a spreadsheet range     |
| `batch_read_sheet_ranges` | Read multiple spreadsheet ranges at once      |
| `get_document`            | Get full text content of a Google Doc         |
| `get_document_structure`  | Get heading outline of a Google Doc           |
| `list_users`              | List Google Workspace users (requires admin)  |
| `list_calendars`          | List all calendars a user has access to       |
| `search_events`           | Search/list calendar events in a date range   |
| `get_event`               | Get full details of a calendar event          |
| `get_freebusy`            | Query free/busy status for one or more users  |
| `search_presentations`    | Search for Google Slides presentations         |
| `get_presentation`        | Get presentation metadata and slide overview   |
| `get_slide`               | Get full text content of a single slide        |

## Development

```bash
npm run dev    # Watch mode — recompiles on changes
npm run build  # One-time build
npm start      # Run the server
```
