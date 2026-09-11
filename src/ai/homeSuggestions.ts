import { z } from "zod";
import type { ChatMessage } from "../providers/openai";

const HomeSuggestionProgressSchema = z.object({
  completed: z.number().int().min(0).max(10000),
  total: z.number().int().min(1).max(10000),
});

export const HomeSuggestionCandidateSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["goal", "skillGuide", "taskGuide", "overdue"]),
  openTodoId: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  details: z.string().max(2000).optional(),
  dueDate: z.string().max(100).optional(),
  plannedDurationMinutes: z.number().min(1).max(480).optional(),
  starred: z.boolean().optional(),
  progress: HomeSuggestionProgressSchema.optional(),
  activeTodoIds: z.array(z.string().min(1).max(200)).max(12).optional(),
});

const HomeSuggestionTodayTaskSchema = z.object({
  title: z.string().min(1).max(300),
  details: z.string().max(2000).optional(),
  dueDate: z.string().max(100).optional(),
  plannedDurationMinutes: z.number().min(1).max(480).optional(),
  starred: z.boolean().optional(),
  overdue: z.boolean().optional(),
});

const HomeSuggestionCalendarItemSchema = z.object({
  title: z.string().min(1).max(300),
  start: z.string().min(1).max(100),
  end: z.string().min(1).max(100),
});

export const HomeSuggestionsRequestSchema = z.object({
  candidates: z.array(HomeSuggestionCandidateSchema).min(1).max(40),
  freeWindow: z.object({
    start: z.string().min(1).max(100),
    end: z.string().min(1).max(100),
  }),
  today: z.object({
    tasks: z.array(HomeSuggestionTodayTaskSchema).max(80),
    calendar: z.array(HomeSuggestionCalendarItemSchema).max(80),
  }),
  userTimezone: z.string().max(100).optional().default("UTC"),
  locale: z.string().max(100).optional().default("en-US"),
});

const RawHomeSuggestionSchema = z.object({
  candidateId: z.string().min(1).max(200),
  title: z.string().min(1).max(120).optional(),
  reason: z.string().min(1).max(160),
  confidence: z.preprocess(
    (value) => {
      const confidence = Number(value);
      return Number.isFinite(confidence) ? Math.max(0, Math.min(confidence, 1)) : 0;
    },
    z.number().min(0).max(1)
  ),
});

export const HomeSuggestionsResponseSchema = z.object({
  suggestions: z.array(RawHomeSuggestionSchema).max(3).default([]),
});

export type HomeSuggestionsRequest = z.infer<typeof HomeSuggestionsRequestSchema>;
export type HomeSuggestionsResponse = z.infer<typeof HomeSuggestionsResponseSchema>;

const normalizeText = (value: string) => value.trim().replace(/\s+/g, " ");

export function normalizeHomeSuggestionsResponse(
  value: unknown,
  candidates: HomeSuggestionsRequest["candidates"]
): HomeSuggestionsResponse {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const rawSuggestions = Array.isArray((value as any)?.suggestions) ? (value as any).suggestions : [];
  const suggestions: HomeSuggestionsResponse["suggestions"] = [];
  const seen = new Set<string>();

  for (const rawSuggestion of rawSuggestions) {
    const parsed = RawHomeSuggestionSchema.safeParse(rawSuggestion);
    if (!parsed.success || seen.has(parsed.data.candidateId)) {
      continue;
    }
    const candidate = candidatesById.get(parsed.data.candidateId);
    if (!candidate) {
      continue;
    }

    seen.add(candidate.id);
    suggestions.push({
      candidateId: candidate.id,
      title: candidate.kind === "goal"
        ? candidate.title
        : normalizeText(parsed.data.title || candidate.title),
      reason: normalizeText(parsed.data.reason),
      confidence: parsed.data.confidence,
    });

    if (suggestions.length >= 3) {
      break;
    }
  }

  return { suggestions };
}

export function buildFallbackHomeSuggestions(
  candidates: HomeSuggestionsRequest["candidates"]
): HomeSuggestionsResponse {
  const progressCandidate = candidates.find((candidate) =>
    candidate.kind === "goal" || candidate.kind === "skillGuide" || candidate.kind === "taskGuide"
  );
  const overdueCandidate = candidates.find((candidate) => candidate.kind === "overdue");
  const selectedCandidates = [
    progressCandidate,
    overdueCandidate,
    ...candidates,
  ].filter((candidate, index, values): candidate is HomeSuggestionsRequest["candidates"][number] =>
    !!candidate && values.findIndex((value) => value?.id === candidate.id) === index
  ).slice(0, Math.min(2, candidates.length));

  return {
    suggestions: selectedCandidates.map((candidate) => ({
      candidateId: candidate.id,
      title: candidate.kind === "goal"
        ? candidate.title
        : `${candidate.kind === "overdue" ? "Finish" : "Continue"} ${candidate.title}`,
      reason: candidate.kind === "overdue"
        ? "Use the available time to clear this overdue task."
        : "Use the available time to make progress on this.",
      confidence: 0.5,
    })),
  };
}

export function buildHomeSuggestionsMessages(input: HomeSuggestionsRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Select useful optional work for a Home Suggestions card when the user has a large free block. Return only strict JSON. " +
        "Choose only candidate IDs supplied by the user payload and never invent, combine, or rewrite an ID. " +
        "Always choose at least one supplied candidate. Normally choose two worthwhile suggestions, and choose a third only when it is especially useful. " +
        "Prefer a balanced mix: include both meaningful goal or guide progress and overdue work when strong candidates of both kinds exist. " +
        "Use the full day context to avoid recommending something poorly timed or redundant. Today-plan overlap is allowed. " +
        "For goal candidates, preserve the supplied title exactly. It is already formatted as Continue plus the root goal name; never expose or substitute an active-action title. " +
        "For non-goal candidates, write a concise action title such as Finish X or Continue X. " +
        "Write a short practical reason explaining why this is a useful use of the free block. Do not claim that selecting a suggestion schedules or changes anything. " +
        "Return JSON with shape {\"suggestions\":[{\"candidateId\":\"id\",\"title\":\"action title\",\"reason\":\"short reason\",\"confidence\":0.0}]} with at most three suggestions.",
    },
    {
      role: "user",
      content: JSON.stringify(input),
    },
  ];
}
