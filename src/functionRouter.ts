import type { createSSEHub } from "./sse";
import type { OpenAIToolCall } from "./providers/openai";
import { validateToolCall } from "./tools/registry";

type Hub = ReturnType<typeof createSSEHub>;

export function createFunctionRouter(hub: Hub) {
  function routeToolCalls({
    clientId,
    toolCalls,
    clientRequestId,
  }: {
    clientId: string;
    toolCalls: OpenAIToolCall[];
    clientRequestId?: string;
  }) {
    const dispatched: Array<{ callId: string; name: string; mode: string; sent?: boolean }> = [];
    const errors: Array<{ callId?: string; name?: string; error: string }> = [];
    const normalizedCalls: Array<{ callId: string; name: string; arguments: unknown }> = [];

    for (const call of toolCalls || []) {
      const callId = call.id || "";
      const name = call.function?.name || "";
      const rawArgs = call.function?.arguments;
      let parsedArgs: unknown = rawArgs;
      try {
        // OpenAI sends arguments as a JSON string sometimes
        if (typeof rawArgs === "string") {
          parsedArgs = JSON.parse(rawArgs);
        }
      } catch (_err) {
        errors.push({ callId, name, error: "Invalid JSON in tool arguments" });
        continue;
      }

      const validation = validateToolCall(name, parsedArgs);
      if (!validation.ok) {
        errors.push({ callId, name, error: validation.error });
        // inform client of the validation error too
        hub.sendTo(clientId, "tool.validation_error", { callId, name, error: validation.error, clientRequestId, details: validation as any });
        continue;
      }

      const mode = validation.def.mode;
      normalizedCalls.push({ callId, name, arguments: validation.data });
      if (mode === "client") {
        // forward to specific client for local execution
        const sent = hub.sendTo(clientId, "tool.call", {
          callId,
          name,
          clientRequestId,
          arguments: validation.data,
        });
        try {
          // eslint-disable-next-line no-console
          console.log(`[router] tool.call name=${name} callId=${callId} sent=${!!sent} clientId=${clientId || "(none)"}`);
        } catch {}
        dispatched.push({ callId, name, mode, sent });
      } else if (mode === "server") {
        // Placeholder: implement server-side executors later
        hub.sendTo(clientId, "tool.server_not_implemented", { callId, name, clientRequestId });
        dispatched.push({ callId, name, mode, sent: false });
      } else {
        errors.push({ callId, name, error: `Unknown mode: ${mode}` });
      }
    }

    return { dispatched, errors, normalizedCalls };
  }

  return { routeToolCalls };
}

