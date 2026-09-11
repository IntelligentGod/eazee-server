import { z } from "zod";
import type { ToolDef } from "./todo";

export const GoogleConnectionStatusSchema = z.object({});

export const GoogleConnectionStatusParameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const googleTools: ToolDef[] = [
  {
    name: "google_connection_status",
    description: "Check whether the user's Google account is connected and currently active for Google Calendar.",
    mode: "client",
    schema: GoogleConnectionStatusSchema,
    parameters: GoogleConnectionStatusParameters,
  },
];
