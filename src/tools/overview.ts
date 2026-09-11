import { z } from "zod";
import type { ToolDef } from "./todo";

export const DailyOverviewSchema = z.object({
  date: z.string().optional(),
});

export const PlanMyDaySchema = z.object({
  date: z.string().optional(),
  items: z.array(
    z.object({
      text: z.string(),
      type: z.enum(["task", "event", "buffer"]).optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      dueDate: z.string().optional(),
      hasDueTime: z.boolean().optional(),
      order: z.number().optional(),
      durationMinutes: z.number().min(15).max(480).optional(),
      timeSource: z.enum(["user", "ai", "none"]).optional(),
      daypart: z.enum(["morning", "afternoon", "evening", "night"]).optional(),
      location: z.string().optional(),
      details: z.string().optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
    })
  ).min(1),
});

export const SaveDayPlanSchema = z.object({});

export const DailyOverviewParameters = {
  type: "object",
  properties: {
    date: {
      type: "string",
      description: "The date to get overview for in YYYY-MM-DD format. Defaults to today if not specified.",
    },
  },
  additionalProperties: false,
};

export const SaveDayPlanParameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const PlanMyDayParameters = {
  type: "object",
  properties: {
    date: {
      type: "string",
      description: "The day being planned in YYYY-MM-DD format. Defaults to today if not specified.",
    },
    items: {
      type: "array",
      description: "The things the user wants to fit into the day.",
      items: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Short description of the task or event.",
          },
          type: {
            type: "string",
            enum: ["task", "event", "buffer"],
            description: "Use task for anything that should become a todo, including timed todos. Use event only for true calendar items that should live on the calendar. Use buffer for scheduling-only time costs such as travel, transition, setup, cleanup, recovery, or breaks that should affect timing but should not become a todo or calendar event. Do not switch a task to event just because it has a time.",
          },
          start: {
            type: "string",
            description: "Start datetime in full ISO 8601 format when the item has a fixed time. For task items, this can be used to preserve the todo's due time without making it a calendar event.",
          },
          end: {
            type: "string",
            description: "End datetime in full ISO 8601 format for calendar events when relevant.",
          },
          dueDate: {
            type: "string",
            description: "Due date for task items. Use YYYY-MM-DD for day-level todos, or a full ISO 8601 datetime with timezone offset for timed todos.",
          },
          hasDueTime: {
            type: "boolean",
            description: "For task items only. Set true when the todo has an explicit due time. Timed todos are still tasks, not calendar events.",
          },
          order: {
            type: "number",
            description: "The intended order of this item in the draft timeline. Use lower numbers earlier in the day.",
          },
          durationMinutes: {
            type: "number",
            description: "Estimated duration in minutes. Use 15-480. If the user gave a duration, preserve it; otherwise choose a practical estimate.",
          },
          timeSource: {
            type: "string",
            enum: ["user", "ai", "none"],
            description: "Use user when the user supplied this time, ai when you inferred the time while planning, and none when the item currently has no time.",
          },
          daypart: {
            type: "string",
            enum: ["morning", "afternoon", "evening", "night"],
            description: "Set this when the user gave a vague relative time/daypart for the item, even if you clean that phrase from the title. Morning means after 9 AM, afternoon after 12 PM, evening after 5 PM, night/tonight after 7 PM.",
          },
          location: {
            type: "string",
            description: "Location for event-like items when relevant.",
          },
          details: {
            type: "string",
            description: "Only notes/context the user explicitly mentioned. Do not invent descriptions or details.",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Relative priority for flexible tasks.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

export const overviewTools: ToolDef[] = [
  {
    name: "plan_my_day",
    description:
      "Create a draft day plan from the user's tasks and events. Use this for requests like plan my day, organize my day, map out my day, or help me fit things in. If the user gives at least one task or event, call this tool instead of asking for fixed-time events, blockers, or times for untimed items; infer missing times and durations yourself because the client checks existing calendar events and timed todos as blockers. Treat scheduling-only time costs such as travel, transition, setup, cleanup, recovery, or breaks as type buffer, not task or event, unless the user explicitly wants them saved. Buffers affect placement but are hidden and not saved as todos/calendar events. Plan inside a normal 9 AM to 9 PM day unless the user gives another window. Preserve the user's intended item type: a task stays a todo even when it has an explicit time, while only true events should be calendar items. Choose the item order based on the task/event itself, fixed times, likely energy/context, dependencies, urgency, and practical flow; do not simply preserve the order the user typed unless they explicitly ask for that order. If an item has no user-provided time, choose a useful order, durationMinutes, and an inferred start/dueDate when possible, with timeSource ai. Include natural breathing room or breaks when useful; do not pack every item back-to-back unless it genuinely makes sense. If the user gave the time, set timeSource user and do not change that time unless the user explicitly asks to change it. Respect vague user dayparts: morning means after 9 AM, afternoon after 12 PM, evening after 5 PM, and night/tonight after 7 PM. If the user gives a vague daypart for an item, set daypart so the client can enforce that window even when the title is cleaned. Never schedule a night/tonight item in the afternoon. Do not invent item descriptions/details. When updating an existing draft, carry forward unchanged items and preserve user-edited times.",
    mode: "client",
    schema: PlanMyDaySchema,
    parameters: PlanMyDayParameters,
  },
  {
    name: "save_day_plan",
    description:
      "Save the current draft day plan from LastDayPlan after the user confirms it. Use this when a draft plan already exists and the user says things like looks good, confirm, save it, add it, or put it in my calendar and todos. This creates the plan's calendar items and todo items together and should be preferred over calling calendar_create and todo_create_many separately for a confirmed day plan draft.",
    mode: "client",
    schema: SaveDayPlanSchema,
    parameters: SaveDayPlanParameters,
  },
  {
    name: "daily_overview",
    description:
    "Get a daily overview showing todos and calendar events for one day. Prefer this only when the user asks for a broad overview of their day, not when they ask for a specific todo or calendar query.",
    mode: "client",
    schema: DailyOverviewSchema,
    parameters: DailyOverviewParameters,
  },
];
