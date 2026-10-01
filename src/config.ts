import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

let envLoaded = false;
function loadEnvOnce() {
  if (envLoaded) return;
  envLoaded = true;
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, "../.env"), // dist -> server/.env
    path.resolve(__dirname, "../../.env"), // dist -> project/.env
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        break;
      }
    } catch {}
  }
}

loadEnvOnce();
type Config = {
  port: number;
  allowedOrigins: string[];
  openaiApiKey?: string;
  deepgramApiKey?: string;
  youtubeDataApiKey?: string;
  supadataApiKey?: string;
  databaseUrlReadOnly?: string;
  firebaseServiceAccountJson?: string;
  youtubeDebugToken?: string;
  aiAuthRequired: boolean;
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
  appleClientId?: string;
  accountDeletionSigningSecret?: string;
  appCheckRequired: boolean;
  appCheckAllowedAppIds: string[];
  appleBundleId: string;
  /** "development" on local servers; anything else (or unset) is treated as production. */
  appEnv: string;
  /** Accept Xcode's locally signed StoreKit test transactions. Only allowed with APP_ENV=development. */
  appleAllowXcodeTransactions: boolean;
  /** Refuse Pro-only AI endpoints to accounts without a verified subscription. */
  subscriptionEnforcement: boolean;
  /** Accounts that always have Pro, e.g. the developer sandbox account. */
  subscriptionUnlimitedEmails: string[];
  /** The super admin account, created or fixed on startup (see admin/roleService.ts). */
  superAdminEmail?: string;
  /** Used only to create a missing super admin account; never stored. */
  superAdminPassword?: string;
};

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return ["*"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCommaSeparatedValues(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Xcode StoreKit test transactions are not signed by Apple, so accepting them
 * lets anyone forge a subscription. A server that is not explicitly a
 * development server refuses to start with the flag on.
 */
export function assertXcodeTransactionsAllowed(appEnv: string, allowXcodeTransactions: boolean) {
  if (allowXcodeTransactions && appEnv !== "development") {
    throw new Error(
      "APPLE_ALLOW_XCODE_TRANSACTIONS=true is only allowed when APP_ENV=development. Remove it from production."
    );
  }
}

export function getConfig(): Config {
  // PORT is injected by the hosting platform (DigitalOcean App Platform, Heroku, Cloud Run).
  // It must take precedence over SERVER_PORT: if a stale SERVER_PORT wins, the app binds a
  // port the platform is not routing to, no health check ever passes, and the edge serves 503.
  const port = Number(process.env.PORT || process.env.SERVER_PORT || 8787);
  const appEnv = process.env.APP_ENV?.trim().toLowerCase() || "production";
  const appleAllowXcodeTransactions = process.env.APPLE_ALLOW_XCODE_TRANSACTIONS?.trim().toLowerCase() === "true";
  assertXcodeTransactionsAllowed(appEnv, appleAllowXcodeTransactions);
  return {
    port: Number.isFinite(port) ? port : 8787,
    allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
    openaiApiKey: process.env.OPENAI_API_KEY?.trim(),
    deepgramApiKey: process.env.DEEPGRAM_API_KEY?.trim(),
    youtubeDataApiKey: process.env.YOUTUBE_DATA_API_KEY?.trim(),
    supadataApiKey: process.env.SUPADATA_API_KEY?.trim(),
    databaseUrlReadOnly: process.env.DATABASE_URL_READONLY,
    firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim(),
    youtubeDebugToken: process.env.YOUTUBE_DEBUG_TOKEN?.trim(),
    aiAuthRequired: process.env.AI_AUTH_REQUIRED?.trim().toLowerCase() !== "false",
    appleTeamId: process.env.APPLE_TEAM_ID?.trim(),
    appleKeyId: process.env.APPLE_KEY_ID?.trim(),
    applePrivateKey: process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim(),
    appleClientId: process.env.APPLE_CLIENT_ID?.trim(),
    accountDeletionSigningSecret: process.env.ACCOUNT_DELETION_SIGNING_SECRET?.trim(),
    appCheckRequired: process.env.APP_CHECK_REQUIRED?.trim().toLowerCase() === "true",
    appCheckAllowedAppIds: parseCommaSeparatedValues(process.env.APP_CHECK_ALLOWED_APP_IDS),
    appleBundleId: process.env.APPLE_BUNDLE_ID?.trim() || "com.eazee.ai",
    appEnv,
    appleAllowXcodeTransactions,
    subscriptionEnforcement: process.env.SUBSCRIPTION_ENFORCEMENT?.trim().toLowerCase() === "true",
    subscriptionUnlimitedEmails: parseCommaSeparatedValues(
      process.env.SUBSCRIPTION_UNLIMITED_EMAILS ?? "developer_sandbox@eazee.ai"
    ).map((email) => email.toLowerCase()),
    superAdminEmail: process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase() || undefined,
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || undefined,
  };
}
