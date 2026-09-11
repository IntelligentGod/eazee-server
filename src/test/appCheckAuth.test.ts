import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createAppCheckMiddleware } from "../auth/appCheck";

async function startServer(options: Parameters<typeof createAppCheckMiddleware>[0]) {
  const app = express();
  app.use(createAppCheckMiddleware(options));
  app.get("/protected", (_req, res) => res.status(200).json({ ok: true }));

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

test("App Check rejects missing tokens when enforcement is enabled", async () => {
  const server = await startServer({
    required: true,
    allowedAppIds: ["ios-app"],
    verifyToken: async () => ({ appId: "ios-app" }),
  });

  try {
    const response = await fetch(`${server.baseUrl}/protected`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "App verification required" });
  } finally {
    await server.close();
  }
});

test("App Check accepts verified tokens from an allowed app", async () => {
  const server = await startServer({
    required: true,
    allowedAppIds: ["ios-app", "android-app"],
    verifyToken: async (token) => {
      assert.equal(token, "valid-token");
      return { appId: "android-app" };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: { "X-Firebase-AppCheck": "valid-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await server.close();
  }
});

test("App Check rejects tokens from a different Firebase app", async () => {
  const server = await startServer({
    required: true,
    allowedAppIds: ["wave-app"],
    verifyToken: async () => ({ appId: "other-app" }),
  });

  try {
    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: { "X-Firebase-AppCheck": "valid-other-token" },
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("App Check permits tokenless requests before enforcement is enabled", async () => {
  const server = await startServer({
    required: false,
    allowedAppIds: [],
    verifyToken: async () => ({ appId: "wave-app" }),
  });

  try {
    const response = await fetch(`${server.baseUrl}/protected`);
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("App Check ignores invalid supplied tokens before enforcement is enabled", async () => {
  let verificationAttempted = false;
  const server = await startServer({
    required: false,
    allowedAppIds: ["wave-app"],
    verifyToken: async () => {
      verificationAttempted = true;
      throw new Error("invalid token");
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: { "X-Firebase-AppCheck": "invalid-token" },
    });
    assert.equal(response.status, 200);
    assert.equal(verificationAttempted, false);
  } finally {
    await server.close();
  }
});

test("App Check ignores disallowed supplied tokens before enforcement is enabled", async () => {
  let verificationAttempted = false;
  const server = await startServer({
    required: false,
    allowedAppIds: ["wave-app"],
    verifyToken: async () => {
      verificationAttempted = true;
      return { appId: "other-app" };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: { "X-Firebase-AppCheck": "other-app-token" },
    });
    assert.equal(response.status, 200);
    assert.equal(verificationAttempted, false);
  } finally {
    await server.close();
  }
});

test("App Check fails closed when enforcement has no app allowlist", async () => {
  const server = await startServer({
    required: true,
    allowedAppIds: [],
    verifyToken: async () => ({ appId: "wave-app" }),
  });

  try {
    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: { "X-Firebase-AppCheck": "valid-token" },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "App verification unavailable" });
  } finally {
    await server.close();
  }
});
