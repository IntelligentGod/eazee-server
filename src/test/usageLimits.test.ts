import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import {
  AI_ACTIONS_EXHAUSTED_MESSAGE,
  createAiUsageLimitMiddleware,
  createUsageRouter,
  createVoiceUsageLimitMiddleware,
} from "../usage/usageLimits";
import { createMemoryUsageStore, getUsageDay } from "../usage/usageStore";

async function startApp(options: { enabled?: boolean; user?: any } = {}) {
  const store = createMemoryUsageStore();
  let user = options.user ?? { uid: "free-user", authTime: 0 };
  const limitOptions = {
    enabled: options.enabled ?? true,
    unlimitedEmails: ["developer_sandbox@eazee.ai"],
    store,
    verifyRequest: async () => user,
  };
  const app = express();
  app.use(express.json());
  app.use("/ai", createAiUsageLimitMiddleware(limitOptions));
  app.post("/ai/*", (_req, res) => res.json({ ok: true }));
  app.use("/deepgram", createVoiceUsageLimitMiddleware(limitOptions));
  app.post("/deepgram/token", (_req, res) => res.json({ accessToken: "token" }));
  app.use("/usage", createUsageRouter(limitOptions));

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-eazee-timezone": "America/New_York", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { server, store, post, setUser: (next: any) => { user = next; } };
}

test("the usage day follows the user's time zone", () => {
  const now = new Date("2026-10-01T02:00:00Z");
  assert.equal(getUsageDay("America/New_York", now), "2026-09-30");
  assert.equal(getUsageDay("Asia/Tokyo", now), "2026-10-01");
  assert.equal(getUsageDay("Not/AZone", now), "2026-10-01");
  assert.equal(getUsageDay(undefined, now), "2026-10-01");
});

test("free users get five AI actions a day, then a clear refusal", async () => {
  const { server, post } = await startApp();
  try {
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await post("/ai/route")).status, 200);
    }
    const refused = await post("/ai/route");
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: AI_ACTIONS_EXHAUSTED_MESSAGE, code: "AI_ACTIONS_EXHAUSTED" });
    assert.equal((await post("/ai/tools/result")).status, 200, "tool results finish an already-charged turn");
  } finally {
    server.close();
  }
});

test("titles and summaries are free, up to a daily cap", async () => {
  const { server, post, store } = await startApp();
  try {
    assert.equal((await post("/ai/route", { "x-eazee-ai-feature": "aiChatTitle" })).status, 200);
    assert.equal((await post("/ai/route", { "x-eazee-ai-feature": "aiChatSummary" })).status, 200);
    const day = getUsageDay("America/New_York");
    assert.deepEqual(await store.get("free-user", day), { aiActions: 0, voiceSeconds: 0, unchargedRequests: 2 });

    for (let index = 2; index < 40; index += 1) {
      await post("/ai/route", { "x-eazee-ai-feature": "aiChatTitle" });
    }
    await post("/ai/route", { "x-eazee-ai-feature": "aiChatTitle" });
    assert.equal((await store.get("free-user", day)).aiActions, 1, "past the cap they count as AI actions");
  } finally {
    server.close();
  }
});

test("Pro, the sandbox account, and a disabled switch are never metered", async () => {
  const pro = await startApp({ user: { uid: "pro", authTime: 0, proEntitlement: { plan: "yearly", expiresAt: Date.now() + 60_000 } } });
  const sandbox = await startApp({ user: { uid: "sandbox", authTime: 0, email: "developer_sandbox@eazee.ai" } });
  const disabled = await startApp({ enabled: false });
  try {
    for (let index = 0; index < 7; index += 1) {
      assert.equal((await pro.post("/ai/route")).status, 200);
      assert.equal((await sandbox.post("/ai/route")).status, 200);
      assert.equal((await disabled.post("/ai/route")).status, 200);
    }
  } finally {
    pro.server.close();
    sandbox.server.close();
    disabled.server.close();
  }
});

test("voice tokens stop once reported voice use reaches two minutes", async () => {
  const { server, post } = await startApp();
  try {
    assert.equal((await post("/deepgram/token")).status, 200);
    assert.equal((await post("/usage/voice", {}, { seconds: 90 })).status, 200);
    assert.equal((await post("/deepgram/token")).status, 200);
    assert.equal((await post("/usage/voice", {}, { seconds: 30 })).status, 200);

    const refused = await post("/deepgram/token");
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, "VOICE_EXHAUSTED");
    assert.equal((await post("/usage/voice", {}, { seconds: -5 })).status, 400);
  } finally {
    server.close();
  }
});
