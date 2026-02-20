import { google } from "googleapis";
import { readFileSync } from "fs";

interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

let cachedKey: ServiceAccountKey | null = null;

function getServiceAccountKey(): ServiceAccountKey {
  if (cachedKey) return cachedKey;

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_PATH environment variable is not set. " +
        "Set it to the path of your service account JSON key file."
    );
  }

  const raw = readFileSync(keyPath, "utf-8");
  cachedKey = JSON.parse(raw) as ServiceAccountKey;
  return cachedKey;
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
];

/**
 * Returns the default user email from the GW_USER_EMAIL environment variable.
 * Throws if the variable is not set and no email was provided.
 */
export function getDefaultUserEmail(): string {
  const email = process.env.GW_USER_EMAIL;
  if (!email) {
    throw new Error(
      "GW_USER_EMAIL environment variable is not set. " +
        "Set it in your .env file or pass userEmail explicitly."
    );
  }
  return email;
}

/**
 * Creates a Google auth JWT client configured for domain-wide delegation,
 * impersonating the specified user.
 *
 * A new JWT client must be created per user because the `subject`
 * (impersonated user) is bound at construction time.
 */
export function createAuthClient(userEmail: string) {
  const key = getServiceAccountKey();
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: userEmail,
  });
}
