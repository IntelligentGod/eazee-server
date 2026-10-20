import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import {
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

test("AI chat is unlimited on every plan, and still counted", async () => {
  const { server, post, store } = await startApp();
  try {
    for (let index = 0; index < 12; index += 1) {
      assert.equal((await post("/ai/route")).status, 200);
    }
    assert.equal((await store.get("free-user", getUsageDay("America/New_York"))).aiActions, 12, "use is still recorded for the admin");
    assert.equal((await post("/ai/tools/result")).status, 200);
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

test("voice input is unlimited on every plan", async () => {
  const { server, post } = await startApp();
  try {
    assert.equal((await post("/usage/voice", {}, { seconds: 120 })).status, 200);
    assert.equal((await post("/usage/voice", {}, { seconds: 120 })).status, 200);
    assert.equal((await post("/deepgram/token")).status, 200);
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

test("an old saved chat or voice limit is ignored", async () => {
  const free = await startApp({ storedConfig: withLimits({ chatMessagesPerDay: 2, voiceMinutesPerDay: 1 }) });
  try {
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await free.post("/ai/route")).status, 200);
    }
    await free.post("/usage/voice", {}, { seconds: 120 });
    assert.equal((await free.post("/deepgram/token")).status, 200);
  } finally {
    free.server.close();
  }
});

test("guidance is unlimited on every plan, and an old saved guidance limit is ignored", async () => {
  const free = await startApp({ storedConfig: withLimits({ guidance: { goalGuidance: 0, taskGuidance: 0, recipeSkillGuide: 0, guidanceQuestions: 0 } }) });
  const pro = await startApp({ user: PRO_USER, storedConfig: withLimits({}, { guidance: { goalGuidance: 1, taskGuidance: 1, recipeSkillGuide: 1, guidanceQuestions: 1 } }) });
  try {
    for (const app of [free, pro]) {
      for (let index = 0; index < 3; index += 1) {
        assert.equal((await app.post("/ai/goal-guidance", {}, { goalTitle: "Learn piano" })).status, 200);
        assert.equal((await app.post("/ai/task-guidance", {}, { title: "Fix the sink" })).status, 200);
        assert.equal((await app.post("/ai/recipe/generate")).status, 200);
        assert.equal((await app.post("/ai/skill/videos")).status, 200);
        assert.equal((await app.post("/ai/guidance/answer")).status, 200);
      }
    }
    const usage = await free.store.get("free-user", getUsageDay("America/New_York"));
    assert.equal(usage.aiActions, 0, "guidance does not use the chat allowance");
    assert.equal(usage.aiItemActions, 0, "guidance is not an AI action");
  } finally {
    free.server.close();
    pro.server.close();
  }
});

test("free users get 8 AI actions a day: a big request gets what is left, failures are given back", async () => {
  const { server, post } = await startApp();
  try {
    const reserve = async (count: number) => (await post("/usage/ai-actions/reserve", {}, { count })).json();
    assert.deepEqual(await reserve(5), { granted: 5, used: 5, limit: 8, remaining: 3 });
    assert.deepEqual(await reserve(5), { granted: 3, used: 8, limit: 8, remaining: 0 }, "only what is left");
    assert.deepEqual(await reserve(1), { granted: 0, used: 8, limit: 8, remaining: 0 });

    const released = await (await post("/usage/ai-actions/release", {}, { count: 2 })).json();
    assert.deepEqual(released, { granted: 0, used: 6, limit: 8, remaining: 2 });
    await post("/usage/ai-actions/release", {}, { count: 50 });
    assert.equal((await reserve(1)).used, 1, "release never goes below zero");

    assert.equal((await post("/usage/ai-actions/reserve", {}, { count: 0 })).status, 400);
  } finally {
    server.close();
  }
});

test("AI actions are counted per day in the user's time zone", async () => {
  const { server, post, store } = await startApp();
  try {
    await post("/usage/ai-actions/reserve", {}, { count: 8 });
    const tokyo = await (await post("/usage/ai-actions/reserve", { "x-eazee-timezone": "Asia/Tokyo" }, { count: 1 })).json();
    const sameDay = getUsageDay("Asia/Tokyo") === getUsageDay("America/New_York");
    assert.equal(tokyo.granted, sameDay ? 0 : 1);
    assert.equal((await store.get("free-user", getUsageDay("America/New_York"))).aiItemActions, 8);
  } finally {
    server.close();
  }
});

test("Pro AI actions are unlimited by default, the admin can set limits, and a disabled switch meters nothing", async () => {
  const pro = await startApp({ user: PRO_USER });
  const configured = await startApp({ storedConfig: withLimits({ aiActionsPerDay: 2 }) });
  const disabled = await startApp({ enabled: false });
  try {
    assert.deepEqual(await (await pro.post("/usage/ai-actions/reserve", {}, { count: 100 })).json(), { granted: 100, used: 100, limit: null, remaining: null });
    assert.equal((await (await configured.post("/usage/ai-actions/reserve", {}, { count: 5 })).json()).granted, 2);
    assert.deepEqual(await (await disabled.post("/usage/ai-actions/reserve", {}, { count: 20 })).json(), { granted: 20, used: 0, limit: null, remaining: null });
  } finally {
    pro.server.close();
    configured.server.close();
    disabled.server.close();
  }
});

test("AI actions need a signed-in user", async () => {
  const { server, post, setUser } = await startApp();
  try {
    setUser(null);
    assert.equal((await post("/usage/ai-actions/reserve", {}, { count: 1 })).status, 401);
    assert.equal((await post("/usage/ai-actions/release", {}, { count: 1 })).status, 401);
  } finally {
    server.close();
  }
});
