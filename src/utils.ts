import type { gmail_v1 } from "googleapis";

export interface ParsedEmail {
  textBody: string | null;
  htmlBody: string | null;
  attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string | null }>;
}

/**
 * Decode Gmail's base64url-encoded body data to a UTF-8 string.
 * Gmail uses RFC 4648 base64url encoding (- instead of +, _ instead of /).
 */
export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Recursively walk the MIME tree of a Gmail message payload and extract:
 * - The first text/plain body
 * - The first text/html body
 * - All attachment metadata
 */
export function extractEmailBody(
  payload: gmail_v1.Schema$MessagePart
): ParsedEmail {
  const result: ParsedEmail = {
    textBody: null,
    htmlBody: null,
    attachments: [],
  };

  function walkParts(part: gmail_v1.Schema$MessagePart): void {
    const mimeType = part.mimeType || "";

    // If this part has a filename, it's an attachment
    if (part.filename && part.filename.length > 0) {
      result.attachments.push({
        filename: part.filename,
        mimeType,
        size: part.body?.size || 0,
        attachmentId: part.body?.attachmentId || null,
      });
      return;
    }

    // If this part has sub-parts, recurse
    if (part.parts && part.parts.length > 0) {
      for (const subPart of part.parts) {
        walkParts(subPart);
      }
      return;
    }

    // Leaf node with body data
    if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (mimeType === "text/plain" && !result.textBody) {
        result.textBody = decoded;
      } else if (mimeType === "text/html" && !result.htmlBody) {
        result.htmlBody = decoded;
      }
    }
  }

  walkParts(payload);
  return result;
}

/**
 * Lightweight HTML-to-text conversion.
 * Strips tags, decodes common entities, preserves basic structure.
 */
export function stripHtml(html: string): string {
  return (
    html
      // Remove script and style blocks entirely
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      // Replace structural elements with newlines
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Collapse multiple newlines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Get the most readable body text from a parsed email.
 * Prefers text/plain, falls back to stripped HTML.
 */
export function getReadableBody(parsed: ParsedEmail): string {
  if (parsed.textBody) {
    return parsed.textBody;
  }
  if (parsed.htmlBody) {
    return stripHtml(parsed.htmlBody);
  }
  return "(No readable body content)";
}

/**
 * Extract a specific header value from Gmail message headers.
 */
export function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
      ?.value || ""
  );
}

/**
 * Truncate text to a maximum length with a notice.
 */
export function truncate(text: string, maxLength: number = 50000): string {
  if (text.length <= maxLength) return text;
  return (
    text.slice(0, maxLength) +
    `\n\n[... truncated at ${maxLength.toLocaleString()} characters]`
  );
}

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatFileSize(bytes: number | string | null | undefined): string {
  if (bytes === null || bytes === undefined) return "unknown size";
  const numBytes = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
  if (isNaN(numBytes)) return "unknown size";
  if (numBytes < 1024) return `${numBytes} B`;
  if (numBytes < 1024 * 1024) return `${(numBytes / 1024).toFixed(1)} KB`;
  if (numBytes < 1024 * 1024 * 1024)
    return `${(numBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(numBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
