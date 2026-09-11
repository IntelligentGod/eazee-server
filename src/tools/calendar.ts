import { z } from "zod";
import type { ToolDef } from "./todo";

// Schemas
export const CalendarFetchRangeSchema = z.object({
  from: z.string().optional(), // ISO 8601
  to: z.string().optional(),   // ISO 8601
  openIntent: z.boolean().optional(),
});

export const CalendarGetDetailsSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["google", "local"]).optional(),
});

export const CalendarCreateResolutionSchema = z.object({
  date: z.enum(["exact", "next_occurrence", "range", "missing"]),
  start: z.enum(["user", "relative", "missing"]),
  end: z.enum(["user", "duration", "missing"]),
  durationMinutes: z.number().int().min(1).max(10_080).optional(),
});

export const CalendarCreateSchema = z.object({
  title: z.string().min(1),
  start: z.string().min(4), // ISO 8601 with tz
  end: z.string().min(4),   // ISO 8601 with tz
  details: z.string().max(4000).optional(),
  location: z.string().optional(),
  attendees: z.array(z.string().min(3)).optional(),
});

export const CalendarUpdateSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["google", "local"]).optional(),
  start: z.string().min(4).optional(),
  end: z.string().min(4).optional(),
  title: z.string().min(1).optional(),
  details: z.string().max(4000).optional(),
  location: z.string().optional(),
  attendees: z.array(z.string().min(3)).optional(),
}).refine(
  (it) =>
    typeof it.start !== "undefined" ||
    typeof it.end !== "undefined" ||
    typeof it.title !== "undefined" ||
    typeof it.details !== "undefined" ||
    typeof it.location !== "undefined" ||
    typeof it.attendees !== "undefined",
  { message: "At least one field to update must be provided" }
);

export const CalendarDeleteSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["google", "local"]).optional(),
});

export const CalendarSearchSchema = z.object({
  query: z.string().min(1),
  from: z.string().optional(), // ISO 8601
  to: z.string().optional(),   // ISO 8601
  limit: z.number().int().min(1).max(100).optional(),
  source: z.enum(["google", "local"]).optional(),
  openIntent: z.boolean().optional(),
});

// JSON Schemas
export const CalendarFetchRangeParameters = {
  type: "object",
  properties: {
    from: { type: "string", description: "Inclusive range start as an ISO 8601 datetime." },
    to: { type: "string", description: "Inclusive range end as an ISO 8601 datetime." },
    openIntent: { type: "boolean", description: "Set true when the user wants to open or show one specific event in this range." },
  },
  additionalProperties: false,
};

export const CalendarGetDetailsParameters = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, description: "Event id from prior results." },
    source: { type: "string", enum: ["google", "local"] },
  },
  required: ["id"],
  additionalProperties: false,
};

export const CalendarCreateParameters = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, description: "Concise event title inferred from the request. Never ask only for a title; use a generic event noun or Event when needed. Exclude create commands and scheduling expressions, but preserve date or time words that clearly belong to a named event." },
    start: { type: "string", minLength: 4, description: "Event start as a full ISO 8601 datetime with timezone offset, based on a start time supplied or explicitly implied by the user. Never invent midnight or another default." },
    end: { type: "string", minLength: 4, description: "Event end as a full ISO 8601 datetime with timezone offset, based on an end time supplied or explicitly implied by the user. Never invent a default duration." },
    details: { type: "string", maxLength: 4000, description: "Event notes, agenda, links, or context. Maps to Google Calendar description." },
    location: { type: "string" },
    attendees: { type: "array", items: { type: "string", minLength: 3 }, description: "Guest email addresses." },
  },
  required: ["title", "start", "end"],
  additionalProperties: false,
};

export const CompactCalendarCreateParameters = {
  type: "object",
  properties: {
    title: CalendarCreateParameters.properties.title,
    start: { type: "string", minLength: 4, description: "Event start as a full ISO 8601 datetime with timezone offset. Omit when resolution.start is missing." },
    end: { type: "string", minLength: 4, description: "Event end as a full ISO 8601 datetime with timezone offset. Required when resolution.end is user; omit when it is duration or missing." },
    resolution: {
      type: "object",
      description: "Your structured semantic decision about the current request. The server enforces this object and does not infer it from wording.",
      properties: {
        date: {
          type: "string",
          enum: ["exact", "next_occurrence", "range", "missing"],
          description: "exact when the user supplied an exact day/date; next_occurrence when the date was omitted but a complete time or start-plus-duration was supplied; range for an imprecise window such as next week/month; missing when an exact day is still required.",
        },
        start: {
          type: "string",
          enum: ["user", "relative", "missing"],
          description: "user for a supplied clock/named time; relative for a supplied expression such as in one hour; missing when no start was supplied or implied.",
        },
        end: {
          type: "string",
          enum: ["user", "duration", "missing"],
          description: "user for a supplied end time; duration when the user supplied a duration; missing when neither was supplied.",
        },
        durationMinutes: {
          type: "integer",
          minimum: 1,
          maximum: 10080,
          description: "Required only when end is duration. Convert the user's duration to minutes.",
        },
      },
      required: ["date", "start", "end"],
      additionalProperties: false,
    },
    details: { type: "string", maxLength: 4000, description: "Event notes, agenda, links, or context. Maps to Google Calendar description." },
    location: { type: "string" },
    attendees: { type: "array", items: { type: "string", minLength: 3 }, description: "Guest email addresses." },
  },
  required: ["title", "resolution"],
  additionalProperties: false,
};

export const COMPACT_CALENDAR_CREATE_DESCRIPTION = "Create a new calendar event from the current compact-calendar request. You are the semantic authority: interpret the current user request and always provide the resolution object. The server checks only the structured decision and executable timestamps; it does not parse the user's wording. Use TimeContext.userTimezone to compute the correct offset on the event date, including daylight-saving changes. Use date exact for a supplied exact day/date, next_occurrence when a complete time range or start plus duration omitted the date, range for an imprecise window such as next week/month, and missing when a day is still required. Use start user/relative/missing and end user/duration/missing according to what the user actually supplied. Never reuse values from an unrelated request or label invented values as user-provided. If a required field is missing, prefer CLARIFY instead of calling this tool. Use only for true calendar events, not todos.";

type OpenAIToolDefinitionLike = {
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function withCompactCalendarCreateContract<T extends OpenAIToolDefinitionLike>(tools: T[]): T[] {
  return tools.map((tool) => {
    if (tool.function?.name !== "calendar_create") return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        description: COMPACT_CALENDAR_CREATE_DESCRIPTION,
        parameters: CompactCalendarCreateParameters,
      },
    } as T;
  });
}

export const CalendarUpdateParameters = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, description: "Event id from prior results." },
    source: { type: "string", enum: ["google", "local"] },
    start: { type: "string", minLength: 4, description: "Updated start as a full ISO 8601 datetime with timezone offset." },
    end: { type: "string", minLength: 4, description: "Updated end as a full ISO 8601 datetime with timezone offset." },
    title: { type: "string", minLength: 1 },
    details: { type: "string", maxLength: 4000, description: "Updated event notes, agenda, links, or context. Maps to Google Calendar description." },
    location: { type: "string" },
    attendees: { type: "array", items: { type: "string", minLength: 3 }, description: "Full replacement guest list." },
  },
  required: ["id"],
  additionalProperties: false,
};

export const CalendarDeleteParameters = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, description: "Event id from prior results." },
    source: { type: "string", enum: ["google", "local"] },
  },
  required: ["id"],
  additionalProperties: false,
};

export const CalendarSearchParameters = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, description: "Keyword to match against title or location. Use this for named event checks like interviews, birthdays, meetings, or calls." },
    from: { type: "string", description: "Optional ISO 8601 range start." },
    to: { type: "string", description: "Optional ISO 8601 range end." },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    source: { type: "string", enum: ["google", "local"] },
    openIntent: { type: "boolean", description: "Set true when the user wants to open or show one specific matching event." },
  },
  required: ["query"],
  additionalProperties: false,
};

export const calendarTools: ToolDef[] = [
  {
    name: "calendar_fetch_range",
    description: "Fetch calendar events in a time range. Use for broad listings such as today, this week, or all upcoming events. Do not use for named event types or keyword-filtered checks like interviews, birthdays, meetings, or calls.",
    mode: "client",
    schema: CalendarFetchRangeSchema,
    parameters: CalendarFetchRangeParameters,
  },
  {
    name: "calendar_get_details",
    description: "Fetch full details for one calendar event, including description, attendees, and links. Use when the user asks for details about an event already identified.",
    mode: "client",
    schema: CalendarGetDetailsSchema,
    parameters: CalendarGetDetailsParameters,
  },
  {
    name: "calendar_create",
    description: "Create a new calendar event only after the user supplied or explicitly implied both start and end times. Ask for a missing time instead of inventing midnight, an end time, or a default duration. Never create a new event in the past. Use this only for items that should truly live on the calendar, such as meetings, appointments, interviews, calls, lunches, or other events. Do not use this for todos, even when a todo has an explicit time. Start and end must be full ISO 8601 datetimes with timezone offsets.",
    mode: "client",
    schema: CalendarCreateSchema,
    parameters: CalendarCreateParameters,
  },
  {
    name: "calendar_update",
    description: "Update or move one identified calendar event. Use ids from prior results and pass only the fields that should change. Do not use this to represent or preserve a timed todo.",
    mode: "client",
    schema: CalendarUpdateSchema,
    parameters: CalendarUpdateParameters,
  },
  {
    name: "calendar_delete",
    description: "Delete one identified calendar event. Prefer ids from prior results.",
    mode: "client",
    schema: CalendarDeleteSchema,
    parameters: CalendarDeleteParameters,
  },
  {
    name: "calendar_search",
    description: "Search calendar events by keyword with optional date filters. Use for named event/activity checks like 'Do I have any interviews coming up?' and only treat returned matches as relevant.",
    mode: "client",
    schema: CalendarSearchSchema,
    parameters: CalendarSearchParameters,
  },
];
