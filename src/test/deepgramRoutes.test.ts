import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createDeepgramRouter } from "../deepgram";

const authenticatedUser = {
  uid: "test-user",
  authTime: Math.floor(Date.now() / 1000),
};

const verifyRequest = async () => authenticatedUser;

const abortingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const rejectWithAbort = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };

    if (init?.signal?.aborted) {
      rejectWithAbort();
      return;
    }
    init?.signal?.addEventListener("abort", rejectWithAbort, { once: true });
  })) as typeof fetch;

async function startServer(router: express.Router) {
  const app = express();
  app.use("/deepgram", router);
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error?.message || "Internal Server Error" });
  });

  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test("Deepgram transcription rejects oversized audio with stable 413 response", async () => {
  const server = await startServer(createDeepgramRouter({
    apiKey: "test-key",
    verifyRequest,
    rawBodyLimit: "8b",
  }));

  try {
    const response = await fetch(`${server.baseUrl}/deepgram/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.alloc(9),
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "Audio file too large" });
  } finally {
    await server.close();
  }
});

test("Deepgram token route returns 504 when upstream request times out", async () => {
  const server = await startServer(createDeepgramRouter({
    apiKey: "test-key",
    verifyRequest,
    fetchImpl: abortingFetch,
    tokenTimeoutMs: 5,
  }));

  try {
    const response = await fetch(`${server.baseUrl}/deepgram/token`, { method: "POST" });

    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: "Deepgram token request timed out" });
  } finally {
    await server.close();
  }
});

test("Deepgram transcription route returns 504 when upstream request times out", async () => {
  const server = await startServer(createDeepgramRouter({
    apiKey: "test-key",
    verifyRequest,
    fetchImpl: abortingFetch,
    transcriptionTimeoutMs: 5,
  }));

  try {
    const response = await fetch(`${server.baseUrl}/deepgram/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from("wave-data"),
    });

    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: "Deepgram transcription request timed out" });
  } finally {
    await server.close();
  }
});
