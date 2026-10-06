import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import {
  aiActionsExhaustedMessage,
  createAiUsageLimitMiddleware,
  createGuidanceLimitMiddleware,
  createUsageRouter,
  createVoiceUsageLimitMiddleware,
} from "../usage/usageLimits";
import { EMPTY_USAGE, createMemoryUsageStore, getUsageDay } from "../usage/usageStore";
import {
  DEFAULT_SUBSCRIPTION_CONFIG,
  createMemoryConfigStore,
  createSubscriptionConfigProvider,
} from "../usage/limitsConfig";

async function startApp(options: { enabled?: boolean; user?: any; storedConfig?: unknown } = {}) {
  const store = createMemoryUsageStore();
  const config = createSubscriptionConfigProvider({ store: createMemoryConfigStore(options.storedConfig) });
  let user = options.user ?? { uid: "free-user", authTime: 0 };
  const limitOptions = {
    enabled: options.enabled ?? true,
    unlimitedEmails: ["developer_sandbox@eazee.ai"],
    store,
    config,
    verifyRequest: async () => user,
  };
  const app = express();
  app.use(express.json());
  app.use("/ai", createGuidanceLimitMiddleware(limitOptions), createAiUsageLimitMiddleware(limitOptions));
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
  return { server, store, config, post, setUser: (next: any) => { user = next; } };
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
    assert.deepEqual(await refused.json(), { error: aiActionsExhaustedMessage(5, false), code: "AI_ACTIONS_EXHAUSTED" });
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
    assert.deepEqual(await store.get("free-user", day), { ...EMPTY_USAGE, unchargedRequests: 2 });

    for (let index = 2; index < 40; index += 1) {
      await post("/ai/route", { "x-eazee-ai-feature": "aiChatTitle" });
    }
    await post("/ai/route", { "x-eazee-ai-feature": "aiChatTitle" });
    assert.equal((await store.get("free-user", day)).aiActions, 1, "past the cap they count as AI actions");
  } finally {
    server.close();
  }
});

test("Pro and the sandbox account are unlimited by default, and a disabled switch meters nothing", async () => {
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

const PRO_USER = { uid: "pro", authTime: 0, proEntitlement: { plan: "yearly", expiresAt: Date.now() + 60_000 } };
const withLimits = (free: Partial<typeof DEFAULT_SUBSCRIPTION_CONFIG.limits.free>, pro: Partial<typeof DEFAULT_SUBSCRIPTION_CONFIG.limits.pro> = {}) => ({
  limits: {
    free: { ...DEFAULT_SUBSCRIPTION_CONFIG.limits.free, ...free },
    pro: { ...DEFAULT_SUBSCRIPTION_CONFIG.limits.pro, ...pro },
  },
});

test("chat and voice limits come from config/subscription, for free and Pro", async () => {
  const free = await startApp({ storedConfig: withLimits({ chatMessagesPerDay: 2, voiceMinutesPerDay: 1 }) });
  const pro = await startApp({ user: PRO_USER, storedConfig: withLimits({}, { chatMessagesPerDay: 3 }) });
  try {
    assert.equal((await free.post("/ai/route")).status, 200);
    assert.equal((await free.post("/ai/route")).status, 200);
    const refused = await free.post("/ai/route");
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, aiActionsExhaustedMessage(2, false));

    await free.post("/usage/voice", {}, { seconds: 60 });
    assert.equal((await free.post("/deepgram/token")).status, 403, "one minute is the configured voice limit");

    for (let index = 0; index < 3; index += 1) {
      assert.equal((await pro.post("/ai/route")).status, 200);
    }
    const proRefused = await pro.post("/ai/route");
    assert.equal(proRefused.status, 403);
    assert.equal((await proRefused.json()).error, aiActionsExhaustedMessage(3, true));
  } finally {
    free.server.close();
    pro.server.close();
  }
});

test("an admin's new limit is enforced once the config is saved", async () => {
  const { server, post, config } = await startApp();
  try {
    for (let index = 0; index < 5; index += 1) await post("/ai/route");
    assert.equal((await post("/ai/route")).status, 403);
    await config.update(withLimits({ chatMessagesPerDay: 7 }), "admin@eazee.ai");
    assert.equal((await post("/ai/route")).status, 200);
    assert.equal((await post("/ai/route")).status, 200);
    assert.equal((await post("/ai/route")).status, 403);
  } finally {
    server.close();
  }
});

test("guidance is Pro-only for free by default, and counted per feature once allowed", async () => {
  const blocked = await startApp();
  const allowed = await startApp({ storedConfig: withLimits({ guidance: { goalGuidance: 1, taskGuidance: 0, recipeSkillGuide: 1, guidanceQuestions: 2 } }) });
  try {
    const refused = await blocked.post("/ai/goal-guidance");
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, "PRO_REQUIRED");

    assert.equal((await allowed.post("/ai/goal-guidance")).status, 200);
    const exhausted = await allowed.post("/ai/goal-guidance");
    assert.equal(exhausted.status, 403);
    assert.equal((await exhausted.json()).code, "GUIDANCE_LIMIT_REACHED");
    assert.equal((await allowed.post("/ai/task-guidance")).status, 403, "each feature has its own limit");

    assert.equal((await allowed.post("/ai/recipe/videos")).status, 200, "video search is allowed while a guide is left");
    assert.equal((await allowed.post("/ai/recipe/videos")).status, 200, "and is not counted");
    assert.equal((await allowed.post("/ai/recipe/generate")).status, 200);
    assert.equal((await allowed.post("/ai/skill/videos")).status, 403, "recipes and skills share one allowance");

    assert.equal((await allowed.post("/ai/guidance/answer")).status, 200);
    assert.equal((await allowed.post("/ai/recipe/answer")).status, 200);
    assert.equal((await allowed.post("/ai/skill/answer")).status, 403);

    const usage = await allowed.store.get("free-user", getUsageDay("America/New_York"));
    assert.equal(usage.guidanceGoal, 1);
    assert.equal(usage.guidanceRecipeSkill, 1);
    assert.equal(usage.guidanceQuestions, 2);
    assert.equal(usage.aiActions, 0, "guidance does not use the chat allowance");
  } finally {
    blocked.server.close();
    allowed.server.close();
  }
});

test("Pro guidance is unlimited by default and can be capped", async () => {
  const unlimited = await startApp({ user: PRO_USER });
  const capped = await startApp({ user: PRO_USER, storedConfig: withLimits({}, { guidance: { goalGuidance: 1, taskGuidance: null, recipeSkillGuide: null, guidanceQuestions: null } }) });
  try {
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await unlimited.post("/ai/goal-guidance")).status, 200);
    }
    assert.equal((await capped.post("/ai/goal-guidance")).status, 200);
    assert.equal((await capped.post("/ai/goal-guidance")).status, 403);
    assert.equal((await capped.post("/ai/task-guidance")).status, 200);
  } finally {
    unlimited.server.close();
    capped.server.close();
  }
});

test("free users get guidance on the tutorial's demo task and goal only", async () => {
  const { server, post, store } = await startApp();
  try {
    assert.equal((await post("/ai/task-guidance", {}, { title: "Pack for a weekend trip" })).status, 200);
    assert.equal((await post("/ai/goal-guidance", {}, { goalTitle: "Learn basic guitar" })).status, 200);
    assert.equal((await post("/ai/skill/videos", {}, { title: " learn BASIC guitar " })).status, 200);

    const other = await post("/ai/goal-guidance", {}, { goalTitle: "Learn piano" });
    assert.equal(other.status, 403);
    assert.equal((await other.json()).code, "PRO_REQUIRED");

    const usage = await store.get("free-user", getUsageDay("America/New_York"));
    assert.equal(usage.guidanceGoal, 0, "demo guidance is not counted");
  } finally {
    server.close();
  }
});
