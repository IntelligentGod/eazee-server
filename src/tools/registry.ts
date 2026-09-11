import { z } from "zod";
import { todoTools, dateTools, ToolDef } from "./todo";
import { calendarTools } from "./calendar";
import { googleTools } from "./google";
// import { noteTools } from "./note";
import { overviewTools } from "./overview";
import { webSearchTools } from "./webSearch";
import { guidanceTools } from "./guidance";
import { appNavigationTools } from "./appNavigation";

export const allTools: ToolDef[] = [...appNavigationTools, ...todoTools, ...dateTools, ...guidanceTools, ...calendarTools, ...googleTools, ...overviewTools, ...webSearchTools];

function toOpenAIToolDefs(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function getOpenAIToolDefs() {
  return toOpenAIToolDefs(allTools);
}

export function getOpenAIToolDefsByNames(names: string[]) {
  const wanted = new Set((Array.isArray(names) ? names : []).filter(Boolean));
  const tools = allTools.filter((tool) => wanted.has(tool.name));
  return toOpenAIToolDefs(tools);
}

export function getToolByName(name: string): ToolDef | undefined {
  return allTools.find((t) => t.name === name);
}

export function validateToolCall(name: string, args: unknown) {
  const def = getToolByName(name);
  if (!def) {
    return { ok: false, error: `Unknown tool: ${name}` } as const;
  }
  const parse = (def.schema as z.ZodTypeAny).safeParse(args);
  if (!parse.success) {
    return { ok: false, error: "Invalid arguments", details: parse.error.flatten() } as const;
  }
  return { ok: true, def, data: parse.data } as const;
}
