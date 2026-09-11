import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

type QueuedMessage = {
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

const KOLKATA_TIME_CONTEXT = {
  role: "system",
  content: 'TimeContext: {"userTimezone":"Asia/Kolkata","nowLocal":"2026-06-12T04:40:00+05:30"}',
};

const NEW_YORK_TIME_CONTEXT = {
  role: "system",
  content: 'TimeContext: {"userTimezone":"America/New_York","nowLocal":"2026-01-10T09:00:00-05:00"}',
};

function calendarCreateCall(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "function" as const,
    function: {
      name: "calendar_create",
      arguments: JSON.stringify({
        title: "Meeting",
        start: "2026-06-12T19:00:00+05:30",
        end: "2026-06-12T20:00:00+05:30",
        resolution: { date: "next_occurrence", start: "user", end: "user" },
        ...overrides,
      }),
    },
  };
}

test("compact calendar trusts the router model with bounded mechanical checks", async () => {
  process.env.AI_AUTH_REQUIRED = "false";
  process.env.APP_CHECK_REQUIRED = "false";
  process.env.OPENAI_API_KEY = "test-key";

  const originalFetch = globalThis.fetch;
  const routeMessages: QueuedMessage[] = [];
  const routeRequestBodies: any[] = [];

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/chat/completions") {
      const requestBody = JSON.parse(String(init?.body || "{}"));
      routeRequestBodies.push(requestBody);
      const message = routeMessages.shift();
      assert.ok(message, "expected a queued OpenAI response");
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const { app, closeAppResources } = await import("../index");
  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });
  const address = server.address() as AddressInfo;
  const routeUrl = `http://127.0.0.1:${address.port}/ai/route`;
  const toolsRouteUrl = `http://127.0.0.1:${address.port}/ai/tools/route`;
  const postRoute = (body: Record<string, unknown>) => originalFetch(routeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    routeMessages.push({ content: "Hi! What would you like to do?" });
    let response = await postRoute({
      assistantMode: "compact",
      assistantSurface: "calendar",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(response.status, 200);
    let payload: any = await response.json();
    assert.equal(payload.status, "no_tool_calls");

    routeMessages.push({
      content: null,
      tool_calls: [{
        id: "open-calendar-search",
        type: "function",
        function: {
          name: "app_open_screen",
          arguments: JSON.stringify({ destination: "calendar_search" }),
        },
      }],
    });
    response = await postRoute({
      assistantMode: "compact",
      assistantSurface: "calendar",
      messages: [{ role: "user", content: "open calendar search" }],
    });
    assert.equal(response.status, 200);
    payload = await response.json();
    assert.equal(payload.toolCalls[0]?.name, "app_open_screen");

    routeMessages.push({
      content: null,
      tool_calls: [calendarCreateCall("missing-time-context")],
    });
    response = await postRoute({
      assistantMode: "compact",
      assistantSurface: "calendar",
      messages: [{ role: "user", content: "create meeting tomorrow 7-8pm" }],
    });
    assert.equal(response.status, 400);
    payload = await response.json();
    assert.match(payload.error, /valid TimeContext/);
    assert.equal(routeRequestBodies.length, 3);

    routeMessages.push(
      { content: "CLARIFY: Which day should I use?" },
      { content: null, tool_calls: [calendarCreateCall("no-date-retry")] }
    );
    const noDateRequestStart = routeRequestBodies.length;
    response = await postRoute({
      assistantMode: "compact",
      assistantSurface: "calendar",
      messages: [KOLKATA_TIME_CONTEXT, { role: "user", content: "create meeting 7-8pm" }],
    });
    assert.equal(response.status, 200);
    payload = await response.json();
    assert.equal(payload.toolCalls[0]?.name, "calendar_create");
    assert.equal(payload.toolCalls[0]?.arguments?.resolution, undefined);
    assert.match(
      routeRequestBodies[noDateRequestStart + 1]?.messages?.at(-1)?.content || "",
      /Review that clarification/
    );
    const compactCreateTool = routeRequestBodies[noDateRequestStart]?.tools?.find(
      (tool: any) => tool?.function?.name === "calendar_create"
    );
    assert.deepEqual(compactCreateTool?.function?.parameters?.required, ["title", "resolution"]);

    routeMessages.push({
      content: null,
      tool_calls: [calendarCreateCall("duration-follow-up", {
        start: "2026-06-13T07:00:00+05:30",
        end: undefined,
        resolution: {
          date: "exact",
          start: "user",
          end: "duration",
          durationMinutes: 60,
        },
      })],
    });
    response = await postRoute({
      assistantMode: "compact",
      assistantSurface: "calendar",
      messages: [
        KOLKATA_TIME_CONTEXT,
        { role: "user", content: "create meeting tomorrow at 7am" },
        { role: "assistant", content: "CLARIFY: What time should it end?" },
        { role: "user", content: "one hour" },
      ],
    });
    assert.equal(response.status, 200);
    payload = await response.json();
    assert.equal(payload.toolCalls[0]?.arguments?.start, "2026-06-13T07:00:00+05:30");
    assert.equal(payload.toolCalls[0]?.arguments?.end, "2026-06-13T02:30:00.000Z");

    routeMessages.push(
      {
        content: null,
        tool_calls: [calendarCreateCall("wrong-dst", {
          start: "2026-06-13T09:00:00-05:00",
          end: "2026-06-13T10:00:00-05:00",
          resolution: { date: "exact", start: "user", end: "user" },
        })],
      },
      {
        content: null,
        tool_calls: [calendarCreateCall("corrected-dst", {
          start: "2026-06-13T09:00:00-04:00",
          end: "2026-06-13T10:00:00-04:00",
          resolution: { date: "exact", start: "user", end: "user" },
        })],
      }
    );
    const dstRequestStart = routeRequestBodies.length;
    response = await postRoute({
      assistantMode: "compact",
      assistantSurface: "calendar",
      messages: [NEW_YORK_TIME_CONTEXT, { role: "user", content: "meeting June 13 from 9-10am" }],
    });
    assert.equal(response.status, 200);
    payload = await response.json();
    assert.equal(payload.toolCalls[0]?.arguments?.start, "2026-06-13T09:00:00-04:00");
    assert.match(
      routeRequestBodies[dstRequestStart + 1]?.messages?.at(-1)?.content || "",
      /daylight-saving changes/
    );

    routeMessages.push({
      content: null,
      tool_calls: [
        calendarCreateCall("batch-one", {
          title: "Breakfast",
          start: "2026-06-13T07:00:00+05:30",
          end: "2026-06-13T08:00:00+05:30",
          resolution: { date: "exact", start: "user", end: "user" },
        }),
        calendarCreateCall("batch-two", {
          title: "Dentist",
          start: "2026-06-13T09:00:00+05:30",
          end: "2026-06-13T10:00:00+05:30",
          resolution: { date: "exact", start: "user", end: "user" },
        }),
      ],
    });
    const batchRequestStart = routeRequestBodies.length;
    response = await postRoute({
      assistantMode: "compact",
      assistantSurface: "calendar",
      messages: [
        KOLKATA_TIME_CONTEXT,
        { role: "user", content: "breakfast tomorrow 7-8am and dentist tomorrow 9-10am" },
      ],
    });
    assert.equal(response.status, 200);
    payload = await response.json();
    assert.equal(payload.toolCalls.length, 2);
    assert.equal(routeRequestBodies.length - batchRequestStart, 1);

    routeMessages.push({
      content: null,
      tool_calls: Array.from({ length: 6 }, (_, index) => calendarCreateCall(`batch-${index}`, {
        title: `Event ${index + 1}`,
        start: `2026-06-${String(index + 13).padStart(2, "0")}T09:00:00+05:30`,
        end: `2026-06-${String(index + 13).padStart(2, "0")}T10:00:00+05:30`,
        resolution: { date: "exact", start: "user", end: "user" },
      })),
    });
    response = await postRoute({
      assistantMode: "compact",
      assistantSurface: "calendar",
      messages: [KOLKATA_TIME_CONTEXT, { role: "user", content: "create these six events" }],
    });
    assert.equal(response.status, 200);
    payload = await response.json();
    assert.equal(payload.status, "no_tool_calls");
    assert.match(payload.meta?.assistantText || "", /up to 5 events/);

    routeMessages.push({
      content: null,
      tool_calls: [calendarCreateCall("normal-route", {
        start: "2099-06-13T19:00:00+05:30",
        end: "2099-06-13T20:00:00+05:30",
      })],
    });
    response = await postRoute({
      assistantMode: "chat",
      assistantSurface: "calendar",
      messages: [{ role: "user", content: "create a meeting in 2099" }],
    });
    assert.equal(response.status, 200);
    payload = await response.json();
    assert.equal(payload.toolCalls[0]?.name, "calendar_create");

    response = await originalFetch(toolsRouteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "calendar_create",
        arguments: {
          title: "Meeting",
          start: "2099-06-13T19:00:00+05:30",
          resolution: { date: "exact", start: "user", end: "duration", durationMinutes: 60 },
        },
      }),
    });
    assert.equal(response.status, 400);

    response = await originalFetch(toolsRouteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "calendar_create",
        arguments: {
          title: "Meeting",
          start: "2099-06-13T19:00:00+05:30",
          end: "2099-06-13T20:00:00+05:30",
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(routeMessages.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeAppResources();
    globalThis.fetch = originalFetch;
  }
});
