import { getConfig } from "../config";
import { AI_MODELS } from "../ai/models";

export type ChatRole = "system" | "user" | "assistant" | "tool";
export type ChatMessage = {
  role: ChatRole;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
};

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: any; // JSON Schema
  };
};

export type OpenAIToolCall = {
  id?: string;
  type: string;
  function?: {
    name: string;
    arguments: string | any;
  };
};

export type OpenAIChatResult = {
  message: {
    role?: string;
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  toolCalls: OpenAIToolCall[];
  raw?: any;
};

export type OpenAIWebSearchResult = {
  content: string;
  raw?: any;
};

const WEB_SEARCH_TIMEOUT_MS = 45000;
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

function getTokenLimitPayload(model: string, maxTokens?: number) {
  if (maxTokens === undefined) {
    return {};
  }

  return model.startsWith("gpt-5")
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function getTemperaturePayload(model: string, temperature?: number) {
  if (temperature === undefined || model.startsWith("gpt-5")) {
    return {};
  }

  return { temperature };
}

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

function getReasoningEffortPayload(
  model: string,
  hasTools: boolean,
  reasoningEffort?: ReasoningEffort
) {
  if (!model.startsWith("gpt-5.6")) {
    return {};
  }

  if (reasoningEffort) {
    return { reasoning_effort: reasoningEffort };
  }

  return hasTools ? { reasoning_effort: "none" as const } : {};
}

function getChatCompletionTarget() {
  const { openaiApiKey } = getConfig();
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return {
    apiKey: openaiApiKey,
    url: OPENAI_CHAT_COMPLETIONS_URL,
    providerLabel: "OpenAI",
  };
}

type ChatArgs = {
  messages: ChatMessage[];
  model?: string;
  tools?: ToolDef[];
  toolChoice?: "auto" | { type: "function"; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  signal?: any;
};

export async function openaiChat({
  messages,
  model = AI_MODELS.main,
  tools,
  toolChoice = "auto",
  temperature,
  maxTokens,
  reasoningEffort,
  signal,
}: ChatArgs) {
  const target = getChatCompletionTarget();

  const hasTools = Array.isArray(tools) && tools.length > 0;
  const tokenLimitPayload = getTokenLimitPayload(model, maxTokens);
  const temperaturePayload = getTemperaturePayload(model, temperature);
  const reasoningEffortPayload = getReasoningEffortPayload(model, hasTools, reasoningEffort);
  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      ...(hasTools ? { tools, tool_choice: toolChoice } : {}),
      ...reasoningEffortPayload,
      ...temperaturePayload,
      ...tokenLimitPayload,
      store: false,
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${target.providerLabel} request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const msg = data?.choices?.[0]?.message ?? {};
  return {
    message: msg,
    toolCalls: msg.tool_calls ?? [],
    raw: data,
  } satisfies OpenAIChatResult;
}

export async function openaiWebSearch({
  input,
  model = AI_MODELS.webSearch,
  signal,
}: {
  input: string;
  model?: string;
  signal?: any;
}): Promise<OpenAIWebSearchResult> {
  const { openaiApiKey } = getConfig();
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("WEB_SEARCH_TIMEOUT")), WEB_SEARCH_TIMEOUT_MS);

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeout);
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
  }

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        input,
        store: false,
      }),
      signal: controller.signal,
    });
  } catch (error: any) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new Error("OpenAI web search timed out");
    }
    throw error;
  }

  clearTimeout(timeout);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI web search failed: ${response.status} ${text}`);
  }

  const data = await response.json();

  const output = Array.isArray(data?.output) ? data.output : [];
  const content = output
    .filter((item: any) => item?.type === "message")
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .filter((block: any) => block?.type === "output_text" && typeof block?.text === "string")
    .map((block: any) => block.text.trim())
    .join("\n\n")
    .trim();

  console.log("[openaiWebSearch] extracted", JSON.stringify({ model, status: data?.status, outputTypes: output.map((o: any) => o?.type), contentLength: content.length }));

  if (!content) {
    throw new Error("OpenAI web search returned an empty response");
  }

  return {
    content,
    raw: data,
  };
}

export async function openaiChatStream({
  messages,
  model = AI_MODELS.main,
  tools,
  toolChoice = "auto",
  temperature,
  maxTokens,
  reasoningEffort,
  signal,
  onContentDelta,
}: ChatArgs & {
  onContentDelta?: (delta: string) => void;
}): Promise<OpenAIChatResult> {
  const target = getChatCompletionTarget();

  const hasTools = Array.isArray(tools) && tools.length > 0;
  const tokenLimitPayload = getTokenLimitPayload(model, maxTokens);
  const temperaturePayload = getTemperaturePayload(model, temperature);
  const reasoningEffortPayload = getReasoningEffortPayload(model, hasTools, reasoningEffort);
  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      ...(hasTools ? { tools, tool_choice: toolChoice } : {}),
      ...reasoningEffortPayload,
      ...temperaturePayload,
      ...tokenLimitPayload,
      store: false,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${target.providerLabel} request failed: ${response.status} ${text}`);
  }

  if (!response.body) {
    throw new Error("OpenAI streaming response did not include a body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCallsByIndex = new Map<number, OpenAIToolCall>();

  const mergeToolCalls = (deltaToolCalls: any[]) => {
    for (const entry of deltaToolCalls) {
      const index = typeof entry?.index === "number" ? entry.index : 0;
      const current = toolCallsByIndex.get(index) || {
        id: "",
        type: "function",
        function: {
          name: "",
          arguments: "",
        },
      };

      if (typeof entry?.id === "string" && entry.id) {
        current.id = entry.id;
      }
      if (typeof entry?.type === "string" && entry.type) {
        current.type = entry.type;
      }
      if (entry?.function) {
        current.function = current.function || { name: "", arguments: "" };
        if (typeof entry.function.name === "string" && entry.function.name) {
          current.function.name += entry.function.name;
        }
        if (typeof entry.function.arguments === "string" && entry.function.arguments) {
          current.function.arguments += entry.function.arguments;
        }
      }

      toolCallsByIndex.set(index, current);
    }
  };

  const processEventBlock = (eventBlock: string) => {
    const dataLines = eventBlock
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (!dataLines.length) {
      return false;
    }

    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      return true;
    }

    const parsed = JSON.parse(payload);
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta;

    if (typeof delta?.content === "string" && delta.content) {
      content += delta.content;
      onContentDelta?.(delta.content);
    }

    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
      mergeToolCalls(delta.tool_calls);
    }

    return false;
  };

  let streamEnded = false;
  let receivedDoneEvent = false;
  while (!streamEnded && !receivedDoneEvent) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      streamEnded = true;
    } else {
      buffer += decoder.decode(value, { stream: true });
    }

    const normalized = buffer.replace(/\r\n/g, "\n");
    const eventBlocks = normalized.split("\n\n");
    buffer = eventBlocks.pop() || "";

    for (const eventBlock of eventBlocks) {
      if (processEventBlock(eventBlock)) {
        receivedDoneEvent = true;
        break;
      }
    }
  }

  const trailingBlock = buffer.replace(/\r\n/g, "\n").trim();
  if (!receivedDoneEvent && trailingBlock) {
    processEventBlock(trailingBlock);
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call);

  return {
    message: {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    toolCalls,
  };
}
