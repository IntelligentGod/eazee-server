import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createFirstChatAnalyticsRouter, createMemoryFirstChatAnalyticsStore } from "../analytics/firstChat";
import { getUsageDay } from "../usage/usageStore";

async function startApp(user: unknown = { uid: "u1", authTime: 0 }) {
  const store = createMemoryFirstChatAnalyticsStore();
  const app = express();
  app.use(express.json());
  app.use("/analytics", createFirstChatAnalyticsRouter({ store, verifyRequest: async () => user as any }));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => fetch(`${url}/analytics/first-chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eazee-timezone": "UTC" },
    body: JSON.stringify(body),
  });
  return { server, store, post };
}

test("first-chat events add to daily counters, split by their properties", async () => {
  const { server, store, post } = await startApp();
  try {
    assert.equal((await post({ event: "starter_selected", props: { intent: "write" } })).status, 202);
    assert.equal((await post({ event: "starter_selected", props: { intent: "write" } })).status, 202);
    assert.equal((await post({ event: "result_delivered", props: { intent: "write", replies: 2, kind: "draft" } })).status, 202);
    assert.equal((await post({ event: "dismissed" })).status, 202);

    const counts = store.days.get(getUsageDay("UTC"));
    assert.equal(counts?.starter_selected, 2);
    assert.equal(counts?.starter_selected__intent_write, 2);
    assert.equal(counts?.result_delivered__replies_total, 2);
    assert.equal(counts?.result_delivered__kind_draft, 1);
    assert.equal(counts?.dismissed, 1);
  } finally {
    server.close();
  }
});

test("first-chat events never accept free text, and need a signed-in user", async () => {
  const { server, post } = await startApp();
  const anonymous = await startApp(null);
  try {
    assert.equal((await post({ event: "starter_selected", props: { intent: "write", text: "my CV" } })).status, 400);
    assert.equal((await post({ event: "result_used", props: { kind: "my secret goal" } })).status, 400);
    assert.equal((await post({ event: "something_else" })).status, 400);
    assert.equal((await anonymous.post({ event: "dismissed" })).status, 401);
  } finally {
    server.close();
    anonymous.server.close();
  }
});
