// import { z } from "zod";
// import type { ToolDef } from "./todo";

// export const NoteFetchRecentSchema = z.object({
//   limit: z.number().int().min(1).max(20).optional(),
//   offset: z.number().int().min(0).optional(),
// });

// export const NoteFetchRecentParameters = {
//   type: "object",
//   properties: {
//     limit: { type: "number", minimum: 1, maximum: 20 },
//     offset: { type: "number", minimum: 0 },
//   },
//   additionalProperties: false,
// };

// export const NoteSearchSchema = z.object({
//   query: z.string().min(1),
//   limit: z.number().int().min(1).max(20).optional(),
// });

// export const NoteSearchParameters = {
//   type: "object",
//   properties: {
//     query: { type: "string", minLength: 1 },
//     limit: { type: "number", minimum: 1, maximum: 20 },
//   },
//   required: ["query"],
//   additionalProperties: false,
// };

// export const NoteGetDetailsSchema = z.object({
//   noteId: z.string().min(1),
// });

// export const NoteGetDetailsParameters = {
//   type: "object",
//   properties: {
//     noteId: { type: "string", minLength: 1 },
//   },
//   required: ["noteId"],
//   additionalProperties: false,
// };

// export const NoteSummarizeSchema = z.object({
//   noteId: z.string().min(1),
// });

// export const NoteSummarizeParameters = {
//   type: "object",
//   properties: {
//     noteId: { type: "string", minLength: 1 },
//   },
//   required: ["noteId"],
//   additionalProperties: false,
// };

// export const NoteCreateSchema = z.object({
//   noteId: z.string().optional(),
//   title: z.string().optional(),
//   content: z.string().min(1),
//   folderId: z.string().optional(),
// });

// export const NoteCreateParameters = {
//   type: "object",
//   properties: {
//     noteId: { type: "string", description: "If provided, updates this existing note instead of creating new" },
//     title: { type: "string" },
//     content: { type: "string", minLength: 1 },
//     folderId: { type: "string" },
//   },
//   required: ["content"],
//   additionalProperties: false,
// };

// export const NoteCreateForEventSchema = z.object({
//   title: z.string().min(1),
//   content: z.string().min(1),
//   eventId: z.string().min(1),
//   folderId: z.string().optional(),
// });

// export const NoteCreateForEventParameters = {
//   type: "object",
//   properties: {
//     title: { type: "string", minLength: 1 },
//     content: { type: "string", minLength: 1 },
//     eventId: { type: "string", minLength: 1 },
//     folderId: { type: "string" },
//   },
//   required: ["title", "content", "eventId"],
//   additionalProperties: false,
// };

// export const NoteUpdatePreviewSchema = z.object({
//   noteId: z.string().min(1),
//   content: z.string().min(1),
//   title: z.string().optional(),
// });

// export const NoteUpdatePreviewParameters = {
//   type: "object",
//   properties: {
//     noteId: { type: "string", minLength: 1, description: "The ID of the note to update" },
//     content: { type: "string", minLength: 1, description: "The new content to add to the note" },
//     title: { type: "string", description: "Optional new title" },
//   },
//   required: ["noteId", "content"],
//   additionalProperties: false,
// };

// export const NoteUpdateConfirmSchema = z.object({
//   noteId: z.string().min(1),
//   content: z.string().optional(),
//   title: z.string().optional(),
// });

// export const NoteUpdateConfirmParameters = {
//   type: "object",
//   properties: {
//     noteId: { type: "string", minLength: 1 },
//     content: { type: "string" },
//     title: { type: "string" },
//   },
//   required: ["noteId"],
//   additionalProperties: false,
// };

// export const noteTools: ToolDef[] = [
//   {
//     name: "note_fetch_recent",
//     description: "Fetch recent notes with pagination. Returns notes sorted by timestamp descending. Default limit is 5.",
//     mode: "client",
//     schema: NoteFetchRecentSchema,
//     parameters: NoteFetchRecentParameters,
//   },
//   {
//     name: "note_search",
//     description: "Search notes by title or content. Returns matching notes.",
//     mode: "client",
//     schema: NoteSearchSchema,
//     parameters: NoteSearchParameters,
//   },
//   {
//     name: "note_get_details",
//     description: "Get full details of a specific note by ID. Use this to VIEW a note.",
//     mode: "client",
//     schema: NoteGetDetailsSchema,
//     parameters: NoteGetDetailsParameters,
//   },
//   {
//     name: "note_summarize",
//     description: "Get note content for summarization. Display-only, does not edit.",
//     mode: "client",
//     schema: NoteSummarizeSchema,
//     parameters: NoteSummarizeParameters,
//   },
//   {
//     name: "note_create",
//     description: "Create a new note OR update existing if noteId provided. For updates: pass noteId and content.",
//     mode: "client",
//     schema: NoteCreateSchema,
//     parameters: NoteCreateParameters,
//   },
//   {
//     name: "note_update_preview",
//     description: "Preview an update to an existing note. Shows confirmation before saving. Use when user says 'add data to it', 'fill it with', 'add content'. YOU must generate the content.",
//     mode: "client",
//     schema: NoteUpdatePreviewSchema,
//     parameters: NoteUpdatePreviewParameters,
//   },
//   {
//     name: "note_update_confirm",
//     description: "Confirm and save the note update after user approval.",
//     mode: "client",
//     schema: NoteUpdateConfirmSchema,
//     parameters: NoteUpdateConfirmParameters,
//   },
//   {
//     name: "note_create_for_event",
//     description: "Create a new note linked to a calendar event via eventId.",
//     mode: "client",
//     schema: NoteCreateForEventSchema,
//     parameters: NoteCreateForEventParameters,
//   },
// ];

