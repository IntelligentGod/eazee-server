import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createAiAuthMiddleware } from "../auth/ai";

type VerifyCall = {
  path: string;
  checkRevoked?: boolean;
};

async function startServer(options: {
  aiAuthRequired: boolean;
  verifyRequest?: Parameters<typeof createAiAuthMiddleware>[0]["verifyRequest"];
}) {
  const app = express();
  app.use("/ai", createAiAuthMiddleware(options));
  app.post("/ai/chat", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/ai/tools", (_req, res) => res.status(200).json({ tools: [] }));

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

test("AI auth middleware rejects missing auth by default", async () => {
  const calls: VerifyCall[] = [];
  const server = await startServer({
    aiAuthRequired: true,
    verifyRequest: async (req, options) => {
      calls.push({ path: req.path, checkRevoked: options?.checkRevoked });
      return null;
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/ai/chat`, { method: "POST" });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
    assert.deepEqual(calls, [{ path: "/chat", checkRevoked: true }]);
  } finally {
    await server.close();
  }
});

test("AI auth middleware applies to all AI routes", async () => {
  const server = await startServer({
    aiAuthRequired: true,
    verifyRequest: async () => null,
  });

  try {
    const response = await fetch(`${server.baseUrl}/ai/tools`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
  } finally {
    await server.close();
  }
});

test("AI auth middleware can be disabled by backend config", async () => {
  let verifyCount = 0;
  const server = await startServer({
    aiAuthRequired: false,
    verifyRequest: async () => {
      verifyCount += 1;
      return null;
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/ai/chat`, { method: "POST" });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(verifyCount, 0);
  } finally {
    await server.close();
  }
});
