import test from "node:test";
import assert from "node:assert/strict";
import { openaiChat, openaiChatStream, openaiWebSearch } from "../providers/openai";

test("chat requests use the direct OpenAI endpoint and main model by default", async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let requestUrl = "";
  let requestBody: any;
  process.env.OPENAI_API_KEY = "test-openai-key";
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Done" } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await openaiChat({
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0,
    });
    assert.equal(requestUrl, "https://api.openai.com/v1/chat/completions");
    assert.equal(requestBody.model, "gpt-5.6-terra");
    assert.equal("reasoning_effort" in requestBody, false);
    assert.equal("temperature" in requestBody, false);
    assert.equal(requestBody.store, false);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("non-streaming GPT-5.6 function tools disable reasoning", async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let requestBody: any;
  process.env.OPENAI_API_KEY = "test-openai-key";
  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", tool_calls: [] } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await openaiChat({
      messages: [{ role: "user", content: "Create a meeting" }],
      tools: [{
        type: "function",
        function: {
          name: "calendar_create",
          parameters: { type: "object" },
        },
      }],
    });

    assert.equal(requestBody.model, "gpt-5.6-terra");
    assert.equal(requestBody.reasoning_effort, "none");
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("non-streaming GPT-5.6 requests accept explicit reasoning effort", async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let requestBody: any;
  process.env.OPENAI_API_KEY = "test-openai-key";
  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: '{"steps":[]}' } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await openaiChat({
      messages: [{ role: "user", content: "Plan this goal" }],
      reasoningEffort: "low",
      maxTokens: 8000,
    });

    assert.equal(requestBody.model, "gpt-5.6-terra");
    assert.equal(requestBody.reasoning_effort, "low");
    assert.equal(requestBody.max_completion_tokens, 8000);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("streaming chat uses direct OpenAI and merges content and tool-call deltas", async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let requestUrl = "";
  let requestBody: any;
  const contentDeltas: string[] = [];
  process.env.OPENAI_API_KEY = "test-openai-key";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"calendar_","arguments":"{\\"title\\":"}}]}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"create","arguments":"\\"Meet\\"}"}}]}}]}'));
      controller.close();
    },
  });

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    const result = await openaiChatStream({
      messages: [{ role: "user", content: "Create a meeting" }],
      temperature: 0,
      maxTokens: 300,
      tools: [{
        type: "function",
        function: {
          name: "calendar_create",
          parameters: { type: "object" },
        },
      }],
      onContentDelta: (delta) => contentDeltas.push(delta),
    });

    assert.equal(requestUrl, "https://api.openai.com/v1/chat/completions");
    assert.equal(requestBody.model, "gpt-5.6-terra");
    assert.equal(requestBody.stream, true);
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.reasoning_effort, "none");
    assert.equal(requestBody.max_completion_tokens, 300);
    assert.equal("temperature" in requestBody, false);
    assert.deepEqual(contentDeltas, ["Hello ", "world"]);
    assert.equal(result.message.content, "Hello world");
    assert.deepEqual(result.toolCalls, [{
      id: "call-1",
      type: "function",
      function: {
        name: "calendar_create",
        arguments: '{"title":"Meet"}',
      },
    }]);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("web search disables Responses API storage", async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let requestBody: any;
  process.env.OPENAI_API_KEY = "test-openai-key";
  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "Result" }] }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await openaiWebSearch({ input: "current result" });
    assert.equal(requestBody.model, "gpt-5.2");
    assert.equal(requestBody.store, false);
    assert.deepEqual(requestBody.tools, [{ type: "web_search" }]);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  }
});
