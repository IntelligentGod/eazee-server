import { z } from "zod";
import type { ToolDef } from "./todo";
import { openaiWebSearch } from "../providers/openai";

export const WebSearchSchema = z.object({
  query: z.string().min(1).max(500),
});

export const WebSearchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "The exact web search query to use for current or external information.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

export const webSearchTools: ToolDef[] = [
  {
    name: "web_search",
    description:
      "Search the web for fresh or external information. Use this when the user explicitly asks to search the web or when answering requires current facts, public information, documentation, prices, reviews, weather, news, releases, or other information outside the user's app data. Never use this for the user's own todos, calendar, or other in-app data. Do not call this in the same turn as app tools.",
    mode: "server",
    schema: WebSearchSchema,
    parameters: WebSearchParameters,
  },
];

export async function executeWebSearchTool({ query }: z.infer<typeof WebSearchSchema>) {
  const cleanQuery = query.trim();
  const result = await openaiWebSearch({
    input: [
      "Search the web for the query below and return a concise factual summary.",
      "Do not include citations unless the user asks for them.",
      "",
      `Query: ${cleanQuery}`,
    ].join("\n"),
  });

  return {
    query: cleanQuery,
    summary: result.content,
  };
}
