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

export function getConfig(): Config {
  // PORT is injected by the hosting platform (DigitalOcean App Platform, Heroku, Cloud Run).
  // It must take precedence over SERVER_PORT: if a stale SERVER_PORT wins, the app binds a
  // port the platform is not routing to, no health check ever passes, and the edge serves 503.
  const port = Number(process.env.PORT || process.env.SERVER_PORT || 8787);
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
  };
}
