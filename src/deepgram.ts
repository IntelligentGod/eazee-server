import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  isFirebaseAuthenticationError,
  verifyFirebaseRequest,
  type AuthenticatedUser,
} from "./auth/firebase";

const DeepgramTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const DeepgramTranscriptResponseSchema = z.object({
  results: z.object({
    channels: z.array(z.object({
      alternatives: z.array(z.object({
        transcript: z.string(),
      })),
    })),
  }),
});

const DEEPGRAM_TOKEN_TTL_SECONDS = 60;
export const DEEPGRAM_TOKEN_TIMEOUT_MS = 10_000;
export const DEEPGRAM_TRANSCRIPTION_TIMEOUT_MS = 60_000;

type DeepgramRouterOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  verifyRequest?: (req: Request) => Promise<AuthenticatedUser | null>;
  isAuthenticationError?: (error: unknown) => boolean;
  tokenTimeoutMs?: number;
  transcriptionTimeoutMs?: number;
  rawBodyLimit?: string;
};

class DeepgramTimeoutError extends Error {
  constructor() {
    super("Deepgram request timed out");
    this.name = "DeepgramTimeoutError";
  }
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    const body = await response.json().catch((error) => {
      if (controller.signal.aborted) throw error;
      return null;
    });
    return { response, body };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DeepgramTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function audioBodyErrorHandler(error: any, _req: Request, res: Response, next: NextFunction) {
  if (error?.type === "entity.too.large" || error?.status === 413) {
    return res.status(413).json({ error: "Audio file too large" });
  }
  next(error);
}

export function createDeepgramRouter(options: DeepgramRouterOptions) {
  const router = express.Router();
  const fetchImpl = options.fetchImpl ?? fetch;
  const verifyRequest = options.verifyRequest
    ?? ((req: Request) => verifyFirebaseRequest(req, { checkRevoked: true }));
  const isAuthenticationError = options.isAuthenticationError ?? isFirebaseAuthenticationError;
  const tokenTimeoutMs = options.tokenTimeoutMs ?? DEEPGRAM_TOKEN_TIMEOUT_MS;
  const transcriptionTimeoutMs = options.transcriptionTimeoutMs ?? DEEPGRAM_TRANSCRIPTION_TIMEOUT_MS;

  const authenticate = (failureLabel: string, unavailableMessage: string) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = await verifyRequest(req);
        if (!user) {
          return res.status(401).json({ error: "Authentication required" });
        }
        if (!options.apiKey) {
          return res.status(503).json({ error: "Deepgram transcription is not configured" });
        }
        return next();
      } catch (error) {
        if (isAuthenticationError(error)) {
          return res.status(401).json({ error: "Authentication required" });
        }
        console.error(`[${failureLabel}] authentication failed`);
        return res.status(500).json({ error: unavailableMessage });
      }
    };

  router.post("/token", authenticate("deepgram-token", "Deepgram token unavailable"), async (_req, res) => {
    try {
      const { response, body } = await fetchJsonWithTimeout(
        fetchImpl,
        "https://api.deepgram.com/v1/auth/grant",
        {
          method: "POST",
          headers: {
            Authorization: `Token ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl_seconds: DEEPGRAM_TOKEN_TTL_SECONDS }),
        },
        tokenTimeoutMs
      );

      if (!response.ok) {
        const errorBody = body as { err_code?: unknown; err_msg?: unknown; error?: unknown; message?: unknown } | null;
        console.error("[deepgram-token] upstream request failed", {
          status: response.status,
          errCode: typeof errorBody?.err_code === "string" ? errorBody.err_code : undefined,
          errMsg:
            typeof errorBody?.err_msg === "string"
              ? errorBody.err_msg
              : typeof errorBody?.message === "string"
                ? errorBody.message
                : typeof errorBody?.error === "string"
                  ? errorBody.error
                  : undefined,
        });
        return res.status(502).json({ error: "Deepgram token unavailable" });
      }

      const parsed = DeepgramTokenResponseSchema.safeParse(body);
      if (!parsed.success) {
        console.error("[deepgram-token] upstream response invalid", {
          status: response.status,
          issues: parsed.error.issues.map((issue) => issue.path.join(".") || issue.message),
        });
        return res.status(502).json({ error: "Deepgram token unavailable" });
      }

      return res.status(200).json({
        accessToken: parsed.data.access_token,
        expiresIn: parsed.data.expires_in,
      });
    } catch (error: any) {
      if (error instanceof DeepgramTimeoutError) {
        return res.status(504).json({ error: "Deepgram token request timed out" });
      }
      console.error("[deepgram-token] failed", { message: String(error?.message || error || "Unknown error") });
      return res.status(502).json({ error: "Deepgram token unavailable" });
    }
  });

  router.post(
    "/transcribe",
    authenticate("deepgram-transcribe", "Deepgram transcription unavailable"),
    express.raw({
      type: ["audio/wav", "audio/x-wav", "application/octet-stream"],
      limit: options.rawBodyLimit ?? "25mb",
    }),
    audioBodyErrorHandler,
    async (req: Request, res: Response) => {
      const audio = Buffer.isBuffer(req.body) ? req.body : null;
      if (!audio?.length) {
        return res.status(400).json({ error: "Audio data is required" });
      }

      const url = new URL("https://api.deepgram.com/v1/listen");
      url.searchParams.set("model", "nova-3");
      url.searchParams.set("language", "en");
      url.searchParams.set("punctuate", "true");
      url.searchParams.set("smart_format", "true");

      try {
        const { response, body } = await fetchJsonWithTimeout(
          fetchImpl,
          url,
          {
            method: "POST",
            headers: {
              Authorization: `Token ${options.apiKey}`,
              "Content-Type": "audio/wav",
            },
            body: audio,
          },
          transcriptionTimeoutMs
        );
        if (!response.ok) {
          const errorBody = body as { err_code?: unknown; err_msg?: unknown; message?: unknown } | null;
          console.error("[deepgram-transcribe] upstream request failed", {
            status: response.status,
            errCode: typeof errorBody?.err_code === "string" ? errorBody.err_code : undefined,
            errMsg:
              typeof errorBody?.err_msg === "string"
                ? errorBody.err_msg
                : typeof errorBody?.message === "string"
                  ? errorBody.message
                  : undefined,
          });
          return res.status(502).json({ error: "Deepgram transcription failed" });
        }

        const parsed = DeepgramTranscriptResponseSchema.safeParse(body);
        if (!parsed.success) {
          console.error("[deepgram-transcribe] upstream response invalid", {
            issues: parsed.error.issues.map((issue) => issue.path.join(".") || issue.message),
          });
          return res.status(502).json({ error: "Deepgram transcription response was invalid" });
        }

        return res.status(200).json({
          transcript: parsed.data.results.channels[0]?.alternatives[0]?.transcript.trim() || "",
        });
      } catch (error: any) {
        if (error instanceof DeepgramTimeoutError) {
          return res.status(504).json({ error: "Deepgram transcription request timed out" });
        }
        console.error("[deepgram-transcribe] failed", {
          message: String(error?.message || error || "Unknown error"),
        });
        return res.status(502).json({ error: "Deepgram transcription failed" });
      }
    }
  );

  return router;
}
