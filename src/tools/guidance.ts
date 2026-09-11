import { z } from "zod";
import type { ToolDef } from "./todo";

export const GoalTimeframeSchema = z.enum(["thisWeek", "thisMonth", "thisYear", "longTerm"]);

export const GoalCreateSchema = z.object({
  title: z.string().min(1).max(200),
  details: z.string().max(4000).optional(),
  timeframe: GoalTimeframeSchema,
});

const GoalGuidancePathSchema = z.enum(["actions", "video"]);

const GoalCreateGuidanceStepSchema = z.object({
  title: z.string().min(1).max(200),
  details: z.string().max(1000).optional(),
});

export const GoalCreateWithGuidanceSchema = z.object({
  title: z.string().min(1).max(200),
  details: z.string().max(4000).optional(),
  timeframe: GoalTimeframeSchema,
  guidancePath: GoalGuidancePathSchema,
  sourceSteps: z.array(GoalCreateGuidanceStepSchema).max(24).optional(),
  sourceQuestion: z.string().max(8000).optional(),
  sourceAnswer: z.string().max(8000).optional(),
});

export const GoalCreateParameters = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    details: { type: "string", maxLength: 4000 },
    timeframe: {
      type: "string",
      enum: ["thisWeek", "thisMonth", "thisYear", "longTerm"],
      description: "Required todo-tab goal timeframe. Ask the user when missing.",
    },
  },
  required: ["title", "timeframe"],
  additionalProperties: false,
};

export const GoalCreateWithGuidanceParameters = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    details: { type: "string", maxLength: 4000 },
    timeframe: {
      type: "string",
      enum: ["thisWeek", "thisMonth", "thisYear", "longTerm"],
      description: "Required todo-tab goal timeframe.",
    },
    guidancePath: {
      type: "string",
      enum: ["actions", "video"],
      description: "Use actions for an actions plan with Personal todos, or video for video lessons. Quota goals do not support video guidance.",
    },
    sourceSteps: {
      type: "array",
      description: "Ordered steps from prior chat content to reshape into a goal actions plan.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          details: { type: "string", maxLength: 1000 },
        },
        required: ["title"],
        additionalProperties: false,
      },
      maxItems: 24,
    },
    sourceQuestion: { type: "string", maxLength: 8000 },
    sourceAnswer: { type: "string", maxLength: 8000 },
  },
  required: ["title", "timeframe", "guidancePath"],
  additionalProperties: false,
};

export const GoalQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  textContains: z.string().max(200).optional(),
  timeframe: GoalTimeframeSchema.optional(),
  status: z.enum(["active", "completed", "all"]).optional(),
});

export const GoalQueryParameters = {
  type: "object",
  properties: {
    limit: { type: "number", minimum: 1, maximum: 100 },
    textContains: { type: "string", maxLength: 200 },
    timeframe: { type: "string", enum: ["thisWeek", "thisMonth", "thisYear", "longTerm"] },
    status: {
      type: "string",
      enum: ["active", "completed", "all"],
      description: "Defaults to active incomplete todo-tab goals.",
    },
  },
  additionalProperties: false,
};

const GuidanceLookupBaseSchema = z.object({
  todoId: z.string().min(1).max(200).optional(),
  textContains: z.string().min(1).max(200).optional(),
});

export const GuidanceCurrentStepSchema = GuidanceLookupBaseSchema.extend({
  includeCompleted: z.boolean().optional(),
  scope: z.enum(["current", "next", "all"]).optional(),
}).refine((value) => !!(value.todoId || value.textContains), {
  message: "todoId or textContains is required",
});

export const GuidanceCurrentStepParameters = {
  type: "object",
  properties: {
    todoId: { type: "string", description: "Todo id from a prior goal/task result when available." },
    textContains: { type: "string", minLength: 1, maxLength: 200 },
    includeCompleted: { type: "boolean" },
    scope: {
      type: "string",
      enum: ["current", "next", "all"],
      description: "Defaults to current. Use next for upcoming remaining steps or all for full saved plan.",
    },
  },
  additionalProperties: false,
};

export const GuidanceAnswerSchema = GuidanceLookupBaseSchema.extend({
  question: z.string().min(1).max(1200),
}).refine((value) => !!(value.todoId || value.textContains), {
  message: "todoId or textContains is required",
});

export const GuidanceAnswerParameters = {
  type: "object",
  properties: {
    todoId: { type: "string", description: "Todo id from a prior goal/task result when available." },
    textContains: { type: "string", minLength: 1, maxLength: 200 },
    question: { type: "string", minLength: 1, maxLength: 1200 },
  },
  required: ["question"],
  additionalProperties: false,
};

export const guidanceTools: ToolDef[] = [
  {
    name: "goal_create",
    description:
      "Create one todo-tab goal in the Goals workspace only after the user provided a timeframe. If timeframe is missing, ask a short question instead of calling this tool. This does not create a guidance plan.",
    mode: "client",
    schema: GoalCreateSchema,
    parameters: GoalCreateParameters,
  },
  {
    name: "goal_create_with_guidance",
    description:
      "Create one todo-tab goal and immediately set up guidance. Use actions when the user wants an actions plan, daily/personal todos, or wants prior steps converted into a goal plan. Use video when the user explicitly wants video lessons or to follow a video. Quota goals do not support video guidance. Requires a timeframe.",
    mode: "client",
    schema: GoalCreateWithGuidanceSchema,
    parameters: GoalCreateWithGuidanceParameters,
  },
  {
    name: "goal_query",
    description:
      "Query todo-tab goals only. This reads local todos where workspace is Goals. Use this for active/current goals. Do not use long-term memory or normal todo_query for todo-tab goals.",
    mode: "client",
    schema: GoalQuerySchema,
    parameters: GoalQueryParameters,
  },
  {
    name: "guidance_current_step",
    description:
      "Read current, next, remaining, all saved steps, progress, or status for a goal, goal action, normal task guide, recipe guide, or skill guide. Set scope to current, next, or all. This is read-only and never creates or changes plans or guide steps.",
    mode: "client",
    schema: GuidanceCurrentStepSchema,
    parameters: GuidanceCurrentStepParameters,
  },
  {
    name: "guidance_answer",
    description:
      "Answer a question about an existing saved guidance step, guide, or guidance history. Also use for related resource/link requests or practical advice when the user is not asking to change the plan. If no saved accepted/ready guide exists, tell the user to open the Todo tab. Never create, edit, or regenerate guidance from chat.",
    mode: "client",
    schema: GuidanceAnswerSchema,
    parameters: GuidanceAnswerParameters,
  },
];
