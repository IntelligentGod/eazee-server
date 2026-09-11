import { z } from "zod";

export type ToolMode = "server" | "client";

export type ToolDef = {
  name: string;
  description: string;
  mode: ToolMode;
  schema: z.ZodTypeAny;
  parameters: any; // JSON Schema for OpenAI tools API
};

const TodoRecurrenceSchema = z.object({
  interval: z.number().int().min(1).max(99),
  unit: z.enum(["day", "week", "month"]),
});

const TodoRecurrenceParameters = {
  type: "object",
  description: "Repeat rule for Personal basic todos only. Use { interval: 1, unit: 'day' } for daily/every day, { interval: 1, unit: 'week' } for weekly, { interval: 1, unit: 'month' } for monthly, or every N days/weeks/months with the matching interval and unit. Do not use for Goals or Wishlist.",
  properties: {
    interval: { type: "number", minimum: 1, maximum: 99 },
    unit: { type: "string", enum: ["day", "week", "month"] },
  },
  required: ["interval", "unit"],
  additionalProperties: false,
};

const TodoItemBase = z.object({
  text: z.string().min(1).max(200),
  details: z.string().optional(),
  dueDate: z.string().optional(),
  hasDueTime: z.boolean().optional(),
  starred: z.boolean().optional(),
  workspace: z.string().optional(),
  recurrence: TodoRecurrenceSchema.optional(),
});

export const TodoCreateManySchema = z.object({
  items: z.array(TodoItemBase).min(1),
});

const TodoGuidanceStepSchema = z.object({
  title: z.string().min(1).max(160),
  details: z.string().max(500).optional(),
});

export const TodoCreateWithStepsSchema = z.object({
  title: z.string().min(1).max(200),
  details: z.string().max(4000).optional(),
  dueDate: z.string().optional(),
  hasDueTime: z.boolean().optional(),
  starred: z.boolean().optional(),
  steps: z.array(TodoGuidanceStepSchema).min(1).max(24),
  note: z.string().max(800).optional(),
  sourceQuestion: z.string().max(8000).optional(),
  sourceAnswer: z.string().max(12000).optional(),
});

export const TodoCreateWithStepsParameters = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Concise todo title from the user's original goal or request. Never use vague text like 'these steps'.",
    },
    details: { type: "string", maxLength: 4000 },
    dueDate: { type: "string", description: "Use YYYY-MM-DD for day-level dates. Use a full ISO 8601 datetime with timezone offset when the todo has an explicit time." },
    hasDueTime: { type: "boolean", description: "Set true when dueDate includes an explicit time." },
    starred: { type: "boolean" },
    steps: {
      type: "array",
      description: "Ordered checkable steps from the assistant's prior answer or current plan.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 160 },
          details: { type: "string", maxLength: 500 },
        },
        required: ["title"],
        additionalProperties: false,
      },
      minItems: 1,
      maxItems: 24,
    },
    note: { type: "string", maxLength: 800 },
    sourceQuestion: { type: "string", maxLength: 8000, description: "Original user question or goal that produced the steps, when available." },
    sourceAnswer: { type: "string", maxLength: 12000, description: "Short summary or exact prior assistant answer containing the steps, when available. The client will trim saved history if needed." },
  },
  required: ["title", "steps"],
  additionalProperties: false,
};

export const TodoCreateManyParameters = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 200 },
          details: { type: "string" },
          dueDate: { type: "string", description: "Use YYYY-MM-DD for day-level dates. Use a full ISO 8601 datetime with timezone offset when the todo has an explicit time. A timed todo is still a todo, not a calendar event." },
          hasDueTime: { type: "boolean", description: "Set true when dueDate includes an explicit time. Timed todos stay in todos." },
          starred: { type: "boolean" },
          workspace: { type: "string" },
          recurrence: TodoRecurrenceParameters,
        },
        required: ["text"],
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const IdOrTextBase = z.object({
  id: z.string().optional(),
  text: z.string().min(1).max(200).optional(),
});

const IdOrText = IdOrTextBase.refine((it) => !!(it.id || it.text), { message: 'id or text is required' });

export const TodoDeleteManySchema = z.object({
  items: z.array(IdOrText).min(1),
});

export const TodoDeleteManyParameters = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string", minLength: 1, maxLength: 200 },
        },
        required: [],
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  required: ["items"],
  additionalProperties: false,
};

export const TodoCompleteManySchema = z.object({
  items: z.array(IdOrText).min(1),
});

export const TodoCompleteManyParameters = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string", minLength: 1, maxLength: 200 },
        },
        required: [],
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const TodoEditItemSchema = z
  .object({
    id: z.string().optional(),
    oldText: z.string().min(1).max(200).optional(),
    newText: z.string().min(1).max(200).optional(),
    details: z.string().optional(),
    dueDate: z.string().optional(),
    hasDueTime: z.boolean().optional(),
    workspace: z.string().optional(),
    starred: z.boolean().optional(),
    recurrence: TodoRecurrenceSchema.nullable().optional(),
    updateDetails: z.boolean().optional(),
  })
  .refine((it) => !!(it.id || it.oldText), { message: 'id or oldText is required' })
  .refine(
    (it) =>
      typeof it.newText !== 'undefined' ||
      typeof it.details !== 'undefined' ||
      typeof it.dueDate !== 'undefined' ||
      typeof it.workspace !== 'undefined' ||
      typeof it.starred !== 'undefined' ||
      typeof it.recurrence !== 'undefined' ||
      typeof it.updateDetails !== 'undefined',
    { message: 'At least one field to update must be provided' }
  );

export const TodoEditManySchema = z.object({
  items: z.array(TodoEditItemSchema).min(1),
});

export const TodoEditManyParameters = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          oldText: { type: "string", minLength: 1, maxLength: 200 },
          newText: { type: "string", minLength: 1, maxLength: 200 },
          details: { type: "string" },
          dueDate: { type: "string" },
          hasDueTime: { type: "boolean" },
          workspace: { type: "string" },
          starred: { type: "boolean" },
          recurrence: {
            anyOf: [TodoRecurrenceParameters, { type: "null" }],
            description: "Set repeat rule for Personal basic todos, or null to turn repeat off. Supported units: day, week, month.",
          },
          updateDetails: { type: "boolean" },
        },
        required: [],
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  required: ["items"],
  additionalProperties: false,
};

export const TodoStarToggleManySchema = z.object({
  items: z
    .array(
      IdOrTextBase.extend({
        starred: z.boolean().optional(), // if omitted, toggle
      }).refine((it) => !!(it.id || it.text), { message: 'id or text is required' })
    )
    .min(1),
});

export const TodoStarToggleManyParameters = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string", minLength: 1, maxLength: 200 },
          starred: { type: "boolean" },
        },
        required: [],
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  required: ["items"],
  additionalProperties: false,
};

export const todoTools: ToolDef[] = [
  /*
  client - will execute on device locally
  server - will execute on server
  */
  {
    name: "todo_create_with_steps",
    description: "Create one main Personal todo with ordered checkable guidance steps saved inside it. Use this when the user asks to create/save/make a todo from 'these steps', 'this plan', 'the steps above', or a multi-step assistant answer. Do not use todo_create_many for steps that belong under one main todo.",
    mode: "client",
    schema: TodoCreateWithStepsSchema,
    parameters: TodoCreateWithStepsParameters,
  },
  {
    name: "todo_create_many",
    description: "Create one or more independent todos. Use this for add/create task requests where each item should be a separate todo. Do not use this when the user asks to save one task with multiple steps; use todo_create_with_steps instead. For explicit purchase intent such as buy, order, purchase, want to buy, or want to order, create the todo in the Wishlist workspace and set text to only the cleaned item name. Remove leading intent wording and simple articles like a, an, or the. Preserve meaningful product names, model names, numbers, and versions. Use YYYY-MM-DD for day-level due dates. When a todo has an explicit time, use a full ISO 8601 dueDate with timezone offset and set hasDueTime true. For recurring Personal todos, set recurrence to { interval, unit } where unit is day, week, or month. Map daily/every day to { interval: 1, unit: 'day' }, weekly to { interval: 1, unit: 'week' }, monthly to { interval: 1, unit: 'month' }, and every N days/weeks/months to the matching interval/unit. Do not use recurrence for Goals or Wishlist. Do not use calendar tools for a task just because it has a time. If the user says task or todo, keep it as a todo.",
    mode: "client",
    schema: TodoCreateManySchema,
    parameters: TodoCreateManyParameters,
  },
  {
    name: "todo_delete_many",
    description: "Delete one or more specific todos. Prefer id when available from prior results; otherwise use exact text. Do not use this for requests that delete a whole day except one or more todos.",
    mode: "client",
    schema: TodoDeleteManySchema,
    parameters: TodoDeleteManyParameters,
  },
  {
    name: "todo_complete_many",
    description: "Mark one or more todos complete. Prefer id when available from prior results; otherwise use exact text.",
    mode: "client",
    schema: TodoCompleteManySchema,
    parameters: TodoCompleteManyParameters,
  },
  {
    name: "todo_edit_many",
    description: "Edit one or more todos by id or oldText. Update only the fields that should change. Use YYYY-MM-DD for day-level due dates, or a full ISO 8601 dueDate with timezone offset plus hasDueTime true for timed todos. Preserve a todo's known time unless the user explicitly changes it. For recurring Personal todos, set recurrence to { interval, unit } where unit is day, week, or month; set recurrence null only when the user explicitly asks to stop repeating. If the user wants something to be a task or todo, keep it in todos and do not recreate it as a calendar event.",
    mode: "client",
    schema: TodoEditManySchema,
    parameters: TodoEditManyParameters,
  },
  {
    name: "todo_star_toggle_many",
    description: "Star, unstar, or toggle one or more todos. Prefer id when available from prior results; otherwise use exact text.",
    mode: "client",
    schema: TodoStarToggleManySchema,
    parameters: TodoStarToggleManyParameters,
  },
  // Query tool for read-only listing; LLM can fetch lists instead of synthesizing
  {
    name: "todo_query",
    description: "Query todos with filters. Use this for list/show/find/search requests and for disambiguation before making a risky change. By default this returns active tasks only, not completed tasks, and should be presented with today's matching tasks first and overdue matching tasks after them. Set completed true only when the user explicitly asks for completed tasks. Past, older, or overdue tasks are still active tasks, not completed ones. Set overdueOnly true when the user explicitly asks for only past or overdue active tasks. If the user asks for both completed and overdue tasks, call todo_query separately for each. Use YYYY-MM-DD for dueDateDay and range values.",
    mode: "client",
    schema: z.object({
      limit: z.number().int().min(1).max(200).optional(),
      dueDateDay: z.string().optional(),
      range: z.object({ from: z.string().optional(), to: z.string().optional() }).partial().optional(),
      textContains: z.string().optional(),
      completed: z.boolean().optional(),
      overdueOnly: z.boolean().optional(),
      recurringOnly: z.boolean().optional(),
      starred: z.boolean().optional(),
      workspace: z.string().optional(),
      openIntent: z.boolean().optional(),
    }),
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 200 },
        dueDateDay: { type: "string", description: "Local calendar day in YYYY-MM-DD format." },
        range: {
          type: "object",
          properties: {
            from: { type: "string", description: "Inclusive local start day in YYYY-MM-DD format." },
            to: { type: "string", description: "Inclusive local end day in YYYY-MM-DD format." },
          },
          additionalProperties: false,
        },
        textContains: { type: "string" },
        completed: { type: "boolean", description: "Set true only when the user explicitly asks for completed, done, or finished tasks. When omitted, the default is incomplete tasks only." },
        overdueOnly: { type: "boolean", description: "Set true only when the user explicitly asks for only overdue, past, or older active tasks. Overdue tasks are not completed tasks." },
        recurringOnly: { type: "boolean", description: "Set true when the user asks for recurring or repeating todos." },
        starred: { type: "boolean" },
        workspace: { type: "string" },
        openIntent: { type: "boolean", description: "Set true when the user wants to open or show one specific matching todo." },
      },
      additionalProperties: false,
    },
  },
];

// Date-based tools for better LLM ergonomics when filtering by day
export const TodoDeleteByDaySchema = z.object({
  date: z.string().min(4).max(40), // YYYY-MM-DD or ISO 8601
});

export const TodoDeleteByDayParameters = {
  type: "object",
  properties: {
    date: { type: "string", minLength: 4, maxLength: 40, description: "Local calendar day in YYYY-MM-DD format." },
  },
  required: ["date"],
  additionalProperties: false,
};

export const TodoCompleteByDaySchema = z.object({
  date: z.string().min(4).max(40),
});

export const TodoCompleteByDayParameters = {
  type: "object",
  properties: {
    date: { type: "string", minLength: 4, maxLength: 40, description: "Local calendar day in YYYY-MM-DD format." },
  },
  required: ["date"],
  additionalProperties: false,
};

const IdOrTextArrayItem = IdOrTextBase.refine((it) => !!(it.id || it.text), { message: 'id or text is required' });

export const TodoDeleteByDayExceptSchema = z.object({
  date: z.string().min(4).max(40),
  except: z.array(IdOrTextArrayItem).min(1),
});

export const TodoDeleteByDayExceptParameters = {
  type: "object",
  properties: {
    date: { type: "string", minLength: 4, maxLength: 40, description: "Local calendar day in YYYY-MM-DD format." },
    except: {
      type: "array",
      description: "Todos to preserve. These are the exceptions and must not be deleted.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string", minLength: 1, maxLength: 200 },
        },
        required: [],
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  required: ["date", "except"],
  additionalProperties: false,
};

// Push date tools at the end of the list
export const dateTools: ToolDef[] = [
  {
    name: "todo_delete_by_day",
    description: "Delete todos whose dueDate falls on one local calendar day. Use when the user refers to all todos on a specific day.",
    mode: "client",
    schema: TodoDeleteByDaySchema,
    parameters: TodoDeleteByDayParameters,
  },
  {
    name: "todo_delete_by_day_except",
    description: "Delete todos whose dueDate falls on one local calendar day except specific todos that must be preserved. Use for requests like 'delete everything from today except buy milk'. The except list is what to keep, not what to delete. Prefer ids when available from prior results; otherwise use exact text.",
    mode: "client",
    schema: TodoDeleteByDayExceptSchema,
    parameters: TodoDeleteByDayExceptParameters,
  },
  {
    name: "todo_complete_by_day",
    description: "Mark todos complete whose dueDate falls on one local calendar day. Use when the user refers to all todos on a specific day.",
    mode: "client",
    schema: TodoCompleteByDaySchema,
    parameters: TodoCompleteByDayParameters,
  },
];
