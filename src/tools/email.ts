import { z } from "zod";
import type { ToolDef } from "./todo";

const LimitSchema = z.number().int().min(1).max(20).optional();
const EmailFilterSchema = z.enum(["important", "all"]).optional();

export const EmailFetchLatestSchema = z.object({
  limit: LimitSchema,
  pageToken: z.string().optional(),
  filter: EmailFilterSchema,
});

export const EmailFetchLatestParameters = {
  type: "object",
  properties: {
    limit: { type: "number", minimum: 1, maximum: 20, description: "How many recent emails to fetch." },
    pageToken: { type: "string" },
    filter: { type: "string", enum: ["important", "all"], description: "Use important by default. Use all only when the user explicitly asks to show all emails." },
  },
  additionalProperties: false,
};

export const EmailGenerateReplySingleSchema = z.object({
  emailId: z.string().optional(),
  instruction: z.string().optional(),
  filter: EmailFilterSchema,
});

export const EmailGenerateReplySingleParameters = {
  type: "object",
  properties: {
    emailId: { type: "string", description: "Specific email id. Omit to use the latest email." },
    instruction: { type: "string", description: "Optional guidance to shape the draft reply." },
    filter: { type: "string", enum: ["important", "all"], description: "When emailId is omitted, use important by default. Use all only if the user explicitly asks to reply to the raw latest email." },
  },
  additionalProperties: false,
};

export const EmailGenerateReplyManySchema = z.object({
  emailIds: z.array(z.string()).min(1).optional(),
  limit: LimitSchema,
  filter: EmailFilterSchema,
});

export const EmailGenerateReplyManyParameters = {
  type: "object",
  properties: {
    emailIds: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "Specific email ids to draft replies for.",
    },
    limit: { type: "number", minimum: 1, maximum: 20, description: "How many latest emails to use if emailIds are omitted." },
    filter: { type: "string", enum: ["important", "all"], description: "When emailIds are omitted, use important by default. Use all only when explicitly requested." },
  },
  additionalProperties: false,
};

export const EmailSendReplySchema = z.object({
  emailId: z.string().min(1),
  reply: z.string().min(1),
});

export const EmailSendReplyParameters = {
  type: "object",
  properties: {
    emailId: { type: "string", minLength: 1, description: "The email being replied to." },
    reply: { type: "string", minLength: 1, description: "The final reply text to send." },
  },
  required: ["emailId", "reply"],
  additionalProperties: false,
};

export const EmailSendNewSchema = z.object({
  to: z.string().min(3),
  body: z.string().min(1),
  subject: z.string().optional(),
});

export const EmailSendNewParameters = {
  type: "object",
  properties: {
    to: { type: "string", minLength: 3, description: "Recipient email address." },
    body: { type: "string", minLength: 1, description: "Final email body to send." },
    subject: { type: "string", description: "Optional subject line." },
  },
  required: ["to", "body"],
  additionalProperties: false,
};

// NEW: Generate a new email draft (do not send)
export const EmailGenerateNewDraftSchema = z.object({
  to: z.string().min(3),
  body: z.string().min(1).optional(),
  subject: z.string().optional(),
});

export const EmailGenerateNewDraftParameters = {
  type: "object",
  properties: {
    to: { type: "string", minLength: 3, description: "Recipient email address." },
    body: { type: "string", minLength: 1, description: "Seed content or user intent for the new email draft." },
    subject: { type: "string", description: "Optional subject. Omit if it should be generated." },
  },
  required: ["to"],
  additionalProperties: false,
};

export const emailTools: ToolDef[] = [
  {
    name: "email_fetch_latest",
    description: "Fetch recent mail messages. Use for inbox/list/show latest email requests. Defaults to 1 if limit is omitted.",
    mode: "client",
    schema: EmailFetchLatestSchema,
    parameters: EmailFetchLatestParameters,
  },
  {
    name: "email_search",
    description: "Search mail messages by sender, subject, or raw mail query. Use when the user mentions a sender, topic, or keyword.",
    mode: "client",
    schema: z.object({
      from: z.string().min(1).optional(),
      subject: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      pageToken: z.string().optional(),
      filter: EmailFilterSchema,
    }),
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", minLength: 1 },
        subject: { type: "string", minLength: 1 },
        query: { type: "string", minLength: 1 },
        limit: { type: "number", minimum: 1, maximum: 20 },
        pageToken: { type: "string" },
        filter: { type: "string", enum: ["important", "all"], description: "Search all by default. Use important only when the user specifically asks for important matching email." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "email_generate_reply_single",
    description: "Generate a reply draft for one email by id, or for the latest email if emailId is omitted. This drafts only and does not send.",
    mode: "client",
    schema: EmailGenerateReplySingleSchema,
    parameters: EmailGenerateReplySingleParameters,
  },
  {
    name: "email_update_draft",
    description: "Replace the current draft text locally without regenerating it. Use when the user provides the exact new draft wording.",
    mode: "client",
    schema: z.object({
      reply: z.string().min(1),
    }),
    parameters: {
      type: "object",
      properties: {
        reply: { type: "string", minLength: 1 },
      },
      required: ["reply"],
      additionalProperties: false,
    },
  },
  {
    name: "email_refine_draft",
    description: "Rewrite the current draft based on user instructions such as tone, length, or content changes. This drafts only and does not send.",
    mode: "client",
    schema: z.object({
      instruction: z.string().min(1),
    }),
    parameters: {
      type: "object",
      properties: {
        instruction: { type: "string", minLength: 1 },
      },
      required: ["instruction"],
      additionalProperties: false,
    },
  },
  {
    name: "email_generate_reply_many",
    description: "Generate reply drafts for multiple emails by ids or for the latest N emails. This drafts only and does not send.",
    mode: "client",
    schema: EmailGenerateReplyManySchema,
    parameters: EmailGenerateReplyManyParameters,
  },
  {
    name: "email_generate_new_draft",
    description: "Generate a draft for a brand-new email to a recipient address without sending. Prefer this before email_send_new.",
    mode: "client",
    schema: EmailGenerateNewDraftSchema,
    parameters: EmailGenerateNewDraftParameters,
  },
  {
    name: "email_send_new",
    description: "Send a brand-new email. Only use this after the user explicitly confirms sending the final draft in the current conversation.",
    mode: "client",
    schema: EmailSendNewSchema,
    parameters: EmailSendNewParameters,
  },
  {
    name: "email_send_reply",
    description: "Send a reply to an email using the final draft text. Only use this after the user explicitly confirms sending in the current conversation.",
    mode: "client",
    schema: EmailSendReplySchema,
    parameters: EmailSendReplyParameters,
  },
];
