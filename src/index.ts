import express from "express";
import cors from "cors";
import { getConfig } from "./config";
import { createSSEHub } from "./sse";
import { z } from "zod";
import { openaiChat, openaiChatStream, type ChatMessage, type OpenAIToolCall } from "./providers/openai";
import { AI_MODELS, getRouteModel } from "./ai/models";
import { buildContext } from "./ai/context";
import { getOpenAIToolDefs, getToolByName, validateToolCall } from "./tools/registry";
import { getAllowedToolNamesForSurface, getToolDefsForSurface, type AssistantSurface } from "./tools/surfaces";
import { APP_SCREEN_DESTINATIONS } from "./tools/appNavigation";
import { withCompactCalendarCreateContract } from "./tools/calendar";
import { createFunctionRouter } from "./functionRouter";
import { executeWebSearchTool } from "./tools/webSearch";
import { createAiAuthMiddleware } from "./auth/ai";
import { createAppCheckMiddleware } from "./auth/appCheck";
import { isFirebaseAuthenticationError, verifyFirebaseRequest, type AuthenticatedUser } from "./auth/firebase";
import { createDeepgramRouter } from "./deepgram";
import { buildTranscriptPromptChunks, type TranscriptPromptChunk } from "./ai/transcriptPrompt";
import { excludeVideosById } from "./ai/videoSelection";
import {
  WishlistPurchaseIntentRequestSchema,
  buildWishlistPurchaseIntentMessages,
  normalizeWishlistPurchaseIntentResponse,
} from "./ai/wishlistPurchaseIntent";
import {
  GoalWishlistSuggestionsRequestSchema,
  buildGoalWishlistSuggestionsMessages,
  normalizeGoalWishlistSuggestionsResponse,
} from "./ai/goalWishlistSuggestions";
import {
  HomeSuggestionsRequestSchema,
  buildFallbackHomeSuggestions,
  buildHomeSuggestionsMessages,
  normalizeHomeSuggestionsResponse,
} from "./ai/homeSuggestions";
import { filterClientToolCallsForUserIntent } from "./ai/toolCallFilter";
import {
  enforceCalendarCreatePolicy,
  getCalendarTimeContext,
  getCalendarCreateRecoveryAction,
} from "./ai/calendarCreatePolicy";
import {
  buildCompactServerSystemContent,
  shouldReviewCompactCalendarClarification,
} from "./ai/compactPrompt";
import {
  AiPersonalizationRequestSchema,
  buildAiPersonalizationSystemContent,
} from "./ai/personalization";
import {
  createAccountDeletionRecoveryToken,
  deleteAuthenticatedAccount,
  getAccountDeletionRecoveryUid,
  getAccountDeletionStatus,
  isRecentAuthentication,
  isAccountDeletionRecoveryError,
  APPLE_ACCOUNT_DELETION_NOT_CONFIGURED,
} from "./accountDeletion";

const config = getConfig();
export const app = express();
const sseHub = createSSEHub({ heartbeatMs: 15000 });
const functionRouter = createFunctionRouter(sseHub);
const appCheckMiddleware = createAppCheckMiddleware({
  required: config.appCheckRequired,
  allowedAppIds: config.appCheckAllowedAppIds,
});
const MAX_SERVER_TOOL_ROUNDS = 4;
const YOUTUBE_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const YOUTUBE_TRANSCRIPT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SUPADATA_JOB_POLL_INTERVAL_MS = 1000;
const SUPADATA_JOB_POLL_ATTEMPTS = 20;
const TRANSCRIPT_PROMPT_CHUNK_CHAR_LIMIT = 24000;

type RouteMeta = {
  webSearch?: boolean;
  webSearchQuery?: string;
  assistantKind?: "clarify" | "handoff" | "message";
  assistantText?: string;
};

type AssistantMode = "chat" | "compact";
type GoalGuidanceMode = "generate" | "answer_clarification" | "cram" | "chat_create";

const AccountDeletionRequestSchema = z.object({
  appleAuthorizationCode: z.string().min(1).max(4096).optional(),
  recoveryToken: z.string().min(1).max(4096),
});

const GoalGuidanceTimeframeSchema = z.enum(["thisWeek", "thisMonth", "thisYear", "longTerm"]);
const GoalQuotaUnitTypeSchema = z.enum(["distinct_days", "count"]);
const GoalQuotaClassificationSchema = z.object({
  targetCount: z.number().int().min(1).max(10000),
  unitLabel: z.string().min(1).max(80),
  unitType: GoalQuotaUnitTypeSchema,
}).superRefine((value, ctx) => {
  if (value.unitType === "distinct_days" && value.targetCount > 366) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetCount"], message: "Distinct-day quotas cannot exceed 366 days" });
  }
});

const GoalGuidanceMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});

const GoalGuidanceParentGoalSchema = z.object({
  title: z.string().min(1).max(300),
  details: z.string().max(4000).optional().default(""),
  timeframe: GoalGuidanceTimeframeSchema,
  deadlineLocalIso: z.string().min(1).max(80),
});

const GoalGuidanceActiveMilestoneSchema = z.object({
  title: z.string().min(1).max(300),
  details: z.string().max(4000).optional().default(""),
  stepIndex: z.number().int().min(0).max(100).optional(),
});

const GoalGuidanceSourceStepSchema = z.object({
  title: z.string().min(1).max(200),
  details: z.string().max(1000).optional().default(""),
});

const GoalGuidanceRequestSchema = z.object({
  goalTitle: z.string().min(1).max(300),
  goalDetails: z.string().max(4000).optional().default(""),
  timeframe: GoalGuidanceTimeframeSchema,
  deadlineLocalIso: z.string().min(1).max(80),
  nowLocalIso: z.string().min(1).max(80),
  userTimezone: z.string().min(1).max(100),
  currentPlan: z.string().max(4000).optional().default(""),
  conversation: z.array(GoalGuidanceMessageSchema).max(20).optional().default([]),
  mode: z.enum(["generate", "answer_clarification", "cram", "chat_create"]).optional().default("generate"),
  parentGoal: GoalGuidanceParentGoalSchema.optional(),
  activeMilestone: GoalGuidanceActiveMilestoneSchema.optional(),
  sourceSteps: z.array(GoalGuidanceSourceStepSchema).max(24).optional().default([]),
  sourceQuestion: z.string().max(8000).optional().default(""),
  sourceAnswer: z.string().max(8000).optional().default(""),
  quota: GoalQuotaClassificationSchema.optional(),
});

const GoalGuidanceResponseSchema = z.object({
  type: z.enum(["clarify", "plan", "not_feasible"]),
  question: z.string().max(800).optional(),
  goalTitle: z.string().min(1).max(300).optional(),
  feasibility: z.enum(["realistic", "tight", "unrealistic"]),
  feasibilityNote: z.string().max(800),
  steps: z.array(z.object({
    title: z.string().min(1).max(160),
    details: z.string().max(500).optional(),
    cadence: z.enum(["once", "daily"]).optional().default("once"),
    effort: z.enum(["light", "medium", "heavy"]).optional().default("medium"),
    youtubeQuery: z.string().max(160).optional(),
  })).max(12).default([]),
  alternativeSuggestion: z.string().max(800).optional(),
  alternativeTimeframe: GoalGuidanceTimeframeSchema.optional(),
  alternativeGoalTitle: z.string().min(1).max(300).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "clarify" && !value.question?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["question"], message: "Clarify responses require a question" });
  }
  if (value.type === "plan" && value.steps.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Plan responses require at least one step" });
  }
});

const TaskGuidanceMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});

const TaskGuidanceRequestSchema = z.object({
  title: z.string().min(1).max(300),
  details: z.string().max(4000).optional().default(""),
  currentGuide: z.string().max(4000).optional().default(""),
  conversation: z.array(TaskGuidanceMessageSchema).max(20).optional().default([]),
  mode: z.enum(["generate", "answer_clarification"]).optional().default("generate"),
  userTimezone: z.string().min(1).max(100),
  locale: z.string().max(100).optional().default("en-US"),
});

const TaskGuidanceStepSchema = z.object({
  title: z.string().min(1).max(160),
  details: z.string().max(500).optional(),
  youtubeQuery: z.string().max(160).optional(),
});

const TaskGuidanceResponseSchema = z.object({
  type: z.enum(["clarify", "plan"]),
  question: z.string().max(800).optional(),
  note: z.string().max(800).optional(),
  steps: z.array(TaskGuidanceStepSchema).max(12).default([]),
}).superRefine((value, ctx) => {
  if (value.type === "clarify" && !value.question?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["question"], message: "Clarify responses require a question" });
  }
  if (value.type === "plan" && value.steps.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Plan responses require at least one step" });
  }
});

const RecipeAnswersSchema = z.object({
  dietary: z.string().max(500).optional().default(""),
}).passthrough();

const RecipeVideoSchema = z.object({
  videoId: z.string().min(1).max(32),
  title: z.string().min(1).max(300),
  channelTitle: z.string().max(200).optional().default(""),
  thumbnailUrl: z.string().max(1000).optional(),
  durationSeconds: z.number().int().min(0).optional(),
  publishedAt: z.string().max(200).optional(),
  viewCount: z.number().int().min(0).optional(),
  transcriptStatus: z.enum(["available", "missing", "unknown"]).optional().default("unknown"),
});

const RecipeVideosRequestSchema = z.object({
  title: z.string().min(1).max(300),
  details: z.string().max(2000).optional().default(""),
  answers: RecipeAnswersSchema.optional().default({ dietary: "" }),
  excludeVideoIds: z.array(z.string().min(1).max(32)).optional().default([]),
  refinementText: z.string().max(500).optional().default(""),
  previousQuery: z.string().max(300).optional().default(""),
  previousVideos: z.array(RecipeVideoSchema).max(10).optional().default([]),
  userTimezone: z.string().max(100).optional().default("UTC"),
  locale: z.string().max(100).optional().default("en-US"),
});

const YoutubeDebugRequestSchema = z.object({
  query: z.string().min(1).max(200),
  videoId: z.string().min(1).max(32).optional(),
  locale: z.string().max(100).optional().default("en-US"),
});

const RecipeGenerateRequestSchema = RecipeVideosRequestSchema.extend({
  selectedVideo: RecipeVideoSchema,
});

const RecipeIngredientSchema = z.object({
  name: z.string().min(1).max(160),
  quantity: z.string().max(80).optional(),
  note: z.string().max(220).optional(),
});

const RecipeEquipmentSchema = z.object({
  name: z.string().min(1).max(120),
  required: z.boolean().optional(),
  note: z.string().max(220).optional(),
});

const RecipeStepSchema = z.object({
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(600),
  timestampSeconds: z.number().int().min(0).optional(),
  durationSeconds: z.number().int().min(0).optional(),
});

const RecipeGeneratedGuideSchema = z.object({
  ingredients: z.array(RecipeIngredientSchema).max(40),
  equipment: z.array(RecipeEquipmentSchema).max(20),
  steps: z.array(RecipeStepSchema).min(1).max(24),
});

const RecipeMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});

const RecipeAnswerRequestSchema = z.object({
  title: z.string().min(1).max(300),
  details: z.string().max(2000).optional().default(""),
  answers: RecipeAnswersSchema.optional().default({ dietary: "" }),
  selectedVideo: RecipeVideoSchema.optional(),
  ingredients: z.array(RecipeIngredientSchema).max(40).optional().default([]),
  equipment: z.array(RecipeEquipmentSchema).max(20).optional().default([]),
  steps: z.array(RecipeStepSchema).max(24).optional().default([]),
  activeStepIndex: z.number().int().min(0).max(100).optional().default(0),
  conversation: z.array(RecipeMessageSchema).max(20).optional().default([]),
  question: z.string().min(1).max(2000),
  aiPersonalization: AiPersonalizationRequestSchema,
});

const RecipeAnswerResponseSchema = z.object({
  answer: z.string().min(1).max(1600),
  action: z.enum(["answer", "recipe_change"]).optional().default("answer"),
  recipeTitle: z.preprocess(
    (value) => typeof value === "string" && !value.trim() ? undefined : value,
    z.string().min(1).max(300).optional()
  ),
  suggestedStepIndex: z.number().int().min(0).max(100).optional(),
});

const TodoTaskKindSchema = z.enum(["normal", "recipe", "skill"]);

const TodoClassifyRequestSchema = z.object({
  title: z.string().min(1).max(300),
  details: z.string().max(4000).optional().default(""),
  workspace: z.string().max(100).optional().default(""),
  goalTimeframe: z.string().max(50).optional().default(""),
  userTimezone: z.string().max(100).optional().default("UTC"),
  locale: z.string().max(100).optional().default("en-US"),
});

const TodoClassifyResponseSchema = z.object({
  kind: TodoTaskKindSchema,
  confidence: z.number().min(0).max(1),
  goalBehavior: z.enum(["standard", "quota"]).optional().default("standard"),
  quota: GoalQuotaClassificationSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.goalBehavior === "quota" && !value.quota) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quota"], message: "Quota metadata is required for quota goals" });
  }
});

const GoalQuotaDateResolveRequestSchema = z.object({
  text: z.string().min(1).max(300),
  goalTitle: z.string().max(300).optional().default(""),
  userTimezone: z.string().max(100).optional().default("UTC"),
  locale: z.string().max(100).optional().default("en-US"),
});

const GoalQuotaDateResolveIntentSchema = z.enum([
  "schedule_date",
  "open_picker",
  "decide_later",
  "needs_clarification",
  "none",
]);

const GoalQuotaDateResolveResponseSchema = z.object({
  intent: GoalQuotaDateResolveIntentSchema,
  dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  label: z.string().max(80).optional(),
  message: z.string().max(300).optional(),
});

const SkillVideoSchema = RecipeVideoSchema;

const SkillVideosRequestSchema = z.object({
  title: z.string().min(1).max(300),
  details: z.string().max(2000).optional().default(""),
  excludeVideoIds: z.array(z.string().min(1).max(32)).optional().default([]),
  refinementText: z.string().max(500).optional().default(""),
  previousQuery: z.string().max(300).optional().default(""),
  previousVideos: z.array(RecipeVideoSchema).max(10).optional().default([]),
  userTimezone: z.string().max(100).optional().default("UTC"),
  locale: z.string().max(100).optional().default("en-US"),
});

const SkillGenerateRequestSchema = SkillVideosRequestSchema.extend({
  selectedVideo: SkillVideoSchema,
});

const SkillStepSchema = z.object({
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(600),
  timestampSeconds: z.number().int().min(0).optional(),
  durationSeconds: z.number().int().min(0).optional(),
});

const SkillGeneratedGuideSchema = z.object({
  steps: z.array(SkillStepSchema).min(1).max(24),
});

const SkillMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});

const SkillAnswerRequestSchema = z.object({
  title: z.string().min(1).max(300),
  details: z.string().max(2000).optional().default(""),
  selectedVideo: SkillVideoSchema.optional(),
  steps: z.array(SkillStepSchema).max(24).optional().default([]),
  activeStepIndex: z.number().int().min(0).max(100).optional().default(0),
  conversation: z.array(SkillMessageSchema).max(20).optional().default([]),
  question: z.string().min(1).max(2000),
  userTimezone: z.string().max(100).optional().default("UTC"),
  locale: z.string().max(100).optional().default("en-US"),
  aiPersonalization: AiPersonalizationRequestSchema,
});

const SkillAnswerResponseSchema = z.object({
  answer: z.string().min(1).max(1600),
  suggestedStepIndex: z.number().int().min(0).max(100).optional(),
});

const SavedGuidanceStepSchema = z.object({
  title: z.string().min(1).max(200),
  details: z.string().max(1000).optional(),
  body: z.string().max(1000).optional(),
  completed: z.boolean().optional(),
});

const SavedGuidanceAnswerRequestSchema = z.object({
  guideType: z.enum(["goal", "task"]),
  title: z.string().min(1).max(300),
  details: z.string().max(4000).optional().default(""),
  status: z.string().max(100).optional().default(""),
  steps: z.array(SavedGuidanceStepSchema).min(1).max(24),
  activeStepIndex: z.number().int().min(0).max(100).optional().default(0),
  conversation: z.array(TaskGuidanceMessageSchema).max(20).optional().default([]),
  question: z.string().min(1).max(2000),
  userTimezone: z.string().max(100).optional().default("UTC"),
  locale: z.string().max(100).optional().default("en-US"),
  aiPersonalization: AiPersonalizationRequestSchema,
});

const SavedGuidanceAnswerResponseSchema = z.object({
  answer: z.string().min(1).max(1600),
  suggestedStepIndex: z.number().int().min(0).max(100).optional(),
});

function buildGoalGuidancePrompt(input: z.infer<typeof GoalGuidanceRequestSchema>) {
  const timeframeLabel =
    input.timeframe === "thisWeek"
      ? "this week"
      : input.timeframe === "thisMonth"
        ? "this month"
        : input.timeframe === "thisYear"
          ? "this year"
          : "the long term";
  const longRangeTimeframe = input.timeframe === "thisYear" || input.timeframe === "longTerm";
  const isMilestoneDrillIn = !!input.activeMilestone?.title;
  const cramRule =
    input.mode === "cram"
      ? "The user chose Try anyway. Generate the most compressed honest action plan that can fit the deadline. Do not return type clarify in this mode. Do not ask another question. Use the goal, deadline, saved context, latest user messages, and reasonable defaults. Do not return not_feasible just because the goal is risky or unlikely; return type plan with tight or unrealistic feasibility unless there is literally no useful action the user can take before the deadline.\n"
      : input.timeframe === "thisWeek"
        ? "If the goal is unrealistic for this week, return type not_feasible instead of forcing a plan. Return no steps. Set alternativeTimeframe to 'thisMonth', set alternativeGoalTitle to a concise monthly version of the goal, and make alternativeSuggestion explain that monthly version.\n"
        : input.timeframe === "thisMonth"
          ? "If the goal is unrealistic for this month, return type not_feasible instead of forcing a plan. Return no steps. Make alternativeSuggestion a focused monthly version covering the most important smaller outcome.\n"
          : "If the long-range outcome is unrealistic as stated, still return a short milestone plan when there is a credible smaller path. Mark feasibility as tight or unrealistic and make feasibilityNote explain the deadline risk clearly and supportively while emphasizing credible progress and the next path. Return not_feasible only when there is no useful first milestone without changing the outcome.\n";
  const chatCreateRule =
    input.mode === "chat_create"
      ? [
          "This plan is being created from full chat, not from the Goal detail screen.",
          "- Return type plan immediately. Do not return type clarify. Use reasonable defaults when context is missing.",
          "- If Source steps are present, treat them as raw material, not final output.",
          "- For weekly goals, compress oversized source steps into a few concrete actions that can fit this week.",
          "- For monthly, yearly, or long-term goals, expand, merge, or reshape tiny source steps so the plan fits the full timeframe and outcome.",
          "- Preserve the user's goal outcome unless the source steps clearly narrow it.",
          "- Return not_feasible only when no useful action plan can be created at all.\n",
        ].join("\n")
      : "";
  const firstTurnClarificationRule =
    "This is the first guidance turn. Return type clarify before making any plan. Ask exactly one short clarifying question whose answer would materially change the steps. Prefer current level, baseline, or available time when missing. Ask about the biggest constraint only when the goal is ambiguous or the constraint would materially change the first steps. Return no steps.\n";
  const clarificationRule =
    input.mode === "generate" && input.conversation.length === 0
      ? firstTurnClarificationRule
      : input.mode === "generate" && input.conversation.length > 0
        ? [
            "The user is continuing from an earlier guidance preview. Read the latest user message as the newest context.",
            "- If the latest user message provides an updated number, baseline, current level, available time, resources, constraint, preference, prior progress, or other correction, treat it as authoritative and re-evaluate from that context.",
            "- Do not repeat the same infeasible rejection just because an earlier assistant message said the goal needed more time.",
            "- If the latest user message asks to change this to a monthly goal, use the user's previous clarification answers from this conversation and return a monthly plan. Do not ask the same clarification question again.",
            "- Do not ask for information that the latest user message or prior conversation already provides.",
            "- Return type clarify only when a genuinely missing detail would materially change the next steps. Ask one short question and return no steps.",
            "- Include goalTitle only when the latest user message explicitly changes the goal scope, topic, or outcome. Do not rewrite the title for timeframe or context updates.\n",
          ].join("\n")
      : input.mode === "answer_clarification" && isMilestoneDrillIn
        ? [
            "The user sent a follow-up while viewing a specific mini-goal/milestone.",
            "- Focus the response on the active milestone, while keeping the parent goal in mind.",
            "- If the user asks a question, shares tactics, or wants advice without asking for task changes, return type clarify with direct tactical guidance in the question field.",
            "- If the user asks to break down the milestone, make tasks, add child tasks, make the tasks easier, or says the milestone/current child tasks are hard, confusing, overwhelming, too hard, they are stuck, or they do not know how to start, return type plan for this active milestone only.",
            "- A milestone drill-in plan is the second and final level. Its steps are child tasks for the active milestone. Do not create another nested milestone plan inside those child tasks.",
            "- For milestone drill-in plans, use 2-5 concrete child tasks that directly complete the active milestone. Keep them small enough to do one at a time.",
            "- Do not rewrite the parent long-range milestone list while in milestone drill-in.",
            "- Do not include goalTitle unless the user explicitly changes the parent goal outcome.",
            "- When answering with type clarify, do not ask unnecessary follow-up questions.\n",
          ].join("\n")
      : input.mode === "answer_clarification"
        ? [
            "The user sent a follow-up message. Read the latest user message carefully and decide:",
            "- If the latest user message gives an updated number, baseline, current level, available time, resources, constraint, preference, or prior progress, treat it as new authoritative context and re-evaluate the plan instead of repeating a prior feasibility rejection.",
            "- If the user is asking a question, making a comment, or seeking advice about the plan WITHOUT requesting specific changes, respond with type clarify and put your answer in the question field. Do NOT return type plan. Do NOT modify the steps.",
            "- Override the clarify/comment and accepted-plan conservative rules when the user says a step or goal is hard, too hard, confusing, overwhelming, they are stuck, or they do not know how to start. In those cases always return type plan with easier smaller steps that push the goal forward, even if the plan was already accepted. It is okay to add more steps.",
            "- If the user is explicitly requesting a change to the plan (add a step, remove a step, swap order, change details, etc.), return type plan with the updated steps.",
            "- Include goalTitle only when the latest user message explicitly changes the goal scope, topic, or outcome. Do not rewrite the title just because the user clarified their level, constraints, preferences, or available time.",
            "- If the plan status is accepted, be especially conservative: only return type plan when the user unambiguously asks to modify steps. Questions like 'why this step?' or 'how do I do step 3?' are NOT change requests.",
            "- When answering a question with type clarify, give a helpful direct answer. Do not ask unnecessary follow-up questions.\n",
          ].join("\n")
        : "";
  const conversationText = input.conversation.length
    ? input.conversation.map((message) => `${message.role}: ${message.content}`).join("\n")
    : "No prior guidance messages.";
  const currentPlanText = input.currentPlan.trim() || "No current saved guidance plan.";
  const parentGoalText = input.parentGoal
    ? [
        `Parent goal title: ${input.parentGoal.title}`,
        `Parent goal timeframe: ${input.parentGoal.timeframe}`,
        `Parent goal deadline: ${input.parentGoal.deadlineLocalIso}`,
        input.parentGoal.details ? `Parent goal details: ${input.parentGoal.details}` : "",
      ].filter(Boolean).join("\n")
    : "None";
  const activeMilestoneText = input.activeMilestone
    ? [
        `Active milestone title: ${input.activeMilestone.title}`,
        Number.isInteger(input.activeMilestone.stepIndex) ? `Active milestone number: ${Number(input.activeMilestone.stepIndex) + 1}` : "",
        input.activeMilestone.details ? `Active milestone details: ${input.activeMilestone.details}` : "",
      ].filter(Boolean).join("\n")
    : "None";
  const sourceStepsText = input.sourceSteps.length
    ? input.sourceSteps
        .map((step, index) => `${index + 1}. ${step.title}${step.details ? ` - ${step.details}` : ""}`)
        .join("\n")
    : "None";
  const sourceChatText = [
    input.sourceQuestion ? `Source user request: ${input.sourceQuestion}` : "",
    input.sourceAnswer ? `Source assistant answer: ${input.sourceAnswer}` : "",
  ].filter(Boolean).join("\n") || "None";
  const quotaText = input.quota
    ? [
        `Target count: ${input.quota.targetCount}`,
        `Unit label: ${input.quota.unitLabel}`,
        `Unit type: ${input.quota.unitType}`,
      ].join("\n")
    : "None";
  const quotaRule = input.quota
    ? [
        "- This is a quota goal. Return exactly one reusable action step for the next repetition.",
        "- Do not create one saved step per repetition and do not create Day 1, Day 2, or numbered quota steps.",
        "- The app will render dynamic labels such as Day 1 of 3 or 8 of 40 and will handle scheduling separately.",
        "- The action step title and details must be date-neutral and reusable every time the user schedules the next repetition.",
        "- For distinct-days quotas, write the action as something that is completed once on a chosen day.",
        "- For count quotas, write the action as one single completion unit that can be repeated more than once on a day when appropriate.",
      ].join("\n")
    : "";

  return [
    "You generate local app goal guidance plans.",
    "Return only JSON matching this TypeScript shape:",
    "{ type: 'clarify' | 'plan' | 'not_feasible', question?: string, goalTitle?: string, feasibility: 'realistic' | 'tight' | 'unrealistic', feasibilityNote: string, steps: Array<{ title: string, details?: string, cadence?: 'once' | 'daily', effort?: 'light' | 'medium' | 'heavy', youtubeQuery?: string }>, alternativeSuggestion?: string, alternativeTimeframe?: 'thisWeek' | 'thisMonth' | 'thisYear' | 'longTerm', alternativeGoalTitle?: string }",
    "",
    "Rules:",
    `- The goal deadline is ${input.deadlineLocalIso} in timezone ${input.userTimezone}.`,
    `- Today/current local time is ${input.nowLocalIso}.`,
    `- The user wants this done by ${timeframeLabel}.`,
    "- Keep response type and feasibility accurate. Optimistic wording must not change the feasibility decision.",
    "- Write feasibilityNote and alternativeSuggestion in supportive, forward-looking language. Never apologize or call the user or goal unrealistic or impossible in either field.",
    "- When the deadline limits the full outcome, frame the constraint around the available time, lead with meaningful progress that is still possible, and give a credible next path. Stay honest; do not make false promises or use generic motivational fluff.",
    input.mode === "chat_create"
      ? "- This chat-created goal must get a plan now. Do not ask a first-turn clarification."
      : "- Clarify before planning on the first guidance turn. After clarification, ask another question only if a missing detail would materially change the steps.",
    "- Never return type plan with zero steps. If no useful steps fit the deadline, return type not_feasible with no steps instead.",
    "- The steps become actual todos. They must be useful actions the user would naturally want to check off, not advice and not meta-planning.",
    "- The app makes active guidance todos due today and reveals the next queued action after the active actions are completed and the next local day starts.",
    "- Write every step so it still makes sense whenever it becomes active. Do not use relative calendar words like today, tomorrow, tonight, this morning, this afternoon, this evening, yesterday, or next day in titles or details.",
    "- Preserve the user's original goal title by default. Do not improve, broaden, simplify, or rephrase it during normal plan generation.",
    "- Include goalTitle only when the user explicitly asks to change the goal itself or switches the goal to a different topic, scope, or outcome. Keep it concise and user-facing.",
    "- Prefer direct execution tasks that make progress today over preparation, scheduling, planning, listing, or researching.",
    "- Do not create filler tasks such as write a schedule, make a list, create a plan, buy a surplus, research options, prepare a generic set of items, or weigh yourself unless the user specifically asked for that or it is truly necessary.",
    "- Use setup/prep tasks only when they directly unlock the next action and keep them to at most one step in the plan.",
    "- Every step title must start with an action verb and name the actual action to do now.",
    "- Every step should name a concrete action or result the user can check off without adding a separate completion sentence.",
    "- Do not output broad suggestions, principles, or ongoing habits as steps.",
    "- Avoid vague habit phrasing like increase meals, drink calories, limit exercise, eat more, practice daily, be consistent, or research.",
    "- If the goal requires repeated behavior, create concrete daily execution tasks rather than a planning task for the repeated behavior.",
    "- For numeric target goals, the plan must still reach the user's stated target number by the deadline. Do not silently replace 110 kg with 97.5 kg, 100 users with 20 users, or any easier final target. If the stated number cannot be reached by the deadline, return type not_feasible instead.",
    "- If a small concrete checkpoint should happen every day until the deadline, set cadence to daily.",
    "- Use cadence daily for repeatable direct actions, not for advice. The title should still be a single-day todo.",
    "- Use cadence once for one-time actions.",
    "- Set effort to light, medium, or heavy based on how much focused work the single todo needs today.",
    "- Use effort heavy when a step could reasonably take most of the user's available day or is mentally/physically demanding enough that pairing it with another goal action would be confusing.",
    "- Use effort light only for short, simple actions. Use effort medium for normal focused actions.",
    "- Default to leaving youtubeQuery empty. Add it only when the step depends on seeing a visual demonstration, technique, form, walkthrough, setup, repair, cooking method, workout movement, instrument skill, or software screen flow.",
    "- Do not add youtubeQuery when the user said they already know the skill, the step is mostly reading, writing, admin, chores, errands, shopping, reminders, scheduling, generic practice, or the user can complete it from the text instructions alone.",
    "- For learning goals, add youtubeQuery only for the unfamiliar hands-on subskill, not every learning step.",
    "- A good youtubeQuery should be 4-8 specific words, include the exact technique or object, and include one intent word like tutorial, demonstration, walkthrough, technique, form, drill, setup, or how to.",
    "- Avoid broad queries like beginner guide, tips, routine, motivation, ideas, explained, basics, or productivity. Do not include a URL or the word YouTube.",
    "- Do not multiply the plan by the number of days or create a fixed number of steps per day.",
    longRangeTimeframe
      ? "- For this year or long-term goals, create milestone steps, not a long checklist. Usually use 3-6 milestones, but use up to 12 only when the outcome genuinely needs more major checkpoints. Each milestone should be meaningful and measurable, such as reach the first 10k users before a 100k-user goal."
      : input.timeframe === "thisMonth"
      ? "- Use concrete execution tasks sized for the whole month. Usually use 3-6 tasks, but use up to 12 only when the month-long outcome genuinely needs more chunks. A once task should usually take multiple focused sessions or produce a concrete deliverable; do not make month-long goals out of tiny 5-10 minute tasks."
      : "- Use the fewest distinct steps that make the goal actionable. For short deadlines, 3-5 total steps is usually enough.",
    input.timeframe === "thisMonth" || longRangeTimeframe
      ? "- Do not exceed 12 total steps. Prefer fewer concrete steps unless adding another step prevents a vague or overloaded task."
      : "",
    longRangeTimeframe
      ? "- Treat each long-range step as a mini-goal that the user can open and discuss for deeper guidance later. Make each mini-goal self-contained, measurable, and broad enough to support tactical advice."
      : "",
    longRangeTimeframe
      ? "- Long-range milestone titles should start with a concrete outcome verb such as Reach, Launch, Close, Publish, Ship, Build, Validate, Hire, Save, Pay off, or Complete. Avoid tiny tasks like research ads, make a list, or write a plan unless that deliverable is the milestone."
      : "",
    longRangeTimeframe
      ? "- For long-range plans, set cadence to once. Do not create daily habits as top-level milestones. Put repeated execution guidance in the details sentence only when it helps the user start the current milestone."
      : "",
    longRangeTimeframe
      ? "- Long-range details should say how to start the milestone from the user's current position and keep the measurable result in the milestone wording. Do not add a separate completion sentence."
      : "",
    input.timeframe === "thisMonth"
      ? "- For monthly learning or skill goals, beginner level should change the starting point, not shrink the final outcome into something trivial. The final task should be a credible month-end result for a beginner, such as playing multiple simple songs start to finish, building a small finished project, or completing a useful practice set."
      : "",
    input.timeframe === "thisMonth"
      ? "- For monthly plans, do not make once tasks around 5-10 minute actions. Use a daily cadence task for short repeated practice, or make the once task represent a completed set of focused sessions."
      : "",
    "- If the same action should happen across multiple days, prefer one daily cadence step instead of duplicate per-day steps.",
    "- For goals about body, learning, work, money, relationships, or chores, choose actions that directly move that goal, not administrative scaffolding around it.",
    "- Steps must fit the available time and be small enough to complete one at a time.",
    "- Each step details field should briefly explain how to start or do the action in one concise sentence. Keep it concrete, not motivational.",
    "",
    "Quality examples:",
    "- Bad: Write a 4-day eating schedule. Good: Add one calorie-dense snack after lunch today.",
    "- Bad: Buy a 4-day surplus. Good: Add peanut butter, nuts, or full-fat yogurt to today's grocery order.",
    "- Bad: Create a study plan. Good: Complete one 25-minute lesson on the first topic.",
    "- Bad: Research portfolio ideas. Good: Draft the project card for one finished project.",
    "- Bad: Practice daily. Good: Complete one 20-minute practice session for the target skill.",
    "- Bad details: Make progress on the project. Good details: Open the existing draft and write rough text for the first two missing sections.",
    "- Bad details: Try an easier version. Good details: Do the first five practice problems, check each answer, and note one mistake pattern.",
    "- Bad monthly beginner music task: Practice chord changes for 10 minutes. Good: Complete four 25-minute chord-change sessions between G, C, and D, aiming for five clean switches between each pair.",
    "- Bad monthly beginner music final task: Play along to one very easy three-chord song. Good: Play and record two beginner three-chord songs from start to finish at a steady tempo without stopping.",
    "- Do not create todos, mention tools, or claim anything was saved.",
    quotaRule,
    chatCreateRule,
    clarificationRule,
    cramRule,
    "",
    `Goal title: ${input.goalTitle}`,
    `Goal details: ${input.goalDetails || "None"}`,
    "",
    "Parent goal context:",
    parentGoalText,
    "",
    "Active milestone context:",
    activeMilestoneText,
    "",
    "Source chat content for chat-created goals:",
    sourceChatText,
    "",
    "Source steps for chat-created goals:",
    sourceStepsText,
    "",
    "Quota context:",
    quotaText,
    "",
    "Current saved guidance plan:",
    currentPlanText,
    "",
    "Guidance conversation:",
    conversationText,
  ].filter(Boolean).join("\n");
}

function buildTaskGuidancePrompt(input: z.infer<typeof TaskGuidanceRequestSchema>) {
  const conversationText = input.conversation.length
    ? input.conversation.map((message) => `${message.role}: ${message.content}`).join("\n")
    : "No prior guidance chat.";
  const currentGuideText = input.currentGuide?.trim() || "No saved guide.";
  const clarificationRule = input.mode === "generate"
    ? "- Ask one clarifying question only if missing context would materially change the steps. Otherwise return a plan."
    : "- Use the latest user message and existing guide. If the user asks for changes, return a revised plan. If more context is essential, ask one clarifying question.";

  return [
    "Create practical guidance for one normal personal task.",
    "Return only JSON with shape:",
    "{\"type\":\"plan\",\"note\":\"\",\"steps\":[{\"title\":\"\",\"details\":\"\",\"youtubeQuery\":\"\"}]}",
    "or {\"type\":\"clarify\",\"question\":\"\",\"steps\":[]}.",
    "",
    "Rules:",
    "- This is not a long-range goal. Do not use deadlines, timeframes, feasibility labels, or not_feasible.",
    "- Do not create todos, mention tools, or claim anything was saved.",
    "- Steps become checkable subtasks inside the same task. Make them ordered and concrete.",
    "- Usually create 3-8 steps. Use more only when the task genuinely needs more chunks. Never exceed 12.",
    "- Each details field should say how to start or do the step in one concise sentence.",
    "- Do not include recipe/cooking guide behavior, ingredients, equipment, or video transcript assumptions.",
    "- Add youtubeQuery only for a hands-on unfamiliar technique that a short tutorial would help with.",
    "- Do not add youtubeQuery for admin, chores, errands, shopping, reading, writing, reminders, scheduling, or steps clear from the text.",
    "- A youtubeQuery should be 4-8 specific words and include one intent word like tutorial, walkthrough, technique, form, drill, setup, or how to.",
    clarificationRule,
    "",
    `Task title: ${input.title}`,
    `Task details: ${input.details || "None"}`,
    `User timezone: ${input.userTimezone}`,
    `Locale: ${input.locale}`,
    "",
    "Current saved guide:",
    currentGuideText,
    "",
    "Guidance conversation:",
    conversationText,
  ].filter(Boolean).join("\n");
}

function parseModelJson(content: unknown) {
  if (typeof content !== "string") {
    throw new Error("Model returned empty content");
  }

  const clean = content.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  return JSON.parse(clean);
}

class InvalidGuideResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGuideResponseError";
  }
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function textFromRuns(value: any) {
  if (!value) return "";
  if (typeof value.simpleText === "string") return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run: any) => String(run?.text || "")).join("");
  return "";
}

function parseDurationSeconds(value: string) {
  const parts = value.split(":").map((part) => Number(part));
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return undefined;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseIso8601DurationSeconds(value: string | undefined) {
  if (!value) return undefined;
  const match = value.match(/^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/i);
  if (!match) return undefined;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const total = Math.round((((days * 24) + hours) * 60 + minutes) * 60 + seconds);
  return Number.isFinite(total) ? total : undefined;
}

function normalizeRecipeSearchText(value: string) {
  return value
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRecipeVideoSearchQuery(input: z.infer<typeof RecipeVideosRequestSchema>) {
  const dietary = input.answers?.dietary?.trim();
  return normalizeRecipeSearchText([
    input.title,
    dietary || "",
    "recipe tutorial step by step cooking",
  ].filter(Boolean).join(" "));
}

const VideoSearchRefinementResponseSchema = z.object({
  query: z.string().min(1).max(200),
});

function buildVideoSearchRefinementFallback(baseQuery: string, refinementText: string) {
  const normalized = refinementText.toLowerCase();
  const refinements: string[] = [];

  if (/\b(easy|easier|simple|simpler|beginner|basic|starter|slow)\b/.test(normalized)) {
    refinements.push("beginner easy");
  }
  if (/\b(short|shorter|quick|faster|brief)\b/.test(normalized)) {
    refinements.push("short");
  }
  if (/\b(step by step|detailed|explain|walkthrough|follow along)\b/.test(normalized)) {
    refinements.push("step by step");
  }
  if (/\b(relevant|related|specific|exact|closer|like that|more like)\b/.test(normalized)) {
    refinements.push("specific");
  }
  if (/\b(different|another|other|new|fresh)\b/.test(normalized)) {
    refinements.push("alternative");
  }

  return normalizeRecipeSearchText([baseQuery, refinements.join(" ")].filter(Boolean).join(" "));
}

async function refineVideoSearchQuery(
  input: z.infer<typeof RecipeVideosRequestSchema> | z.infer<typeof SkillVideosRequestSchema>,
  baseQuery: string,
  guideType: "recipe" | "skill"
) {
  const refinementText = input.refinementText.trim();
  if (!refinementText) return baseQuery;

  const previousVideoSummary = input.previousVideos
    .slice(0, 5)
    .map((video, index) => `${index + 1}. ${video.title}${video.channelTitle ? ` by ${video.channelTitle}` : ""}`)
    .join("\n");
  const dietary = guideType === "recipe" && "answers" in input ? input.answers?.dietary?.trim() : "";

  try {
    const result = await openaiChat({
      model: "gpt-5.4-mini",
      temperature: 0,
      maxTokens: 180,
      messages: [
        {
          role: "system",
          content: "Rewrite YouTube search queries for video guidance. Return only strict JSON.",
        },
        {
          role: "user",
          content: [
            `Guide type: ${guideType}`,
            "Keep the same target title and details. Treat the user message only as a preference for better video search results.",
            "Do not switch to a different recipe, task, skill, ingredient, or topic unless it is already in the title/details.",
            "Return JSON with shape {\"query\":\"...\"}. The query must be 4-14 words, searchable on YouTube, and must not include a URL or the word YouTube.",
            "",
            `Title: ${input.title}`,
            input.details ? `Details: ${input.details}` : "",
            dietary ? `Dietary preference: ${dietary}` : "",
            `Base query: ${baseQuery}`,
            input.previousQuery ? `Previous query: ${input.previousQuery}` : "",
            previousVideoSummary ? `Previous videos:\n${previousVideoSummary}` : "",
            `User refinement: ${refinementText}`,
          ].filter(Boolean).join("\n"),
        },
      ],
    });
    const parsed = VideoSearchRefinementResponseSchema.safeParse(parseModelJson(result.message.content));
    if (parsed.success) {
      const query = normalizeRecipeSearchText(parsed.data.query).slice(0, 200).trim();
      if (query) return query;
    }
  } catch (err: any) {
    console.warn(`[${guideType}/videos] query refinement fallback:`, err?.message || err);
  }

  return buildVideoSearchRefinementFallback(baseQuery, refinementText);
}

type YoutubeSearchCacheEntry = {
  expiresAt: number;
  videos: z.infer<typeof RecipeVideoSchema>[];
};

type TranscriptSegment = {
  start: number;
  duration?: number;
  text: string;
};

type TranscriptResult = {
  language?: string;
  segments: TranscriptSegment[];
};

type TranscriptCacheEntry = {
  expiresAt: number;
  value: TranscriptResult;
};

type SupadataTranscriptPayload = {
  content?: any;
  lang?: string;
  availableLangs?: string[];
};

const youtubeSearchCache = new Map<string, YoutubeSearchCacheEntry>();
const youtubeSearchInFlight = new Map<string, Promise<z.infer<typeof RecipeVideoSchema>[]>>();
const transcriptCache = new Map<string, TranscriptCacheEntry>();
const transcriptInFlight = new Map<string, Promise<TranscriptResult>>();

function getCachedSearchVideos(key: string) {
  const cached = youtubeSearchCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    youtubeSearchCache.delete(key);
    return undefined;
  }
  return cached.videos;
}

function setCachedSearchVideos(key: string, videos: z.infer<typeof RecipeVideoSchema>[]) {
  youtubeSearchCache.set(key, {
    expiresAt: Date.now() + YOUTUBE_SEARCH_CACHE_TTL_MS,
    videos,
  });
}

function getCachedTranscript(key: string) {
  const cached = transcriptCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    transcriptCache.delete(key);
    return undefined;
  }
  return cached.value;
}

function setCachedTranscript(key: string, value: TranscriptResult) {
  transcriptCache.set(key, {
    expiresAt: Date.now() + YOUTUBE_TRANSCRIPT_CACHE_TTL_MS,
    value,
  });
}

function getLocaleHints(locale: string) {
  const normalized = String(locale || "").replace(/_/g, "-").trim();
  const [languageRaw, regionRaw] = normalized.split("-");
  const language = /^[a-z]{2,3}$/i.test(languageRaw || "") ? languageRaw.toLowerCase() : undefined;
  const region = /^[a-z]{2}$/i.test(regionRaw || "") ? regionRaw.toUpperCase() : undefined;
  return { language, region };
}

function getYouTubeVideoUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function mapYouTubeApiVideoToRecipeVideo(item: any): z.infer<typeof RecipeVideoSchema> | null {
  const videoId = String(item?.id || "").trim();
  const title = String(item?.snippet?.title || "").trim();
  const durationSeconds = parseIso8601DurationSeconds(item?.contentDetails?.duration);
  const lowerTitle = title.toLowerCase();
  if (!videoId || !title || !durationSeconds || durationSeconds < 240 || lowerTitle.includes("#shorts") || /\bshorts?\b/.test(lowerTitle)) {
    return null;
  }

  const thumbnails = item?.snippet?.thumbnails;
  const thumbnailUrl =
    typeof thumbnails?.high?.url === "string" ? thumbnails.high.url :
    typeof thumbnails?.medium?.url === "string" ? thumbnails.medium.url :
    typeof thumbnails?.default?.url === "string" ? thumbnails.default.url :
    undefined;
  const rawViewCount = Number(item?.statistics?.viewCount);
  const viewCount = Number.isFinite(rawViewCount) ? Math.max(0, Math.round(rawViewCount)) : undefined;

  return {
    videoId,
    title,
    channelTitle: String(item?.snippet?.channelTitle || "").trim(),
    thumbnailUrl,
    durationSeconds,
    publishedAt: typeof item?.snippet?.publishedAt === "string" ? item.snippet.publishedAt : undefined,
    viewCount,
    transcriptStatus: "unknown",
  };
}

function rankRecipeVideos(videos: z.infer<typeof RecipeVideoSchema>[]) {
  const cookingPattern = /\b(recipe|cook|cooking|bake|baking|chef|kitchen|homemade|tutorial|step by step|how to make|how to cook)\b/i;
  return [...videos].sort((a, b) => {
    const aDuration = a.durationSeconds || 0;
    const bDuration = b.durationSeconds || 0;
    const aScore =
      (cookingPattern.test(a.title) ? 6 : 0) +
      (aDuration >= 360 && aDuration <= 1800 ? 5 : 0) +
      Math.min(Math.log10((a.viewCount || 0) + 1), 7);
    const bScore =
      (cookingPattern.test(b.title) ? 6 : 0) +
      (bDuration >= 360 && bDuration <= 1800 ? 5 : 0) +
      Math.min(Math.log10((b.viewCount || 0) + 1), 7);
    return bScore - aScore;
  });
}

async function fetchRegularYoutubeRecipeVideosForQuery(query: string, locale: string) {
  if (!config.youtubeDataApiKey) {
    throw new Error("YOUTUBE_DATA_API_KEY is not configured.");
  }

  const cacheKey = `${locale}::${query}`;
  const cached = getCachedSearchVideos(cacheKey);
  if (cached) {
    return rankRecipeVideos(cached);
  }

  const inFlight = youtubeSearchInFlight.get(cacheKey);
  if (inFlight) {
    return rankRecipeVideos(await inFlight);
  }

  const request = (async () => {
    const { language, region } = getLocaleHints(locale);
    const searchParams = new URLSearchParams({
      key: config.youtubeDataApiKey!,
      part: "snippet",
      q: query,
      type: "video",
      maxResults: "15",
      videoCaption: "closedCaption",
      safeSearch: "moderate",
    });
    if (language) searchParams.set("relevanceLanguage", language);
    if (region) searchParams.set("regionCode", region);

    const searchResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`);
    const searchPayload = await searchResponse.json().catch(() => null);
    if (!searchResponse.ok) {
      const upstreamMessage =
        typeof searchPayload?.error?.message === "string" ? searchPayload.error.message :
        typeof searchPayload?.message === "string" ? searchPayload.message :
        `HTTP ${searchResponse.status}`;
      throw new Error(`YouTube search failed: ${upstreamMessage}`);
    }

    const videoIds = Array.isArray(searchPayload?.items)
      ? searchPayload.items
          .map((item: any) => String(item?.id?.videoId || "").trim())
          .filter(Boolean)
      : [];
    if (!videoIds.length) {
      setCachedSearchVideos(cacheKey, []);
      return [];
    }

    const detailsParams = new URLSearchParams({
      key: config.youtubeDataApiKey!,
      part: "snippet,contentDetails,statistics",
      id: Array.from(new Set(videoIds)).join(","),
    });
    const detailsResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${detailsParams.toString()}`);
    const detailsPayload = await detailsResponse.json().catch(() => null);
    if (!detailsResponse.ok) {
      const upstreamMessage =
        typeof detailsPayload?.error?.message === "string" ? detailsPayload.error.message :
        typeof detailsPayload?.message === "string" ? detailsPayload.message :
        `HTTP ${detailsResponse.status}`;
      throw new Error(`YouTube video details failed: ${upstreamMessage}`);
    }

    const videos = Array.isArray(detailsPayload?.items)
      ? detailsPayload.items
          .map((item: any) => mapYouTubeApiVideoToRecipeVideo(item))
          .filter((video: z.infer<typeof RecipeVideoSchema> | null): video is z.infer<typeof RecipeVideoSchema> => Boolean(video))
      : [];
    setCachedSearchVideos(cacheKey, videos);
    return videos;
  })();

  youtubeSearchInFlight.set(cacheKey, request);
  try {
    return rankRecipeVideos(await request);
  } finally {
    youtubeSearchInFlight.delete(cacheKey);
  }
}

async function searchRegularYoutubeRecipeVideos(input: z.infer<typeof RecipeVideosRequestSchema>) {
  const query = await refineVideoSearchQuery(input, buildRecipeVideoSearchQuery(input), "recipe");
  const videos = await fetchRegularYoutubeRecipeVideosForQuery(query, input.locale || "en-US,en;q=0.9");
  const nextVideos = excludeVideosById(videos, input.excludeVideoIds);

  return {
    query,
    videos: nextVideos.slice(0, 5),
  };
}

function decodeJsonCaptionText(value: string) {
  return decodeHtmlEntities(value.replace(/\s+/g, " ").trim());
}

function normalizeTranscriptSegments(raw: any): TranscriptSegment[] {
  const events = Array.isArray(raw?.events)
    ? raw.events
    : Array.isArray(raw)
      ? raw
      : [];
  return events
    .map((event: any) => {
      const directText = typeof event?.text === "string" ? event.text : "";
      const start = Number.isFinite(Number(event?.offset))
        ? Number(event.offset) / 1000
        : Number(event?.tStartMs || 0) / 1000;
      const duration = Number.isFinite(Number(event?.duration))
        ? Number(event.duration) / 1000
        : Number.isFinite(Number(event?.dDurationMs))
          ? Number(event.dDurationMs) / 1000
          : undefined;
      const text = directText || (Array.isArray(event?.segs)
        ? event.segs.map((segment: any) => String(segment?.utf8 || "")).join("")
        : "");
      return {
        start: Math.max(0, Math.floor(start)),
        duration: duration ? Math.max(0, Math.floor(duration)) : undefined,
        text: decodeJsonCaptionText(text),
      };
    })
    .filter((segment: TranscriptSegment) => segment.text.length > 0);
}

async function fetchSupadataTranscriptPayload(url: string) {
  if (!config.supadataApiKey) {
    throw new Error("SUPADATA_API_KEY is not configured.");
  }

  const response = await fetch(url, {
    headers: {
      "x-api-key": config.supadataApiKey,
    },
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function normalizeSupadataTranscriptPayload(payload: SupadataTranscriptPayload): TranscriptResult {
  const language = typeof payload?.lang === "string" ? payload.lang : undefined;
  const segments = normalizeTranscriptSegments(payload?.content);
  if (!segments.length) {
    throw new Error("No transcript text is available for this video. Pick another regular video.");
  }
  return { language, segments };
}

async function pollSupadataTranscriptJob(jobId: string): Promise<SupadataTranscriptPayload> {
  for (let attempt = 0; attempt < SUPADATA_JOB_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, SUPADATA_JOB_POLL_INTERVAL_MS));
    }
    const { response, payload } = await fetchSupadataTranscriptPayload(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`
    );
    if (!response.ok) {
      const upstreamMessage =
        typeof payload?.error === "string" ? payload.error :
        typeof payload?.message === "string" ? payload.message :
        `HTTP ${response.status}`;
      throw new Error(`Transcript polling failed: ${upstreamMessage}`);
    }
    const status = typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
    if (status === "completed") {
      return payload;
    }
    if (status === "failed") {
      throw new Error(typeof payload?.error === "string" ? payload.error : "Transcript generation failed.");
    }
  }

  throw new Error("Transcript request timed out. Try another video.");
}

async function fetchYoutubeTranscript(videoId: string): Promise<TranscriptResult> {
  const cached = getCachedTranscript(videoId);
  if (cached) {
    return cached;
  }

  const inFlight = transcriptInFlight.get(videoId);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    const params = new URLSearchParams({
      url: getYouTubeVideoUrl(videoId),
      mode: "native",
      text: "false",
      lang: "en",
    });
    const { response, payload } = await fetchSupadataTranscriptPayload(
      `https://api.supadata.ai/v1/transcript?${params.toString()}`
    );

    if (response.status === 206) {
      throw new Error("No transcript is available for this video. Pick another regular video.");
    }

    if (response.status === 202 && typeof payload?.jobId === "string" && payload.jobId.trim()) {
      const result = normalizeSupadataTranscriptPayload(await pollSupadataTranscriptJob(payload.jobId.trim()));
      setCachedTranscript(videoId, result);
      return result;
    }

    if (!response.ok) {
      const upstreamMessage =
        typeof payload?.error === "string" ? payload.error :
        typeof payload?.message === "string" ? payload.message :
        `HTTP ${response.status}`;
      throw new Error(`Transcript request failed: ${upstreamMessage}`);
    }

    const result = normalizeSupadataTranscriptPayload(payload || {});
    setCachedTranscript(videoId, result);
    return result;
  })();

  transcriptInFlight.set(videoId, request);
  try {
    return await request;
  } finally {
    transcriptInFlight.delete(videoId);
  }
}

function normalizeRecipeGuideResponse(raw: unknown) {
  if (!raw || typeof raw !== "object") return raw;
  const value = raw as Record<string, unknown>;
  return {
    ingredients: Array.isArray(value.ingredients) ? value.ingredients : [],
    equipment: Array.isArray(value.equipment) ? value.equipment : [],
    steps: Array.isArray(value.steps) ? value.steps : [],
  };
}

type GuidePromptChunkContext = {
  chunkIndex: number;
  chunkCount: number;
  startSeconds: number;
  endSeconds: number;
};

function formatRecipeGuidePrompt(
  input: z.infer<typeof RecipeGenerateRequestSchema>,
  transcriptText: string,
  chunkContext?: GuidePromptChunkContext
) {
  const isChunked = Boolean(chunkContext && chunkContext.chunkCount > 1);
  return [
    "Create a practical cooking guide from a YouTube recipe transcript.",
    "Return only JSON with shape:",
    "{\"ingredients\":[{\"name\":\"\",\"quantity\":\"\",\"note\":\"\"}],\"equipment\":[{\"name\":\"\",\"required\":true,\"note\":\"\"}],\"steps\":[{\"title\":\"\",\"body\":\"\",\"timestampSeconds\":0,\"durationSeconds\":0}]}",
    "",
    "Rules:",
    "- Use the transcript as the source of truth.",
    "- Include ingredients and tools/equipment mentioned or clearly required.",
    "- Keep equipment practical, like oven, pan, blender, frother, whisk, thermometer, not generic bowls unless specifically important.",
    "- Steps must be ordered and specific enough to cook from.",
    "- Every step must include timestampSeconds from the closest relevant transcript line.",
    "- Use timestampSeconds as integer seconds, not mm:ss text.",
    "- Do not invent exact quantities if the transcript does not provide them; omit quantity or use a cautious note.",
    "- Respect dietary preference when it is compatible with the recipe. If not compatible, mention a substitution in ingredient notes.",
    isChunked ? `- This transcript excerpt is chunk ${(chunkContext?.chunkIndex || 0) + 1} of ${chunkContext?.chunkCount}, covering ${chunkContext?.startSeconds}s to ${chunkContext?.endSeconds}s of the full video.` : "",
    isChunked ? "- Only include ingredients, equipment, and cooking actions supported by this chunk." : "",
    isChunked ? "- Usually return 1-8 steps for this chunk instead of trying to summarize the whole video at once." : "",
    "",
    `Recipe todo: ${input.title}`,
    input.details ? `Todo details: ${input.details}` : "",
    input.answers?.dietary ? `Dietary preference: ${input.answers.dietary}` : "Dietary preference: none",
    `Selected video: ${input.selectedVideo.title} by ${input.selectedVideo.channelTitle || "unknown channel"}`,
    "",
    "Transcript:",
    transcriptText,
  ].filter(Boolean).join("\n");
}

function formatMergedRecipeGuidePrompt(
  input: z.infer<typeof RecipeGenerateRequestSchema>,
  guides: z.infer<typeof RecipeGeneratedGuideSchema>[],
  chunks: TranscriptPromptChunk[]
) {
  const payload = guides.map((guide, index) => ({
    chunkIndex: index + 1,
    startSeconds: chunks[index]?.startSeconds || 0,
    endSeconds: chunks[index]?.endSeconds || 0,
    ingredients: guide.ingredients,
    equipment: guide.equipment,
    steps: guide.steps,
  }));

  return [
    "Combine partial recipe guides from sequential transcript chunks of the same YouTube video into one final full-video cooking guide.",
    "Return only JSON with shape:",
    "{\"ingredients\":[{\"name\":\"\",\"quantity\":\"\",\"note\":\"\"}],\"equipment\":[{\"name\":\"\",\"required\":true,\"note\":\"\"}],\"steps\":[{\"title\":\"\",\"body\":\"\",\"timestampSeconds\":0,\"durationSeconds\":0}]}",
    "",
    "Rules:",
    "- Produce one coherent guide for the entire video, not one section per chunk.",
    "- Deduplicate repeated ingredients, equipment, and repeated steps across chunks.",
    "- Keep steps in ascending timestampSeconds order.",
    "- Make sure the final steps cover the full recipe timeline, including later-video steps when the chunk guides support them.",
    "- Preserve integer timestampSeconds from the chunk guides.",
    "- Keep 6-24 steps total.",
    "- Do not invent quantities or actions that are not present in the chunk guides.",
    "",
    `Recipe todo: ${input.title}`,
    input.details ? `Todo details: ${input.details}` : "",
    input.answers?.dietary ? `Dietary preference: ${input.answers.dietary}` : "Dietary preference: none",
    `Selected video: ${input.selectedVideo.title} by ${input.selectedVideo.channelTitle || "unknown channel"}`,
    "",
    "Chunk guides JSON:",
    JSON.stringify(payload),
  ].filter(Boolean).join("\n");
}

function formatRecipeAnswerPrompt(input: z.infer<typeof RecipeAnswerRequestSchema>) {
  const steps = input.steps
    .map((step, index) => `${index + 1}. ${step.title} [${step.timestampSeconds ?? 0}s]\n${step.body}`)
    .join("\n");
  const conversation = input.conversation.length
    ? input.conversation.map((message) => `${message.role}: ${message.content}`).join("\n")
    : "No prior recipe chat.";
  const activeStep = input.steps[input.activeStepIndex];

  return [
    "Answer a user's cooking question about the current recipe guide.",
    "Return only JSON with shape {\"answer\":\"...\",\"action\":\"answer|recipe_change\",\"recipeTitle\":\"...\",\"suggestedStepIndex\":0}.",
    "Use suggestedStepIndex only when your answer clearly refers to a step.",
    "Use action recipe_change only when the user clearly wants to switch the whole recipe, dish, main ingredient, or core flavor, such as changing chocolate cake to blueberry cake or chicken curry to paneer curry.",
    "When action is recipe_change, set recipeTitle to a short searchable recipe title for the new recipe, and answer with one concise sentence saying this changes the main recipe and new videos can be found.",
    "Keep action answer for small substitutions, optional additions, dietary tweaks, quantities, equipment, timing, doneness, or ingredient questions like sugar, oil, salt, spices, eggs, milk, flour, baking powder, or vanilla.",
    "Be concise, practical, and safe. If the user asks about doneness or food safety, give concrete checks.",
    "",
    `Recipe: ${input.title}`,
    input.details ? `Todo details: ${input.details}` : "",
    input.answers?.dietary ? `Dietary preference: ${input.answers.dietary}` : "",
    input.selectedVideo ? `Selected video: ${input.selectedVideo.title} by ${input.selectedVideo.channelTitle || "unknown channel"}` : "",
    activeStep ? `Active step ${input.activeStepIndex + 1}: ${activeStep.title} - ${activeStep.body}` : "",
    "",
    `Ingredients: ${JSON.stringify(input.ingredients)}`,
    `Equipment: ${JSON.stringify(input.equipment)}`,
    "",
    "Steps:",
    steps || "No generated steps.",
    "",
    "Recent chat:",
    conversation,
    "",
    `User question: ${input.question}`,
  ].filter(Boolean).join("\n");
}

function normalizeTodoTaskKind(value: unknown): z.infer<typeof TodoTaskKindSchema> {
  return value === "recipe" || value === "skill" ? value : "normal";
}

function normalizeGoalQuotaUnitType(value: unknown): z.infer<typeof GoalQuotaUnitTypeSchema> {
  return value === "distinct_days" ? "distinct_days" : "count";
}

function normalizeGoalQuotaClassification(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const targetCount = Math.floor(Number(value.targetCount));
  const unitType = normalizeGoalQuotaUnitType(value.unitType);
  const maxTargetCount = unitType === "distinct_days" ? 366 : 10000;
  if (!Number.isFinite(targetCount) || targetCount < 1 || targetCount > maxTargetCount) {
    return undefined;
  }
  const unitLabel =
    typeof value.unitLabel === "string" && value.unitLabel.trim().length > 0
      ? value.unitLabel.trim().slice(0, 80)
      : unitType === "distinct_days"
        ? "days"
        : "times";

  return {
    targetCount,
    unitLabel,
    unitType,
  };
}

function normalizeTodoClassificationResponse(raw: unknown, workspace?: string, goalTimeframe?: string) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const value = raw as Record<string, unknown>;
  const confidence = Number(value.confidence);
  const quota = normalizeGoalQuotaClassification(value.quota || value);
  const canUseQuota = workspace === "Goals" && goalTimeframe !== "longTerm" && value.goalBehavior === "quota" && quota;
  return {
    kind: normalizeTodoTaskKind(value.kind),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(confidence, 1)) : 0.5,
    goalBehavior: canUseQuota ? "quota" : "standard",
    ...(canUseQuota ? { quota } : {}),
  };
}

function getLocalDateKey(date: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {}

  return date.toISOString().slice(0, 10);
}

function normalizeDateKey(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeGoalQuotaDateResolution(raw: unknown, todayKey: string) {
  if (!raw || typeof raw !== "object") {
    return { intent: "needs_clarification", message: "I could not tell which date you meant. Please type a clearer date." };
  }

  const value = raw as Record<string, unknown>;
  const rawIntent = typeof value.intent === "string" ? value.intent : "";
  const intent = GoalQuotaDateResolveIntentSchema.safeParse(rawIntent).success
    ? rawIntent
    : undefined;
  const dateKey = normalizeDateKey(value.dateIso || value.date);
  const label =
    typeof value.label === "string" && value.label.trim().length > 0
      ? value.label.trim().slice(0, 80)
      : undefined;
  const message =
    typeof value.message === "string" && value.message.trim().length > 0
      ? value.message.trim().slice(0, 300)
      : undefined;

  if (intent === "none" || intent === "open_picker" || intent === "decide_later") {
    return {
      intent,
      ...(message ? { message } : {}),
    };
  }

  if (intent === "needs_clarification") {
    return { intent, message: message || "I could not tell which date you meant. Please type a clearer date." };
  }

  if (!intent && !dateKey) {
    return { intent: "needs_clarification", message: message || "I could not tell which date you meant. Please type a clearer date." };
  }

  if (!dateKey) {
    return { intent: "needs_clarification", message: message || "I could not tell which date you meant. Please type a clearer date." };
  }

  if (dateKey < todayKey) {
    return { intent: "needs_clarification", message: "Pick today or a future date." };
  }

  return {
    intent: "schedule_date",
    dateIso: dateKey,
    ...(label ? { label } : {}),
    ...(message ? { message } : {}),
  };
}

function buildSkillVideoSearchQuery(input: z.infer<typeof SkillVideosRequestSchema>) {
  return normalizeRecipeSearchText(`${input.title} tutorial`);
}

function getSkillSearchTerms(input: z.infer<typeof SkillVideosRequestSchema>) {
  const genericTerms = new Set([
    "learn",
    "learning",
    "practice",
    "practicing",
    "tutorial",
    "lesson",
    "walkthrough",
    "guide",
    "how",
    "to",
    "basic",
    "basics",
    "beginner",
    "beginners",
    "skill",
    "skills",
  ]);

  return normalizeRecipeSearchText(`${input.title} ${input.details || ""}`)
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !genericTerms.has(term));
}

function rankSkillVideos(
  videos: z.infer<typeof SkillVideoSchema>[],
  input: z.infer<typeof SkillVideosRequestSchema>
) {
  const learningPattern = /\b(tutorial|lesson|walkthrough|practice|technique|drill|exercise|how to|beginner|fundamentals|basics|training|course)\b/i;
  const targetTitle = normalizeRecipeSearchText(input.title).toLowerCase();
  const targetTerms = getSkillSearchTerms(input);
  return [...videos].sort((a, b) => {
    const aTitle = normalizeRecipeSearchText(a.title).toLowerCase();
    const bTitle = normalizeRecipeSearchText(b.title).toLowerCase();
    const aDuration = a.durationSeconds || 0;
    const bDuration = b.durationSeconds || 0;
    const aMatchedTerms = targetTerms.filter((term) => aTitle.includes(term)).length;
    const bMatchedTerms = targetTerms.filter((term) => bTitle.includes(term)).length;
    const aMissingTerms = Math.max(0, targetTerms.length - aMatchedTerms);
    const bMissingTerms = Math.max(0, targetTerms.length - bMatchedTerms);
    const aScore =
      (aTitle.includes(targetTitle) ? 18 : 0) +
      (targetTerms.length > 0 && aMatchedTerms === targetTerms.length ? 14 : 0) +
      aMatchedTerms * 6 +
      aMissingTerms * -7 +
      (learningPattern.test(a.title) ? 7 : 0) +
      (aDuration >= 240 && aDuration <= 2700 ? 5 : 0) +
      Math.min(Math.log10((a.viewCount || 0) + 1), 7);
    const bScore =
      (bTitle.includes(targetTitle) ? 18 : 0) +
      (targetTerms.length > 0 && bMatchedTerms === targetTerms.length ? 14 : 0) +
      bMatchedTerms * 6 +
      bMissingTerms * -7 +
      (learningPattern.test(b.title) ? 7 : 0) +
      (bDuration >= 240 && bDuration <= 2700 ? 5 : 0) +
      Math.min(Math.log10((b.viewCount || 0) + 1), 7);
    return bScore - aScore;
  });
}

async function searchRegularYoutubeSkillVideos(input: z.infer<typeof SkillVideosRequestSchema>) {
  const query = await refineVideoSearchQuery(input, buildSkillVideoSearchQuery(input), "skill");
  const videos = await fetchRegularYoutubeRecipeVideosForQuery(query, input.locale || "en-US,en;q=0.9");
  const rankedCandidates = rankSkillVideos(videos, input);
  const nextVideos = excludeVideosById(rankedCandidates, input.excludeVideoIds);

  return {
    query,
    videos: nextVideos.slice(0, 5),
  };
}

function normalizeSkillGuideResponse(raw: unknown) {
  if (!raw || typeof raw !== "object") return raw;
  const value = raw as Record<string, unknown>;
  return {
    steps: Array.isArray(value.steps) ? value.steps : [],
  };
}

function formatSkillGuidePrompt(
  input: z.infer<typeof SkillGenerateRequestSchema>,
  transcriptText: string,
  chunkContext?: GuidePromptChunkContext
) {
  const isChunked = Boolean(chunkContext && chunkContext.chunkCount > 1);
  return [
    "Create a practical skill-learning guide from a YouTube lesson transcript.",
    "Return only JSON with shape:",
    "{\"steps\":[{\"title\":\"\",\"body\":\"\",\"timestampSeconds\":0,\"durationSeconds\":0}]}",
    "",
    "Rules:",
    "- Use the transcript as the source of truth.",
    "- Break the lesson into ordered practice steps a learner can actually follow.",
    "- Include setup, posture/form, checkpoints, repetitions, or common mistakes only when the transcript supports them.",
    "- Every step must include timestampSeconds from the closest relevant transcript line.",
    "- Use timestampSeconds as integer seconds, not mm:ss text.",
    "- Keep each body concise, specific, and learner-focused.",
    "- Do not include ingredients, cooking equipment, or recipe behavior.",
    "- Do not invent drills, durations, or prerequisites that the transcript does not support.",
    isChunked ? `- This transcript excerpt is chunk ${(chunkContext?.chunkIndex || 0) + 1} of ${chunkContext?.chunkCount}, covering ${chunkContext?.startSeconds}s to ${chunkContext?.endSeconds}s of the full video.` : "",
    isChunked ? "- Only include learner actions supported by this chunk." : "",
    isChunked ? "- Usually return 1-8 steps for this chunk instead of trying to summarize the whole lesson at once." : "",
    "",
    `Skill todo: ${input.title}`,
    input.details ? `Todo details: ${input.details}` : "",
    `Selected video: ${input.selectedVideo.title} by ${input.selectedVideo.channelTitle || "unknown channel"}`,
    "",
    "Transcript:",
    transcriptText,
  ].filter(Boolean).join("\n");
}

function formatMergedSkillGuidePrompt(
  input: z.infer<typeof SkillGenerateRequestSchema>,
  guides: z.infer<typeof SkillGeneratedGuideSchema>[],
  chunks: TranscriptPromptChunk[]
) {
  const payload = guides.map((guide, index) => ({
    chunkIndex: index + 1,
    startSeconds: chunks[index]?.startSeconds || 0,
    endSeconds: chunks[index]?.endSeconds || 0,
    steps: guide.steps,
  }));

  return [
    "Combine partial skill-learning guides from sequential transcript chunks of the same YouTube video into one final full-video guide.",
    "Return only JSON with shape:",
    "{\"steps\":[{\"title\":\"\",\"body\":\"\",\"timestampSeconds\":0,\"durationSeconds\":0}]}",
    "",
    "Rules:",
    "- Produce one coherent guide for the entire lesson, not one section per chunk.",
    "- Deduplicate repeated steps across chunks.",
    "- Keep steps in ascending timestampSeconds order.",
    "- Make sure the final steps cover the full lesson timeline, including later-video sections when the chunk guides support them.",
    "- Preserve integer timestampSeconds from the chunk guides.",
    "- Keep 6-24 steps total.",
    "- Do not invent drills, checkpoints, or prerequisites that the chunk guides do not support.",
    "",
    `Skill todo: ${input.title}`,
    input.details ? `Todo details: ${input.details}` : "",
    `Selected video: ${input.selectedVideo.title} by ${input.selectedVideo.channelTitle || "unknown channel"}`,
    "",
    "Chunk guides JSON:",
    JSON.stringify(payload),
  ].filter(Boolean).join("\n");
}

function formatSkillAnswerPrompt(input: z.infer<typeof SkillAnswerRequestSchema>) {
  const steps = input.steps
    .map((step, index) => `${index + 1}. ${step.title} [${step.timestampSeconds ?? 0}s]\n${step.body}`)
    .join("\n");
  const conversation = input.conversation.length
    ? input.conversation.map((message) => `${message.role}: ${message.content}`).join("\n")
    : "No prior skill chat.";
  const activeStep = input.steps[input.activeStepIndex];

  return [
    "Answer a user's question about the current skill-learning guide.",
    "Return only JSON with shape {\"answer\":\"...\",\"suggestedStepIndex\":0}.",
    "Use suggestedStepIndex only when your answer clearly refers to a step.",
    "Be concise, practical, and instructional. Prefer concrete checks, form cues, or next actions over generic encouragement.",
    "",
    `Skill: ${input.title}`,
    input.details ? `Todo details: ${input.details}` : "",
    input.selectedVideo ? `Selected video: ${input.selectedVideo.title} by ${input.selectedVideo.channelTitle || "unknown channel"}` : "",
    activeStep ? `Active step ${input.activeStepIndex + 1}: ${activeStep.title} - ${activeStep.body}` : "",
    "",
    "Steps:",
    steps || "No generated steps.",
    "",
    "Recent chat:",
    conversation,
    "",
    `User question: ${input.question}`,
  ].filter(Boolean).join("\n");
}

function formatSavedGuidanceAnswerPrompt(input: z.infer<typeof SavedGuidanceAnswerRequestSchema>) {
  const steps = input.steps
    .map((step, index) => {
      const detail = step.body || step.details || "";
      return `${index + 1}. ${step.title}${step.completed ? " [done]" : ""}${detail ? `\n${detail}` : ""}`;
    })
    .join("\n");
  const conversation = input.conversation.length
    ? input.conversation.map((message) => `${message.role}: ${message.content}`).join("\n")
    : "No prior guidance chat.";
  const activeStep = input.steps[input.activeStepIndex];

  return [
    input.guideType === "goal"
      ? "Answer a user's question about an already-saved todo-tab goal guidance plan."
      : "Answer a user's question about an already-saved normal task guide.",
    "Return only JSON with shape {\"answer\":\"...\",\"suggestedStepIndex\":0}.",
    "Use suggestedStepIndex only when your answer clearly refers to a step.",
    "Do not create, rewrite, reorder, add, remove, or claim to save steps.",
    "Be concise and practical. Use the saved guide as the anchor, but do not refuse harmless adjacent help just because the exact answer is not written in the saved guide.",
    "You may answer tactical how-to questions, quick definitions, lightweight troubleshooting, or requests for relevant resources/links when they support the saved step or overall guide.",
    "For link requests, provide a direct useful URL when it is stable and known; otherwise provide a concise search URL or search phrase the user can open.",
    "If the user asks for plan changes, new steps, unrelated work, or anything requiring app actions/tools, say that chat can answer questions but cannot change saved guidance here.",
    "",
    `Title: ${input.title}`,
    input.details ? `Details: ${input.details}` : "",
    input.status ? `Saved status: ${input.status}` : "",
    activeStep ? `Current step ${input.activeStepIndex + 1}: ${activeStep.title} - ${activeStep.body || activeStep.details || ""}` : "",
    `User timezone: ${input.userTimezone}`,
    `Locale: ${input.locale}`,
    "",
    "Saved steps:",
    steps,
    "",
    "Recent guidance chat:",
    conversation,
    "",
    `User question: ${input.question}`,
  ].filter(Boolean).join("\n");
}

function normalizeGuideMergeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function dedupeRecipeIngredients(ingredients: z.infer<typeof RecipeIngredientSchema>[]) {
  const deduped = new Map<string, z.infer<typeof RecipeIngredientSchema>>();
  for (const ingredient of ingredients) {
    const key = normalizeGuideMergeKey(ingredient.name);
    if (!key) {
      continue;
    }

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { ...ingredient });
      continue;
    }

    if (!existing.quantity && ingredient.quantity) {
      existing.quantity = ingredient.quantity;
    }
    if (!existing.note && ingredient.note) {
      existing.note = ingredient.note;
    }
  }

  return Array.from(deduped.values()).slice(0, 40);
}

function dedupeRecipeEquipment(equipment: z.infer<typeof RecipeEquipmentSchema>[]) {
  const deduped = new Map<string, z.infer<typeof RecipeEquipmentSchema>>();
  for (const item of equipment) {
    const key = normalizeGuideMergeKey(item.name);
    if (!key) {
      continue;
    }

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { ...item });
      continue;
    }

    existing.required = Boolean(existing.required || item.required);
    if (!existing.note && item.note) {
      existing.note = item.note;
    }
  }

  return Array.from(deduped.values()).slice(0, 20);
}

function dedupeOrderedSteps<T extends { title: string; body: string; timestampSeconds?: number; durationSeconds?: number }>(steps: T[]) {
  const sorted = [...steps].sort(
    (a, b) => (a.timestampSeconds ?? Number.MAX_SAFE_INTEGER) - (b.timestampSeconds ?? Number.MAX_SAFE_INTEGER)
  );
  const deduped: T[] = [];
  const seen = new Set<string>();

  for (const step of sorted) {
    const titleKey = normalizeGuideMergeKey(step.title);
    const bodyKey = normalizeGuideMergeKey(step.body);
    const timestampBucket = Math.floor((step.timestampSeconds ?? -60) / 60);
    const exactKey = `${titleKey}|${bodyKey}|${timestampBucket}`;
    if (seen.has(exactKey)) {
      continue;
    }

    const previous = deduped[deduped.length - 1];
    if (
      previous &&
      normalizeGuideMergeKey(previous.title) === titleKey &&
      Math.abs((previous.timestampSeconds ?? -3600) - (step.timestampSeconds ?? -3600)) <= 90
    ) {
      continue;
    }

    seen.add(exactKey);
    deduped.push(step);
  }

  return deduped;
}

function limitOrderedStepsAcrossTimeline<T>(steps: T[], maxSteps: number) {
  if (steps.length <= maxSteps) {
    return steps;
  }
  if (maxSteps <= 1) {
    return steps.slice(0, 1);
  }

  const selected: T[] = [];
  let lastIndex = -1;
  for (let slot = 0; slot < maxSteps; slot += 1) {
    const rawIndex = Math.round((slot * (steps.length - 1)) / (maxSteps - 1));
    const index = Math.max(lastIndex + 1, Math.min(rawIndex, steps.length - (maxSteps - slot)));
    selected.push(steps[index]);
    lastIndex = index;
  }

  return selected;
}

function mergeRecipeGuideFallback(guides: z.infer<typeof RecipeGeneratedGuideSchema>[]) {
  return {
    ingredients: dedupeRecipeIngredients(guides.flatMap((guide) => guide.ingredients)),
    equipment: dedupeRecipeEquipment(guides.flatMap((guide) => guide.equipment)),
    steps: limitOrderedStepsAcrossTimeline(
      dedupeOrderedSteps(guides.flatMap((guide) => guide.steps)),
      24
    ),
  } satisfies z.infer<typeof RecipeGeneratedGuideSchema>;
}

function mergeSkillGuideFallback(guides: z.infer<typeof SkillGeneratedGuideSchema>[]) {
  return {
    steps: limitOrderedStepsAcrossTimeline(
      dedupeOrderedSteps(guides.flatMap((guide) => guide.steps)),
      24
    ),
  } satisfies z.infer<typeof SkillGeneratedGuideSchema>;
}

async function generateRecipeGuideFromTranscript(
  input: z.infer<typeof RecipeGenerateRequestSchema>,
  transcript: TranscriptSegment[]
) {
  const transcriptChunks = buildTranscriptPromptChunks(transcript, TRANSCRIPT_PROMPT_CHUNK_CHAR_LIMIT);
  if (!transcriptChunks.length) {
    throw new Error("No transcript text is available for this video. Pick another regular video.");
  }

  const guides: z.infer<typeof RecipeGeneratedGuideSchema>[] = [];
  for (let index = 0; index < transcriptChunks.length; index += 1) {
    const chunk = transcriptChunks[index];
    const result = await openaiChat({
      model: "gpt-5.4-mini",
      temperature: 0,
      maxTokens: 3200,
      messages: [
        {
          role: "system",
          content: "You create timestamped recipe guides from video transcripts. Return only strict JSON.",
        },
        {
          role: "user",
          content: formatRecipeGuidePrompt(input, chunk.transcript, {
            chunkIndex: index,
            chunkCount: transcriptChunks.length,
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
          }),
        },
      ],
    });

    const raw = normalizeRecipeGuideResponse(parseModelJson(result.message.content));
    const validated = RecipeGeneratedGuideSchema.safeParse(raw);
    if (!validated.success) {
      throw new InvalidGuideResponseError("Invalid recipe guide response");
    }

    guides.push(validated.data);
  }

  if (guides.length === 1) {
    return guides[0];
  }

  try {
    const result = await openaiChat({
      model: "gpt-5.4-mini",
      temperature: 0,
      maxTokens: 3200,
      messages: [
        {
          role: "system",
          content: "You combine chunked recipe guides into one final timestamped recipe guide. Return only strict JSON.",
        },
        {
          role: "user",
          content: formatMergedRecipeGuidePrompt(input, guides, transcriptChunks),
        },
      ],
    });

    const raw = normalizeRecipeGuideResponse(parseModelJson(result.message.content));
    const validated = RecipeGeneratedGuideSchema.safeParse(raw);
    if (validated.success) {
      return validated.data;
    }
  } catch (err: any) {
    console.warn("[recipe/generate] merge fallback:", err?.message || err);
  }

  return mergeRecipeGuideFallback(guides);
}

async function generateSkillGuideFromTranscript(
  input: z.infer<typeof SkillGenerateRequestSchema>,
  transcript: TranscriptSegment[]
) {
  const transcriptChunks = buildTranscriptPromptChunks(transcript, TRANSCRIPT_PROMPT_CHUNK_CHAR_LIMIT);
  if (!transcriptChunks.length) {
    throw new Error("No transcript text is available for this video. Pick another regular video.");
  }

  const guides: z.infer<typeof SkillGeneratedGuideSchema>[] = [];
  for (let index = 0; index < transcriptChunks.length; index += 1) {
    const chunk = transcriptChunks[index];
    const result = await openaiChat({
      model: "gpt-5.4-mini",
      temperature: 0,
      maxTokens: 2800,
      messages: [
        {
          role: "system",
          content: "You create timestamped skill-learning guides from video transcripts. Return only strict JSON.",
        },
        {
          role: "user",
          content: formatSkillGuidePrompt(input, chunk.transcript, {
            chunkIndex: index,
            chunkCount: transcriptChunks.length,
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
          }),
        },
      ],
    });

    const raw = normalizeSkillGuideResponse(parseModelJson(result.message.content));
    const validated = SkillGeneratedGuideSchema.safeParse(raw);
    if (!validated.success) {
      throw new InvalidGuideResponseError("Invalid skill guide response");
    }

    guides.push(validated.data);
  }

  if (guides.length === 1) {
    return guides[0];
  }

  try {
    const result = await openaiChat({
      model: "gpt-5.4-mini",
      temperature: 0,
      maxTokens: 2800,
      messages: [
        {
          role: "system",
          content: "You combine chunked skill-learning guides into one final timestamped skill guide. Return only strict JSON.",
        },
        {
          role: "user",
          content: formatMergedSkillGuidePrompt(input, guides, transcriptChunks),
        },
      ],
    });

    const raw = normalizeSkillGuideResponse(parseModelJson(result.message.content));
    const validated = SkillGeneratedGuideSchema.safeParse(raw);
    if (validated.success) {
      return validated.data;
    }
  } catch (err: any) {
    console.warn("[skill/generate] merge fallback:", err?.message || err);
  }

  return mergeSkillGuideFallback(guides);
}

const GOAL_GUIDANCE_VIDEO_INTENT_PATTERN =
  /\b(tutorial|how to|demo|demonstration|walkthrough|technique|form|drill|lesson|exercise|workout|repair|install|setup|configure|build|cook|recipe)\b/;
const GOAL_GUIDANCE_WEAK_VIDEO_QUERY_PATTERN =
  /\b(tips|ideas|motivation|inspiration|routine|plan|schedule|strategy|guide|explained|basics|beginner|productivity)\b/;
const GOAL_GUIDANCE_VIDEO_STEP_PATTERN =
  /\b(learn|practice|install|set up|setup|configure|build|repair|fix|cook|bake|workout|exercise|stretch|draw|paint|play|record|edit|code|debug|present|demo)\b/;

function normalizeGoalGuidanceYoutubeQuery(step: unknown) {
  if (!step || typeof step !== "object") {
    return undefined;
  }

  const value = step as Record<string, unknown>;
  const query = typeof value.youtubeQuery === "string" ? value.youtubeQuery.trim() : "";
  if (!query) {
    return undefined;
  }

  const title = typeof value.title === "string" ? value.title.trim().toLowerCase() : "";
  const normalized = query.toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const hasInstructionIntent = GOAL_GUIDANCE_VIDEO_INTENT_PATTERN.test(normalized);
  const isLikelyVideoStep = GOAL_GUIDANCE_VIDEO_STEP_PATTERN.test(title);
  const isWeakGenericQuery = words.length < 4 || words.length > 10 || GOAL_GUIDANCE_WEAK_VIDEO_QUERY_PATTERN.test(normalized);

  return hasInstructionIntent && isLikelyVideoStep && !isWeakGenericQuery ? query : undefined;
}

function normalizeGoalGuidanceResponse(raw: unknown, input?: z.infer<typeof GoalGuidanceRequestSchema>) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const value = raw as Record<string, unknown>;
  const goalTitle = typeof value.goalTitle === "string" && value.goalTitle.trim().length > 0
    ? value.goalTitle.trim()
    : undefined;
  const alternativeTimeframe = GoalGuidanceTimeframeSchema.safeParse(value.alternativeTimeframe).success
    ? value.alternativeTimeframe
    : undefined;
  const alternativeGoalTitle =
    typeof value.alternativeGoalTitle === "string" && value.alternativeGoalTitle.trim().length > 0
      ? value.alternativeGoalTitle.trim()
      : undefined;
  const steps = Array.isArray(value.steps)
    ? value.steps
        .map((step) => ({
          ...(step && typeof step === "object" ? step as Record<string, unknown> : {}),
          title: typeof (step as Record<string, unknown> | null)?.title === "string"
            ? String((step as Record<string, unknown>).title).trim()
            : "",
          details: typeof (step as Record<string, unknown> | null)?.details === "string"
            ? String((step as Record<string, unknown>).details).trim()
            : undefined,
          youtubeQuery: normalizeGoalGuidanceYoutubeQuery(step),
        }))
        .filter((step) => step.title.length > 0)
    : [];
  if (input?.mode === "cram" && value.type === "not_feasible" && steps.length > 0) {
    return {
      ...value,
      type: "plan",
      goalTitle,
      feasibility: "unrealistic",
      feasibilityNote: typeof value.feasibilityNote === "string" && value.feasibilityNote.trim().length > 0
        ? value.feasibilityNote.trim()
        : "This is a compressed try-anyway plan for the current deadline.",
      alternativeSuggestion: undefined,
      alternativeTimeframe: undefined,
      alternativeGoalTitle: undefined,
      steps,
    };
  }

  if (
    value.type === "plan" &&
    input?.timeframe === "thisWeek" &&
    input.mode !== "cram" &&
    value.feasibility === "unrealistic"
  ) {
    return {
      ...value,
      type: "not_feasible",
      goalTitle: undefined,
      feasibility: "unrealistic",
      feasibilityNote: typeof value.feasibilityNote === "string" && value.feasibilityNote.trim().length > 0
        ? value.feasibilityNote.trim()
        : "You can make meaningful progress this week, while the full goal needs more time.",
      alternativeSuggestion: typeof value.alternativeSuggestion === "string" && value.alternativeSuggestion.trim().length > 0
        ? value.alternativeSuggestion.trim()
        : "Change this to a monthly goal so the steps can build toward the full target.",
      alternativeTimeframe: "thisMonth",
      alternativeGoalTitle,
      steps: [],
    };
  }

  if (value.type === "plan" && steps.length === 0) {
    const fallbackAlternativeTimeframe =
      alternativeTimeframe ||
      (input?.timeframe === "thisWeek" ? "thisMonth" : undefined);
    return {
      ...value,
      type: "not_feasible",
      goalTitle: undefined,
      feasibility: value.feasibility === "tight" || value.feasibility === "realistic"
        ? value.feasibility
        : "unrealistic",
      feasibilityNote: typeof value.feasibilityNote === "string" && value.feasibilityNote.trim().length > 0
        ? value.feasibilityNote.trim()
        : "You can still make meaningful progress now, while the full goal needs more time.",
      alternativeSuggestion: typeof value.alternativeSuggestion === "string" && value.alternativeSuggestion.trim().length > 0
        ? value.alternativeSuggestion.trim()
        : fallbackAlternativeTimeframe === "thisMonth"
          ? "Use a monthly version so the steps can build safely toward this goal."
          : undefined,
      alternativeTimeframe: fallbackAlternativeTimeframe,
      alternativeGoalTitle,
      steps: [],
    };
  }

  if (value.type === "not_feasible") {
    return {
      ...value,
      goalTitle: undefined,
      alternativeTimeframe,
      alternativeGoalTitle,
      steps: [],
    };
  }

  if (value.type !== "clarify") {
    return {
      ...value,
      goalTitle,
      alternativeTimeframe: undefined,
      alternativeGoalTitle: undefined,
      steps,
    };
  }

  const questions = Array.isArray(value.questions)
    ? value.questions.filter((question): question is string => typeof question === "string" && question.trim().length > 0)
    : [];

  return {
    ...value,
    question: typeof value.question === "string" && value.question.trim().length > 0
      ? value.question
      : questions.join("\n"),
    goalTitle: undefined,
    alternativeTimeframe: undefined,
    alternativeGoalTitle: undefined,
    feasibility: value.feasibility || "realistic",
    feasibilityNote: typeof value.feasibilityNote === "string" ? value.feasibilityNote : "",
    steps: [],
  };
}

function normalizeTaskGuidanceResponse(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const value = raw as Record<string, unknown>;
  const steps = Array.isArray(value.steps)
    ? value.steps
        .map((step) => ({
          ...(step && typeof step === "object" ? step as Record<string, unknown> : {}),
          title: typeof (step as Record<string, unknown> | null)?.title === "string"
            ? String((step as Record<string, unknown>).title).trim()
            : "",
          details: typeof (step as Record<string, unknown> | null)?.details === "string"
            ? String((step as Record<string, unknown>).details).trim()
            : undefined,
          youtubeQuery: normalizeGoalGuidanceYoutubeQuery(step),
        }))
        .filter((step) => step.title.length > 0)
    : [];

  if (value.type === "clarify") {
    const questions = Array.isArray(value.questions)
      ? value.questions.filter((question): question is string => typeof question === "string" && question.trim().length > 0)
      : [];
    return {
      type: "clarify",
      question: typeof value.question === "string" && value.question.trim().length > 0
        ? value.question.trim()
        : questions.join("\n"),
      note: undefined,
      steps: [],
    };
  }

  return {
    type: "plan",
    note: typeof value.note === "string" ? value.note.trim() : undefined,
    steps,
  };
}

function parseCompactAssistantMeta(content: unknown): RouteMeta | undefined {
  if (typeof content !== "string") return undefined;
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const clarifyMatch = trimmed.match(/^CLARIFY:\s*(.+)$/is);
  if (clarifyMatch) {
    return {
      assistantKind: "clarify",
      assistantText: clarifyMatch[1].trim(),
    };
  }

  const handoffMatch = trimmed.match(/^HANDOFF:\s*(.+)$/is);
  if (handoffMatch) {
    return {
      assistantKind: "handoff",
      assistantText: handoffMatch[1].trim(),
    };
  }

  return {
    assistantKind: "message",
    assistantText: trimmed,
  };
}

function buildCompactServerSystemMessage(surface?: AssistantSurface): ChatMessage {
  return {
    role: "system",
    content: buildCompactServerSystemContent(surface),
  };
}

function buildChatServerSystemMessage(): ChatMessage {
  return {
    role: "system",
    content:
      "Use app_open_screen for full-chat app-location requests such as where is, where can I go, open, show me, or take me to Chat, Home settings and controls, Todo workspaces and controls, Calendar, or event search.\n" +
      `Available app_open_screen destinations: ${APP_SCREEN_DESTINATIONS.join(", ")}.\n` +
      "When app_open_screen can create the exact shortcut, do not reply with multi-step navigation instructions. The user navigates by tapping the shortcut card.\n" +
      "Do not use app_open_screen for requests that ask to create, search, fetch, refresh, summarize, draft, compose, or send actual content/data. Use the matching todo or calendar tool instead.\n" +
      "When the user asks to create or save a todo from steps you already gave, these steps, the steps above, or this plan, use todo_create_with_steps once. Do not create one todo per step.\n" +
      "For recurring Personal todos, pass recurrence as { interval, unit } where unit is day, week, or month. Map daily/every day to { interval: 1, unit: 'day' }, weekly to { interval: 1, unit: 'week' }, monthly to { interval: 1, unit: 'month' }, and every N days/weeks/months to the matching interval/unit. Do not add recurrence to Goals or Wishlist todos.\n" +
      "When the user asks to convert steps, a plan, or an intended goal into a todo-tab goal with actions, use goal_create_with_guidance with guidancePath actions. Quota goals do not support video guidance. When the user wants video lessons or to follow a video for a goal, use goal_create_with_guidance with guidancePath video. If they want to learn or do something by a timeframe but did not choose actions or video, ask which guidance path they want.\n" +
      "When the user asks about saved guidance progress, status, what is left, or guidance history, use guidance tools instead of answering from chat text alone.\n" +
      "When the user asks for calendar events, appointments, meetings, calls, or event keywords, use calendar tools only. Do not also call todo tools. Use one calendar read tool per turn: calendar_search for a keyworded event request, calendar_fetch_range for a broad date listing.",
  };
}

function buildAiPersonalizationSystemMessage(input: unknown): ChatMessage | null {
  const content = buildAiPersonalizationSystemContent(input);
  return content ? { role: "system", content } : null;
}

function normalizeCompactRouteMeta(meta: RouteMeta | undefined): RouteMeta | undefined {
  if (!meta) return meta;
  if (meta.assistantKind === "handoff" && typeof meta.assistantText === "string" && /^no .*action requested\.?$/i.test(meta.assistantText.trim())) {
    return {
      assistantKind: "message",
      assistantText: "What can I do for you today?",
    };
  }
  return meta;
}

type ValidatedToolCall = {
  callId: string;
  name: string;
  mode: "server" | "client";
  arguments: unknown;
  raw: OpenAIToolCall;
};

function buildAssistantToolCallMessage(result: { message: { content?: string | null }; toolCalls: OpenAIToolCall[] }): ChatMessage {
  return {
    role: "assistant",
    content: typeof result.message.content === "string" ? result.message.content : null,
    tool_calls: result.toolCalls,
  };
}

function getLatestUserText(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return "";
}

function validateToolCalls(
  toolCalls: OpenAIToolCall[],
  surface?: AssistantSurface,
  preserveCompactCalendarCreateProposal = false
) {
  const validatedCalls: ValidatedToolCall[] = [];
  const errors: Array<{ callId?: string; name?: string; error: string }> = [];
  const allowedToolNames = getAllowedToolNamesForSurface(surface);

  const preserveCalendarCreateForPolicy = (
    call: OpenAIToolCall,
    callId: string,
    name: string,
    parsedArgs: unknown
  ) => {
    if (!preserveCompactCalendarCreateProposal) return false;
    if (name !== "calendar_create") return false;
    if (allowedToolNames && !allowedToolNames.has(name)) return false;
    const def = getToolByName(name);
    if (!def) return false;
    validatedCalls.push({
      callId,
      name,
      mode: def.mode,
      arguments: parsedArgs,
      raw: {
        ...call,
        id: callId,
        function: {
          name,
          arguments: parsedArgs,
        },
      },
    });
    return true;
  };

  for (const call of toolCalls || []) {
    const callId = call.id || "";
    const name = call.function?.name || "";
    const rawArgs = call.function?.arguments;
    let parsedArgs: unknown = rawArgs;

    try {
      if (typeof rawArgs === "string") {
        parsedArgs = JSON.parse(rawArgs);
      }
    } catch {
      if (preserveCalendarCreateForPolicy(call, callId, name, {})) continue;
      errors.push({ callId, name, error: "Invalid JSON in tool arguments" });
      continue;
    }

    if (allowedToolNames && !allowedToolNames.has(name)) {
      errors.push({ callId, name, error: `Tool ${name} is not allowed on the ${surface} surface` });
      continue;
    }

    if (preserveCalendarCreateForPolicy(call, callId, name, parsedArgs)) continue;

    const validation = validateToolCall(name, parsedArgs);
    if (!validation.ok) {
      errors.push({ callId, name, error: validation.error });
      continue;
    }

    validatedCalls.push({
      callId,
      name,
      mode: validation.def.mode,
      arguments: validation.data,
      raw: {
        ...call,
        id: callId,
        function: {
          name,
          arguments: validation.data,
        },
      },
    });
  }

  return { validatedCalls, errors };
}

async function executeServerToolCall(call: ValidatedToolCall) {
  if (call.name === "web_search") {
    try {
      const result = await executeWebSearchTool(call.arguments as { query: string });
      return {
        toolMessage: {
          role: "tool" as const,
          tool_call_id: call.callId,
          content: JSON.stringify(result),
        },
        meta: {
          webSearch: true,
          webSearchQuery: result.query,
        } satisfies RouteMeta,
      };
    } catch (error: any) {
      return {
        toolMessage: {
          role: "tool" as const,
          tool_call_id: call.callId,
          content: JSON.stringify({
            query: (call.arguments as { query?: string })?.query || "",
            error: "WEB_SEARCH_FAILED",
            message: String(error?.message || error || "Web search failed"),
          }),
        },
      };
    }
  }

  throw new Error(`Unknown server tool: ${call.name}`);
}

app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = config.allowedOrigins;
      if (!origin || allowed.includes("*") || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS: Origin not allowed"));
      }
    },
    credentials: true,
  })
);

// Basic request logger
app.use((req, _res, next) => {
  try {
    // Avoid logging bodies to keep secrets safe
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  } catch {}
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

app.use("/deepgram", appCheckMiddleware, createDeepgramRouter({ apiKey: config.deepgramApiKey }));

app.use("/account", appCheckMiddleware);

app.post("/account/deletion-intent", async (req, res) => {
  try {
    const user = await verifyFirebaseRequest(req, { checkRevoked: true });
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (!isRecentAuthentication(user.authTime)) {
      return res.status(401).json({ error: "Recent authentication required" });
    }

    return res.status(200).json({
      recoveryToken: await createAccountDeletionRecoveryToken(user.uid),
    });
  } catch (error: any) {
    if (isFirebaseAuthenticationError(error)) {
      return res.status(401).json({ error: "Authentication required" });
    }
    console.error("[account-delete-intent] failed");
    return res.status(500).json({ error: "Account deletion could not start" });
  }
});

app.get("/account/deletion-status", async (req, res) => {
  const recoveryToken = req.header("x-account-deletion-recovery-token") || "";
  if (!recoveryToken) {
    return res.status(401).json({ error: "Recovery token required" });
  }

  let uid: string;
  try {
    uid = await getAccountDeletionRecoveryUid(recoveryToken);
  } catch {
    return res.status(401).json({ error: "Invalid recovery token" });
  }

  try {
    return res.status(200).json({ deleted: await getAccountDeletionStatus(uid) });
  } catch {
    console.error("[account-delete-status] failed");
    return res.status(500).json({ error: "Account deletion status unavailable" });
  }
});

app.delete("/account", async (req, res) => {
  const parse = AccountDeletionRequestSchema.safeParse(req.body || {});
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  let user: AuthenticatedUser | null;
  try {
    user = await verifyFirebaseRequest(req, { checkRevoked: true });
  } catch (error: any) {
    if (isFirebaseAuthenticationError(error)) {
      return res.status(401).json({ error: "Authentication required" });
    }
    console.error("[account-delete] authentication failed");
    return res.status(500).json({ error: "Account deletion failed" });
  }

  if (!user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  if (!isRecentAuthentication(user.authTime)) {
    return res.status(401).json({ error: "Recent authentication required" });
  }

  try {
    await deleteAuthenticatedAccount(user, parse.data.appleAuthorizationCode, parse.data.recoveryToken);
    return res.status(200).json({ deleted: true });
  } catch (error: any) {
    const message = String(error?.message || "");
    const status =
      message === "Apple authorization is required to delete this account"
        ? 400
        : isAccountDeletionRecoveryError(error)
          ? 401
          : message === APPLE_ACCOUNT_DELETION_NOT_CONFIGURED
            ? 503
            : 500;
    console.error("[account-delete] failed");
    return res.status(status).json({
      error: status === 400 || status === 401 || status === 503 ? message : "Account deletion failed",
    });
  }
});

app.post("/debug/youtube", async (req, res) => {
  const expectedToken = config.youtubeDebugToken;
  const providedToken = req.header("x-debug-token") || "";
  if (!expectedToken || providedToken !== expectedToken) {
    return res.status(404).json({ error: "Not Found" });
  }

  const parse = YoutubeDebugRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  const startedAt = Date.now();
  const input = parse.data;

  try {
    const query = normalizeRecipeSearchText(input.query);
    const parsedVideos = await fetchRegularYoutubeRecipeVideosForQuery(query, input.locale || "en-US,en;q=0.9");

    let transcriptProbe:
      | { videoId: string; ok: true; segmentCount: number; language?: string; elapsedMs: number }
      | { videoId: string; ok: false; error: string; elapsedMs: number }
      | undefined;

    if (input.videoId) {
      const transcriptStartedAt = Date.now();
      try {
        const transcript = await fetchYoutubeTranscript(input.videoId);
        transcriptProbe = {
          videoId: input.videoId,
          ok: true,
          segmentCount: transcript.segments.length,
          language: transcript.language,
          elapsedMs: Date.now() - transcriptStartedAt,
        };
      } catch (error: any) {
        transcriptProbe = {
          videoId: input.videoId,
          ok: false,
          error: String(error?.message || error || "Transcript probe failed"),
          elapsedMs: Date.now() - transcriptStartedAt,
        };
      }
    }

    return res.status(200).json({
      query,
      youtubeDataApiConfigured: Boolean(config.youtubeDataApiKey),
      supadataConfigured: Boolean(config.supadataApiKey),
      parsedRecipeVideoCount: parsedVideos.length,
      sampleVideos: parsedVideos.slice(0, 8).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        channelTitle: video.channelTitle,
        durationSeconds: video.durationSeconds,
        publishedAt: video.publishedAt,
        viewCount: video.viewCount,
      })),
      transcriptProbe,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error: any) {
    return res.status(502).json({
      query: input.query,
      error: "YouTube debug fetch failed",
      message: String(error?.message || error || "Unknown error"),
      elapsedMs: Date.now() - startedAt,
    });
  }
});

const ChatBodySchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string(),
      name: z.string().optional(),
      tool_call_id: z.string().optional(),
    })
  ),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  tools: z.any().optional(),
  toolChoice: z.any().optional(),
});

const DayPlanTodoDurationRequestSchema = z.object({
  todos: z.array(z.object({
    id: z.string().min(1).max(200),
    text: z.string().min(1).max(300),
    dueDate: z.string().optional(),
  })).min(1).max(30),
  timezone: z.string().max(120).optional(),
  locale: z.string().max(40).optional(),
});

function parseJsonObjectFromText(text: string) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(trimmed);
  } catch {}
  const match = /\{[\s\S]*\}/.exec(trimmed);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeDurationMinutes(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(15, Math.min(480, Math.round(parsed / 15) * 15));
}

app.use("/ai", appCheckMiddleware, createAiAuthMiddleware({ aiAuthRequired: config.aiAuthRequired }));

app.post("/ai/day-plan/todo-durations", async (req, res) => {
  const parse = DayPlanTodoDurationRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  const input = parse.data;
  try {
    const result = await openaiChat({
      model: AI_MODELS.lightweight,
      temperature: 0,
      maxTokens: 900,
      messages: [
        {
          role: "system",
          content:
            "You estimate how long existing timed todos occupy a day plan. Return only strict JSON. " +
            "Treat each dueDate as the task's planned start time, not merely a deadline. " +
            "Use the title, nearby timed todos, and practical productivity judgment. " +
            "If a task title implies a sustained block like deep work, study, write, build, code, prepare, proposal, project, or hard task, use a longer realistic duration. " +
            "If two timed todos are close and the earlier title sounds like a work block, it may occupy the time until the next timed todo. " +
            "Durations must be 15-480 minutes, rounded to 15-minute increments. " +
            "Return {\"durations\":[{\"id\":\"\",\"durationMinutes\":45}]} with one item for every input todo.",
        },
        {
          role: "user",
          content: JSON.stringify({
            timezone: input.timezone || "UTC",
            locale: input.locale || "en-US",
            todos: input.todos,
          }),
        },
      ],
    });

    const parsed = parseJsonObjectFromText(String(result.message?.content || ''));
    const rawDurations = Array.isArray((parsed as any)?.durations) ? (parsed as any).durations : [];
    const allowedIds = new Set(input.todos.map((todo) => todo.id));
    const durations = rawDurations
      .map((item: any) => ({
        id: String(item?.id || '').trim(),
        durationMinutes: normalizeDurationMinutes(item?.durationMinutes),
      }))
      .filter((item: { id: string; durationMinutes: number | null }) => item.id && allowedIds.has(item.id) && item.durationMinutes)
      .map((item: { id: string; durationMinutes: number | null }) => ({
        id: item.id,
        durationMinutes: item.durationMinutes!,
      }));

    res.status(200).json({ durations });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Duration inference failed" });
  }
});

app.post("/ai/chat", async (req, res) => {
  const parse = ChatBodySchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }
  try {
    const { messages, temperature, maxTokens, tools, toolChoice } = parse.data;
    const finalTools = Array.isArray(tools) && tools.length > 0 ? tools : getOpenAIToolDefs();
    const result = await openaiChat({ messages, model: AI_MODELS.main, temperature, maxTokens, tools: finalTools, toolChoice });
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "OpenAI call failed" });
  }
});

app.get("/ai/tools", (_req, res) => {
  res.status(200).json({ tools: getOpenAIToolDefs() });
});

const RouteToolSchema = z.object({ name: z.string(), arguments: z.unknown() });
app.post("/ai/tools/route", (req, res) => {
  const parsed = RouteToolSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  const { name, arguments: args } = parsed.data as any;
  const validation = validateToolCall(name, args);
  if (!validation.ok) return res.status(400).json(validation);
  // For now, most tools execute on client to update local DB
  return res.status(200).json({
    name,
    mode: validation.def.mode,
    validated: validation.data,
  });
});

// Start a routed chat and dispatch tool calls to a specific client over SSE
const ChatRouteSchema = ChatBodySchema.extend({
  clientId: z.string().optional(),
  clientRequestId: z.string().optional(),
  assistantSurface: z.enum(["chat", "todo", "calendar", "home"]).optional(),
  assistantMode: z.enum(["chat", "compact"]).optional(),
  aiPersonalization: AiPersonalizationRequestSchema,
});
app.post("/ai/route", async (req, res) => {
  const parse = ChatRouteSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  const {
    clientId,
    clientRequestId,
    messages,
    temperature,
    maxTokens,
    tools,
    toolChoice,
    assistantSurface,
    assistantMode,
    aiPersonalization,
  } = parse.data as any;
  try {
    const resolvedModel = getRouteModel(assistantMode);
    const isCompactCalendarRoute = assistantMode === "compact" && assistantSurface === "calendar";
    const requestedTools = Array.isArray(tools) && tools.length > 0
      ? tools
      : getToolDefsForSurface(assistantSurface);
    const finalTools = isCompactCalendarRoute
      ? withCompactCalendarCreateContract(requestedTools)
      : requestedTools;
    const toolNames = (() => {
      try {
        return JSON.stringify((finalTools || []).map((t: any) => t?.function?.name)).slice(0, 500);
      } catch { return "(unavailable)"; }
    })();
    console.log(`[route] clientId=${clientId || "(none)"} messages=${Array.isArray(messages) ? messages.length : 0}`);
    console.log(`[route] model=${resolvedModel} assistantMode=${assistantMode || "chat"} assistantSurface=${assistantSurface || "chat"}`);
    console.log(`[route] toolDefs=${toolNames}`);
    const canStreamToClient = !!clientId;
    const routeMessages = messages as ChatMessage[];
    const calendarTimeContext = isCompactCalendarRoute
      ? getCalendarTimeContext(routeMessages)
      : null;
    let routeMeta: RouteMeta | undefined;

    const personalizationMessage = buildAiPersonalizationSystemMessage(aiPersonalization);
    let workingMessages = [
      assistantMode === "compact" ? buildCompactServerSystemMessage(assistantSurface) : buildChatServerSystemMessage(),
      ...(personalizationMessage ? [personalizationMessage] : []),
      ...routeMessages,
    ] as ChatMessage[];
    let retriedCalendarCreateContract = false;
    let reviewedCompactCalendarClarification = false;
    if (canStreamToClient) {
      sseHub.sendTo(clientId, "assistant.start", { clientRequestId });
    }
    for (let round = 0; round < MAX_SERVER_TOOL_ROUNDS; round += 1) {
      const result = canStreamToClient
        ? await openaiChatStream({
            messages: workingMessages,
            model: resolvedModel,
            temperature: 0,
            maxTokens,
            tools: finalTools,
            toolChoice,
            onContentDelta: (delta) => {
              if (!clientId || !delta) return;
              sseHub.sendTo(clientId, "assistant.delta", { clientRequestId, delta });
            },
          })
        : await openaiChat({ messages: workingMessages, model: resolvedModel, temperature: 0, maxTokens, tools: finalTools, toolChoice });

      const toolCalls = result.toolCalls || [];
      try {
        const names = (toolCalls || []).map((c: any) => c?.function?.name).filter(Boolean);
        console.log(`[route] openai returned toolCalls=${toolCalls.length} names=${JSON.stringify(names)} round=${round + 1}`);
      } catch {}

      if (toolCalls.length === 0) {
        const assistantContent = typeof result?.message?.content === "string" ? result.message.content : "";
        console.log(`[route] no_tool_calls contentLength=${assistantContent.length}`);
        if (shouldReviewCompactCalendarClarification({
          assistantMode,
          surface: assistantSurface,
          content: assistantContent,
          alreadyReviewed: reviewedCompactCalendarClarification,
        })) {
          reviewedCompactCalendarClarification = true;
          if (clientId) {
            sseHub.sendTo(clientId, "assistant.reset", { clientRequestId });
          }
          workingMessages = [
            ...workingMessages,
            { role: "assistant", content: assistantContent },
            {
              role: "system",
              content: "Review that clarification against the calendar_create resolution contract. If the current request contains a complete time range or a start plus duration but no date, use date next_occurrence, resolve the next future occurrence from TimeContext, and call calendar_create. If an atomic field is genuinely missing, return the same short CLARIFY response.",
            },
          ];
          continue;
        }
        if (assistantMode === "compact") {
          routeMeta = normalizeCompactRouteMeta({
            ...routeMeta,
            ...parseCompactAssistantMeta(result?.message?.content),
          });
        }
        if (canStreamToClient) {
          sseHub.sendTo(clientId, "assistant.done", {
            clientRequestId,
            content: assistantContent,
            meta: routeMeta,
          });
        }
        return res.status(200).json({ status: "no_tool_calls", result, clientRequestId, meta: routeMeta });
      }

      const { validatedCalls, errors } = validateToolCalls(
        toolCalls,
        assistantSurface,
        isCompactCalendarRoute
      );
      if (errors.length > 0 && validatedCalls.length === 0) {
        const routing = { dispatched: [], errors, normalizedCalls: [] };
        return res.status(200).json({ status: "tool_calls_dispatched", toolCalls: [], routing, clientRequestId, meta: routeMeta });
      }

      const serverCalls = validatedCalls.filter((call) => call.mode === "server");
      const filteredClientCalls = filterClientToolCallsForUserIntent(
        validatedCalls.filter((call) => call.mode === "client"),
        getLatestUserText(routeMessages)
      );
      const proposedCalendarCreate = filteredClientCalls.some(
        (call) => call.name === "calendar_create"
      );
      if (isCompactCalendarRoute && proposedCalendarCreate && !calendarTimeContext) {
        return res.status(400).json({
          error: "Compact calendar creation requires a valid TimeContext with userTimezone and nowLocal.",
        });
      }
      const calendarCreatePolicy = isCompactCalendarRoute
        ? enforceCalendarCreatePolicy(
            filteredClientCalls,
            calendarTimeContext!
          )
        : {
            calls: filteredClientCalls,
            clarification: undefined,
            retryInstruction: undefined,
          };
      const clientCalls = calendarCreatePolicy.calls;
      const calendarRecoveryAction = getCalendarCreateRecoveryAction(
        calendarCreatePolicy,
        retriedCalendarCreateContract
      );

      if (calendarRecoveryAction === "retry") {
        retriedCalendarCreateContract = true;
        if (clientId) {
          sseHub.sendTo(clientId, "assistant.reset", { clientRequestId });
        }
        workingMessages = [
          ...workingMessages,
          {
            role: "system",
            content: `Your previous calendar_create proposal violated its structured contract: ${calendarCreatePolicy.retryInstruction} Return a corrected tool call or a short CLARIFY response.`,
          },
        ];
        continue;
      }

      if (calendarRecoveryAction === "clarify") {
        if (assistantMode === "compact") {
          routeMeta = {
            assistantKind: "clarify",
            assistantText: calendarCreatePolicy.clarification,
          };
        }
        const content = assistantMode === "compact"
          ? `CLARIFY: ${calendarCreatePolicy.clarification}`
          : calendarCreatePolicy.clarification;
        if (canStreamToClient) {
          sseHub.sendTo(clientId, "assistant.done", {
            clientRequestId,
            content,
            meta: routeMeta,
          });
        }
        return res.status(200).json({
          status: "no_tool_calls",
          result: { message: { role: "assistant", content }, toolCalls: [] },
          clientRequestId,
          meta: routeMeta,
        });
      }

      if (serverCalls.length > 0 && clientCalls.length > 0) {
        const routing = {
          dispatched: [],
          errors: [{ error: "Mixed server and client tool calls are not supported in one turn." }],
          normalizedCalls: [],
        };
        return res.status(200).json({ status: "tool_calls_dispatched", toolCalls: [], routing, clientRequestId, meta: routeMeta });
      }

      if (serverCalls.length > 0) {
        if (clientId) {
          sseHub.sendTo(clientId, "assistant.reset", { clientRequestId });
        }

        const toolMessages: ChatMessage[] = [];
        for (const call of serverCalls) {
          const execution = await executeServerToolCall(call);
          toolMessages.push(execution.toolMessage);
          routeMeta = {
            ...routeMeta,
            ...execution.meta,
          };
        }

        workingMessages = [
          ...workingMessages,
          buildAssistantToolCallMessage(result),
          ...toolMessages,
        ];
        continue;
      }

      const targetClientId = clientId || "";
      const clientToolCalls = clientCalls.map((call) => call.raw);
      const routing = functionRouter.routeToolCalls({ clientId: targetClientId, toolCalls: clientToolCalls, clientRequestId });
      const sentCount = routing.dispatched.filter((d) => d.sent).length;
      console.log(`[route] dispatched=${routing.dispatched.length} sent=${sentCount} errors=${routing.errors.length} clientId=${targetClientId || "(none)"}`);
      try {
        const routedNames = routing.normalizedCalls.map((call) => call.name);
        console.log(`[route] normalizedCalls=${routing.normalizedCalls.length} names=${JSON.stringify(routedNames).slice(0, 500)}`);
      } catch {}
      return res.status(200).json({ status: "tool_calls_dispatched", toolCalls: routing.normalizedCalls, routing, clientRequestId, meta: routeMeta });
    }

    throw new Error("Too many server tool rounds");
  } catch (err: any) {
    console.error(`[route] error:`, err?.message || err);
    if (err?.stack) console.error(err.stack);
    if (clientId) {
      sseHub.sendTo(clientId, "assistant.error", {
        clientRequestId,
        error: err?.message || "Routing failed",
      });
    }
    return res.status(500).json({ error: err?.message || "Routing failed" });
  }
});

// Client posts tool execution result back (ack)
const ToolResultSchema = z.object({
  clientId: z.string(),
  callId: z.string(),
  name: z.string(),
  clientRequestId: z.string().optional(),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
app.post("/ai/tools/result", (req, res) => {
  const parsed = ToolResultSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  const { clientId, callId, name, clientRequestId, success, result, error } = parsed.data;
  try {
    console.log(`[result] clientId=${clientId} callId=${callId} name=${name} success=${success} resultPresent=${result !== undefined} errorPresent=${!!error}`);
  } catch {}
  // echo back to the same client for now; in future, we can continue the chat here using the tool result
  sseHub.sendTo(clientId, "tool.result", { callId, name, clientRequestId, success, result, error });
  return res.status(200).json({ ok: true });
});

app.post("/ai/goal-guidance", async (req, res) => {
  const parse = GoalGuidanceRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const input = parse.data;

    const guidanceMessages: ChatMessage[] = [
      {
        role: "system",
        content: "You are a goal guidance planner. Return only strict JSON. Do not call tools.",
      },
    ];
    guidanceMessages.push({
      role: "user",
      content: buildGoalGuidancePrompt(input),
    });

    const requestGuidanceData = async (messages: ChatMessage[]): Promise<{
      data?: z.infer<typeof GoalGuidanceResponseSchema>;
      error?: unknown;
    }> => {
      const result = await openaiChat({
        model: AI_MODELS.goalGuidance,
        reasoningEffort: "low",
        temperature: 0,
        maxTokens: 8000,
        toolChoice: "auto",
        messages,
      });
      const raw = normalizeGoalGuidanceResponse(parseModelJson(result.message.content), input);
      const normalized = GoalGuidanceResponseSchema.safeParse(raw);
      if (!normalized.success) {
        return { error: normalized.error.flatten() };
      }
      return { data: normalized.data };
    };

    let guidanceResult = await requestGuidanceData(guidanceMessages);
    if (input.mode === "chat_create" && guidanceResult.data?.type !== "plan") {
      guidanceResult = await requestGuidanceData([
        ...guidanceMessages,
        {
          role: "system",
          content:
            "Correction for chat-created goal mode: return type plan now. Do not return clarify. Use the provided title, timeframe, source steps, and reasonable defaults. Reshape tiny or oversized source steps to fit the deadline.",
        },
      ]);
    }
    if (input.mode === "chat_create" && guidanceResult.data?.type !== "plan") {
      const clampFallbackText = (value: string, maxLength: number) => value.slice(0, maxLength);
      const sourceSteps = input.sourceSteps
        .map((step) => ({
          title: clampFallbackText(step.title, 160),
          details: clampFallbackText(
            step.details || `Complete this action in a way that visibly moves ${input.goalTitle} forward.`,
            500
          ),
          cadence: "once" as const,
          effort: "medium" as const,
        }))
        .slice(0, 5);
      guidanceResult = {
        data: {
          type: "plan",
          goalTitle: input.goalTitle,
          feasibility: "tight",
          feasibilityNote: "This plan uses the chat request and reasonable defaults because no extra setup details were provided.",
          steps: sourceSteps.length > 0
            ? sourceSteps
            : [
                {
                  title: clampFallbackText(`Complete one focused work block for ${input.goalTitle}`, 160),
                  details: "Start with the most direct action available and produce one visible piece of progress.",
                  cadence: "once",
                  effort: "medium",
                },
                {
                  title: "Practice the core action once",
                  details: "Repeat the central skill or task slowly enough to notice mistakes, then write down one issue from the session.",
                  cadence: "daily",
                  effort: "medium",
                },
                {
                  title: "Review progress and finish the next concrete piece",
                  details: "Check what improved, then complete the next smallest useful action or prepare it clearly for the next session.",
                  cadence: "once",
                  effort: "medium",
                },
              ],
        },
      };
    }
    if (input.mode === "cram" && guidanceResult.data?.type !== "plan") {
      guidanceResult = await requestGuidanceData([
        ...guidanceMessages,
        {
          role: "system",
          content:
            "Correction for Try anyway mode: return type plan now. Do not return clarify or not_feasible. Do not ask questions. Use available context, previous clarification answers, and reasonable defaults. Mark feasibility tight or unrealistic when needed, but include 3-5 concrete useful steps that fit the deadline.",
        },
      ]);
    }
    if (input.mode === "cram" && guidanceResult.data?.type !== "plan") {
      guidanceResult = {
        data: {
          type: "plan",
          goalTitle: input.goalTitle,
          feasibility: "unrealistic",
          feasibilityNote: "This is a compressed try-anyway plan for the current deadline.",
          steps: [
            {
              title: `Define the smallest usable version of ${input.goalTitle}`,
              details: "Cut anything that is not required for a visible result before the deadline.",
              cadence: "once",
              effort: "medium",
            },
            {
              title: "Complete the highest-impact work block",
              details: "Spend one focused session on the action most likely to move the goal forward today.",
              cadence: "once",
              effort: "heavy",
            },
            {
              title: "Finish and review the usable result",
              details: "Package what is done, check it once, and decide the next improvement only after this version exists.",
              cadence: "once",
              effort: "medium",
            },
          ],
        },
      };
    }

    if (!guidanceResult.data) {
      return res.status(502).json({
        error: "Invalid goal guidance response",
        details: guidanceResult.error,
      });
    }

    const data = guidanceResult.data;
    if (data.type === "not_feasible") {
      data.steps = [];
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Goal guidance failed" });
  }
});

app.post("/ai/task-guidance", async (req, res) => {
  const parse = TaskGuidanceRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const input = parse.data;
    const result = await openaiChat({
      model: AI_MODELS.goalGuidance,
      reasoningEffort: "low",
      temperature: 0,
      maxTokens: 6000,
      messages: [
        {
          role: "system",
          content: "You create practical subtasks for a normal personal task. Return only strict JSON. Do not call tools.",
        },
        {
          role: "user",
          content: buildTaskGuidancePrompt(input),
        },
      ],
    });
    const raw = normalizeTaskGuidanceResponse(parseModelJson(result.message.content));
    const validated = TaskGuidanceResponseSchema.safeParse(raw);
    if (!validated.success) {
      return res.status(502).json({ error: "Invalid task guidance response", details: validated.error.flatten() });
    }

    return res.status(200).json(validated.data);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Task guidance failed" });
  }
});

app.post("/ai/guidance/answer", async (req, res) => {
  const parse = SavedGuidanceAnswerRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const input = parse.data;
    const personalizationMessage = buildAiPersonalizationSystemMessage(input.aiPersonalization);
    const result = await openaiChat({
      model: AI_MODELS.goalGuidance,
      reasoningEffort: "low",
      temperature: 0,
      maxTokens: 4000,
      messages: [
        {
          role: "system",
          content: "You answer questions about already-saved local app guidance. Return only strict JSON. Do not call tools.",
        },
        ...(personalizationMessage ? [personalizationMessage] : []),
        {
          role: "user",
          content: formatSavedGuidanceAnswerPrompt(input),
        },
      ],
    });
    const raw = parseModelJson(result.message.content);
    const validated = SavedGuidanceAnswerResponseSchema.safeParse(raw);
    if (!validated.success) {
      return res.status(502).json({ error: "Invalid guidance answer response", details: validated.error.flatten() });
    }

    const suggestedStepIndex =
      Number.isInteger(validated.data.suggestedStepIndex) &&
      validated.data.suggestedStepIndex! >= 0 &&
      validated.data.suggestedStepIndex! < input.steps.length
        ? validated.data.suggestedStepIndex
        : undefined;
    return res.status(200).json({
      answer: validated.data.answer,
      ...(suggestedStepIndex !== undefined ? { suggestedStepIndex } : {}),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Guidance answer failed" });
  }
});

app.post("/ai/todo/classify", async (req, res) => {
  const parse = TodoClassifyRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const input = parse.data;
    const result = await openaiChat({
      model: AI_MODELS.lightweight,
      temperature: 0,
      maxTokens: 500,
      messages: [
        {
          role: "system",
          content:
            "Classify a todo into one of three kinds and return only strict JSON. " +
            "recipe means the task is about preparing a food or drink outcome. " +
            "skill means the task is about learning, practicing, training, studying, or improving an ability over time. " +
            "normal means everything else, including chores, errands, admin, one-off tasks, reminders, and generic action items. " +
            "Use only the title, details, workspace, and goalTimeframe provided. Do not rely on canned examples or hidden assumptions. " +
            "Prefer recipe over skill when the primary intent is making food now. Prefer skill over normal when the primary intent is building capability rather than completing a one-off outcome. " +
            "For workspace Goals, also classify goalBehavior as standard or quota. Use quota only for explicit repeatable counts in weekly, monthly, or yearly goals, such as fast 3 days this month or work out 40 times this year. The goal timeframe may come from goalTimeframe rather than the title. " +
            "Do not use quota for vague habits, streaks or consecutive goals, fixed schedules like every Monday, numeric outcome goals like lose 10kg, or goals without an explicit count. " +
            "Do not use quota when goalTimeframe is longTerm. " +
            "For quota metadata, use unitType distinct_days when the count means unique days, and count when multiple repetitions could reasonably be completed on the same day.",
        },
        {
          role: "user",
          content:
            "Return JSON with shape {\"kind\":\"normal|recipe|skill\",\"confidence\":0.0,\"goalBehavior\":\"standard|quota\",\"quota\":{\"targetCount\":3,\"unitLabel\":\"days\",\"unitType\":\"distinct_days|count\"}}. " +
            "Omit quota unless goalBehavior is quota. For non-Goals workspaces, always return goalBehavior standard.\n\n" +
            JSON.stringify({
              title: input.title,
              details: input.details,
              workspace: input.workspace,
              goalTimeframe: input.goalTimeframe,
              userTimezone: input.userTimezone,
              locale: input.locale,
            }),
        },
      ],
    });

    const raw = normalizeTodoClassificationResponse(parseModelJson(result.message.content), input.workspace, input.goalTimeframe);
    const validated = TodoClassifyResponseSchema.safeParse(raw);
    if (!validated.success) {
      return res.status(502).json({ error: "Invalid todo classification response", details: validated.error.flatten() });
    }

    return res.status(200).json(validated.data);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Todo classification failed" });
  }
});

app.post("/ai/goal-quota/resolve-date", async (req, res) => {
  const parse = GoalQuotaDateResolveRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const input = parse.data;
    const todayKey = getLocalDateKey(new Date(), input.userTimezone);
    const result = await openaiChat({
      model: AI_MODELS.lightweight,
      temperature: 0,
      maxTokens: 320,
      messages: [
        {
          role: "system",
          content:
            "Classify the user's reply to a quota goal scheduling prompt and return only strict JSON. " +
            "The app asked when to do the first quota action. Only treat the reply as scheduling when it is a direct answer to that prompt. " +
            "Return {\"intent\":\"schedule_date\",\"dateIso\":\"YYYY-MM-DD\",\"label\":\"May 12\"} for a clear date. " +
            "Return {\"intent\":\"open_picker\"} when the user wants to pick or choose a date in the UI. " +
            "Return {\"intent\":\"decide_later\"} when the user wants to skip, decide later, or not schedule now. " +
            "Return {\"intent\":\"needs_clarification\",\"message\":\"...\"} for direct scheduling intent with an unclear, invalid, or past date. " +
            "Return {\"intent\":\"none\"} for unrelated requests, even if they mention a date, such as showing a calendar tomorrow. " +
            "Use no time of day. Interpret relative phrases from the provided current local date and timezone.",
        },
        {
          role: "user",
          content: JSON.stringify({
            replyText: input.text,
            goalTitle: input.goalTitle,
            today: todayKey,
            userTimezone: input.userTimezone,
            locale: input.locale,
          }),
        },
      ],
    });

    const normalized = normalizeGoalQuotaDateResolution(parseModelJson(result.message.content), todayKey);
    const validated = GoalQuotaDateResolveResponseSchema.safeParse(normalized);
    if (!validated.success) {
      return res.status(502).json({ error: "Invalid date resolution response", details: validated.error.flatten() });
    }

    return res.status(200).json(validated.data);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Goal quota date resolution failed" });
  }
});

app.post("/ai/wishlist/purchase-intent", async (req, res) => {
  const parse = WishlistPurchaseIntentRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const result = await openaiChat({
      model: AI_MODELS.lightweight,
      temperature: 0,
      maxTokens: 300,
      messages: buildWishlistPurchaseIntentMessages(parse.data),
    });

    const response = normalizeWishlistPurchaseIntentResponse(parseModelJson(result.message.content));
    return res.status(200).json(response);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Wishlist purchase intent detection failed" });
  }
});

app.post("/ai/goal-wishlist-suggestions", async (req, res) => {
  const parse = GoalWishlistSuggestionsRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const result = await openaiChat({
      model: AI_MODELS.lightweight,
      temperature: 0,
      maxTokens: 500,
      messages: buildGoalWishlistSuggestionsMessages(parse.data),
    });

    const response = normalizeGoalWishlistSuggestionsResponse(parseModelJson(result.message.content));
    return res.status(200).json(response);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Goal wishlist suggestions failed" });
  }
});

app.post("/ai/home-suggestions", async (req, res) => {
  const parse = HomeSuggestionsRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const result = await openaiChat({
      model: AI_MODELS.lightweight,
      temperature: 0,
      maxTokens: 600,
      messages: buildHomeSuggestionsMessages(parse.data),
    });

    let response;
    try {
      response = normalizeHomeSuggestionsResponse(
        parseModelJson(result.message.content),
        parse.data.candidates
      );
    } catch {
      response = buildFallbackHomeSuggestions(parse.data.candidates);
    }
    if (response.suggestions.length === 0) {
      response = buildFallbackHomeSuggestions(parse.data.candidates);
    }
    return res.status(200).json(response);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Home suggestions failed" });
  }
});

app.post("/ai/recipe/videos", async (req, res) => {
  const parse = RecipeVideosRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const result = await searchRegularYoutubeRecipeVideos(parse.data);
    return res.status(200).json(result);
  } catch (err: any) {
    console.error(`[recipe/videos] error:`, err?.message || err);
    return res.status(500).json({ error: err?.message || "Recipe video search failed" });
  }
});

app.post("/ai/recipe/generate", async (req, res) => {
  const parse = RecipeGenerateRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const input = parse.data;
    const transcript = await fetchYoutubeTranscript(input.selectedVideo.videoId);
    const guide = await generateRecipeGuideFromTranscript(input, transcript.segments);

    return res.status(200).json({
      ...guide,
      transcriptLanguage: transcript.language || "",
    });
  } catch (err: any) {
    const message = err?.message || "Recipe generation failed";
    console.error(`[recipe/generate] error:`, message);
    const status =
      /transcript|caption/i.test(message) ? 424 :
      err instanceof InvalidGuideResponseError ? 502 :
      500;
    return res.status(status).json({ error: message });
  }
});

app.post("/ai/recipe/answer", async (req, res) => {
  const parse = RecipeAnswerRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const input = parse.data;
    const personalizationMessage = buildAiPersonalizationSystemMessage(input.aiPersonalization);
    const result = await openaiChat({
      model: "gpt-5.4-mini",
      temperature: 0,
      maxTokens: 1200,
      messages: [
        {
          role: "system",
          content: "You answer cooking questions about an already-generated recipe guide. Return only strict JSON.",
        },
        ...(personalizationMessage ? [personalizationMessage] : []),
        {
          role: "user",
          content: formatRecipeAnswerPrompt(input),
        },
      ],
    });
    const raw = parseModelJson(result.message.content);
    const validated = RecipeAnswerResponseSchema.safeParse(raw);
    if (!validated.success) {
      return res.status(502).json({ error: "Invalid recipe answer response", details: validated.error.flatten() });
    }

    const suggestedStepIndex =
      Number.isInteger(validated.data.suggestedStepIndex) &&
      validated.data.suggestedStepIndex! >= 0 &&
      validated.data.suggestedStepIndex! < input.steps.length
        ? validated.data.suggestedStepIndex
        : undefined;
    const recipeTitle = validated.data.recipeTitle?.trim();
    const action = validated.data.action === "recipe_change" && recipeTitle
      ? "recipe_change"
      : "answer";
    return res.status(200).json({
      answer: validated.data.answer,
      action,
      ...(action === "recipe_change" ? { recipeTitle } : {}),
      ...(suggestedStepIndex !== undefined ? { suggestedStepIndex } : {}),
    });
  } catch (err: any) {
    console.error(`[recipe/answer] error:`, err?.message || err);
    return res.status(500).json({ error: err?.message || "Recipe answer failed" });
  }
});

app.post("/ai/skill/videos", async (req, res) => {
  const parse = SkillVideosRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const result = await searchRegularYoutubeSkillVideos(parse.data);
    return res.status(200).json(result);
  } catch (err: any) {
    console.error(`[skill/videos] error:`, err?.message || err);
    return res.status(500).json({ error: err?.message || "Skill video search failed" });
  }
});

app.post("/ai/skill/generate", async (req, res) => {
  const parse = SkillGenerateRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const input = parse.data;
    const transcript = await fetchYoutubeTranscript(input.selectedVideo.videoId);
    const guide = await generateSkillGuideFromTranscript(input, transcript.segments);

    return res.status(200).json({
      ...guide,
      transcriptLanguage: transcript.language || "",
    });
  } catch (err: any) {
    const message = err?.message || "Skill guide generation failed";
    console.error(`[skill/generate] error:`, message);
    const status =
      /transcript|caption/i.test(message) ? 424 :
      err instanceof InvalidGuideResponseError ? 502 :
      500;
    return res.status(status).json({ error: message });
  }
});

app.post("/ai/skill/answer", async (req, res) => {
  const parse = SkillAnswerRequestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
  }

  try {
    const input = parse.data;
    const personalizationMessage = buildAiPersonalizationSystemMessage(input.aiPersonalization);
    const result = await openaiChat({
      model: "gpt-5.4-mini",
      temperature: 0,
      maxTokens: 1200,
      messages: [
        {
          role: "system",
          content: "You answer questions about an already-generated skill-learning guide. Return only strict JSON.",
        },
        ...(personalizationMessage ? [personalizationMessage] : []),
        {
          role: "user",
          content: formatSkillAnswerPrompt(input),
        },
      ],
    });
    const raw = parseModelJson(result.message.content);
    const validated = SkillAnswerResponseSchema.safeParse(raw);
    if (!validated.success) {
      return res.status(502).json({ error: "Invalid skill answer response", details: validated.error.flatten() });
    }

    const suggestedStepIndex =
      Number.isInteger(validated.data.suggestedStepIndex) &&
      validated.data.suggestedStepIndex! >= 0 &&
      validated.data.suggestedStepIndex! < input.steps.length
        ? validated.data.suggestedStepIndex
        : undefined;
    return res.status(200).json({
      answer: validated.data.answer,
      ...(suggestedStepIndex !== undefined ? { suggestedStepIndex } : {}),
    });
  } catch (err: any) {
    console.error(`[skill/answer] error:`, err?.message || err);
    return res.status(500).json({ error: err?.message || "Skill answer failed" });
  }
});

const GlobalContextSchema = z.object({
  currentTab: z.enum(["todo", "calendar"]).optional(),
  user: z.object({ name: z.string().optional() }).optional(),
  // note: z.object({ html: z.string().optional() }).optional(),
  todos: z
    .object({
      items: z
        .array(
          z.object({
            text: z.string(),
            dueDate: z.string().optional(),
            workspace: z.string().optional(),
            details: z.string().optional(),
            starred: z.boolean().optional(),
          })
        )
        .optional(),
    })
    .optional(),
  calendar: z.record(z.any()).optional(),
});

app.post("/ai/context/build", (req, res) => {
  const parse = GlobalContextSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "Invalid context", details: parse.error.flatten() });
  const ctxText = buildContext(parse.data);
  res.status(200).json({ text: ctxText });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // @ts-ignore - flushHeaders exists on Node's ServerResponse
  res.flushHeaders?.();

  const clientId = sseHub.addClient(res);

  req.on("close", () => {
    sseHub.removeClient(clientId);
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not Found" });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err?.message || "Internal Server Error";
  try {
    console.error(`[middleware] error:`, message);
    if (err?.stack) console.error(err.stack);
  } catch {}
  res.status(500).json({ error: message });
});

export function closeAppResources() {
  sseHub.close();
}

export function startAppServer() {
  return app.listen(config.port, "0.0.0.0", () => {
    console.log(`Eazee server listening on ${config.port}`);
  });
}

if (require.main === module) {
  startAppServer();
}
