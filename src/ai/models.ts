export const AI_MODELS = {
  main: "gpt-5.6-terra",
  compact: "gpt-5.6-terra",
  goalGuidance: "gpt-5.6-terra",
  lightweight: "gpt-5.4-mini",
  webSearch: "gpt-5.2",
} as const;

export function getRouteModel(assistantMode?: "chat" | "compact") {
  return assistantMode === "compact" ? AI_MODELS.compact : AI_MODELS.main;
}
