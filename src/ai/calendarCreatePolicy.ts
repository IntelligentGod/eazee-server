import { CalendarCreateSchema } from "../tools/calendar";

export type CalendarCreateCallLike = {
  name: string;
  arguments: unknown;
  raw?: {
    function?: {
      arguments?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

type RouteMessageLike = {
  role?: string;
  content?: unknown;
};

export type CalendarTimeContext = {
  nowLocalIso: string;
  userTimezone: string;
};

type CalendarCreateResolution = {
  date: "exact" | "next_occurrence" | "range" | "missing";
  start: "user" | "relative" | "missing";
  end: "user" | "duration" | "missing";
  durationMinutes?: number;
};

const DATE_RESOLUTIONS = new Set(["exact", "next_occurrence", "range", "missing"]);
const START_RESOLUTIONS = new Set(["user", "relative", "missing"]);
const END_RESOLUTIONS = new Set(["user", "duration", "missing"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readResolution(args: Record<string, unknown>): CalendarCreateResolution | null {
  if (!isRecord(args.resolution)) return null;
  const date = args.resolution.date;
  const start = args.resolution.start;
  const end = args.resolution.end;
  if (typeof date !== "string" || !DATE_RESOLUTIONS.has(date)) return null;
  if (typeof start !== "string" || !START_RESOLUTIONS.has(start)) return null;
  if (typeof end !== "string" || !END_RESOLUTIONS.has(end)) return null;
  return {
    date: date as CalendarCreateResolution["date"],
    start: start as CalendarCreateResolution["start"],
    end: end as CalendarCreateResolution["end"],
    durationMinutes: typeof args.resolution.durationMinutes === "number"
      ? args.resolution.durationMinutes
      : undefined,
  };
}

function parseFullIsoDatetime(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const timeSeparator = trimmed.indexOf("T");
  if (timeSeparator <= 0) return null;
  const timeAndOffset = trimmed.slice(timeSeparator + 1);
  if (!timeAndOffset.includes(":")) return null;
  const hasOffset = timeAndOffset.endsWith("Z")
    || timeAndOffset.includes("+")
    || timeAndOffset.lastIndexOf("-") > 0;
  if (!hasOffset) return null;
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? { value: trimmed, timestamp } : null;
}

function getExplicitIsoOffsetMinutes(value: string) {
  if (value.endsWith("Z")) return 0;
  const timeSeparator = value.indexOf("T");
  if (timeSeparator <= 0) return null;
  const timeAndOffset = value.slice(timeSeparator + 1);
  const plusIndex = timeAndOffset.lastIndexOf("+");
  const minusIndex = timeAndOffset.lastIndexOf("-");
  const offsetIndex = Math.max(plusIndex, minusIndex);
  if (offsetIndex <= 0) return null;
  const offset = timeAndOffset.slice(offsetIndex);
  const separator = offset.indexOf(":");
  if (separator <= 1) return null;
  const hours = Number(offset.slice(1, separator));
  const minutes = Number(offset.slice(separator + 1));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    return null;
  }
  const sign = offset[0] === "-" ? -1 : offset[0] === "+" ? 1 : 0;
  return sign ? sign * (hours * 60 + minutes) : null;
}

function getTimeZoneOffsetMinutes(timestamp: number, userTimezone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: userTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(
      Number(values.get("year")),
      Number(values.get("month")) - 1,
      Number(values.get("day")),
      Number(values.get("hour")),
      Number(values.get("minute")),
      Number(values.get("second"))
    );
    const wholeSecondTimestamp = Math.floor(timestamp / 1000) * 1000;
    const offsetMinutes = (localAsUtc - wholeSecondTimestamp) / 60_000;
    return Number.isFinite(offsetMinutes) ? offsetMinutes : null;
  } catch {
    return null;
  }
}

function hasTimeZoneOffset(value: string, timestamp: number, userTimezone: string) {
  const explicitOffset = getExplicitIsoOffsetMinutes(value);
  const timeZoneOffset = getTimeZoneOffsetMinutes(timestamp, userTimezone);
  return explicitOffset !== null
    && timeZoneOffset !== null
    && explicitOffset === timeZoneOffset;
}

function withArguments<T extends CalendarCreateCallLike>(call: T, args: Record<string, unknown>): T {
  return {
    ...call,
    arguments: args,
    ...(call.raw
      ? {
          raw: {
            ...call.raw,
            function: {
              ...call.raw.function,
              arguments: args,
            },
          },
        }
      : {}),
  };
}

export function getCalendarTimeContext(messages: RouteMessageLike[]): CalendarTimeContext | null {
  const prefix = "TimeContext:";
  for (const message of messages) {
    if (message?.role !== "system" || typeof message.content !== "string") continue;
    const content = message.content.trim();
    if (!content.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(content.slice(prefix.length).trim());
      if (typeof parsed?.nowLocal !== "string" || typeof parsed?.userTimezone !== "string") continue;
      const timestamp = Date.parse(parsed.nowLocal);
      if (!Number.isFinite(timestamp)) continue;
      if (!hasTimeZoneOffset(parsed.nowLocal, timestamp, parsed.userTimezone)) continue;
      return {
        nowLocalIso: parsed.nowLocal,
        userTimezone: parsed.userTimezone,
      };
    } catch {}
  }
  return null;
}

export function enforceCalendarCreatePolicy<T extends CalendarCreateCallLike>(
  calls: T[],
  timeContext: CalendarTimeContext,
  maxCalendarCreates = 5
) {
  if (!calls.some((call) => call.name === "calendar_create")) return { calls };

  const calendarCreateCount = calls.filter((call) => call.name === "calendar_create").length;
  if (calendarCreateCount > maxCalendarCreates) {
    return {
      calls: [] as T[],
      clarification: `I can create up to ${maxCalendarCreates} events at once. Please split the request.`,
    };
  }

  let clarification: string | undefined;
  let retryInstruction: string | undefined;
  const rejectForUser = (question: string) => {
    clarification ||= question;
    return [] as T[];
  };
  const rejectForModel = (instruction: string, fallbackQuestion: string) => {
    retryInstruction ||= instruction;
    clarification ||= fallbackQuestion;
    return [] as T[];
  };

  const now = Date.parse(timeContext.nowLocalIso);
  const guardedCalls = calls.flatMap((call) => {
    if (call.name !== "calendar_create") return [call];

    const args = isRecord(call.arguments) ? call.arguments : {};
    const resolution = readResolution(args);
    if (!resolution) {
      return rejectForModel(
        "calendar_create requires resolution.date, resolution.start, and resolution.end. Re-read the current request and return those structured decisions without inventing missing fields.",
        "What day and times should I use?"
      );
    }

    if (resolution.date === "range" || resolution.date === "missing") {
      return rejectForUser("Which day should I use?");
    }
    if (resolution.start === "missing") {
      return rejectForUser("What time should it start?");
    }
    if (resolution.end === "missing") {
      return rejectForUser("What time should it end?");
    }

    const start = parseFullIsoDatetime(args.start);
    if (!start) {
      return rejectForModel(
        "calendar_create.start must be a full ISO 8601 datetime with a timezone offset when resolution.start is not missing.",
        "What time should it start?"
      );
    }
    if (!hasTimeZoneOffset(start.value, start.timestamp, timeContext.userTimezone)) {
      return rejectForModel(
        `calendar_create.start must use the UTC offset for ${timeContext.userTimezone} on the event date, including daylight-saving changes.`,
        "Could you restate the event time?"
      );
    }

    let end = resolution.end === "user" ? parseFullIsoDatetime(args.end) : null;
    if (resolution.end === "duration") {
      const durationMinutes = resolution.durationMinutes;
      if (!Number.isInteger(durationMinutes) || durationMinutes! <= 0 || durationMinutes! > 10_080) {
        return rejectForModel(
          "calendar_create resolution.end is duration, so resolution.durationMinutes must be an integer between 1 and 10080.",
          "How long should it last?"
        );
      }
      const timestamp = start.timestamp + durationMinutes! * 60_000;
      end = { value: new Date(timestamp).toISOString(), timestamp };
    }

    if (!end) {
      return rejectForModel(
        "calendar_create.end must be a full ISO 8601 datetime with a timezone offset when resolution.end is user.",
        "What time should it end?"
      );
    }
    if (
      resolution.end === "user"
      && !hasTimeZoneOffset(end.value, end.timestamp, timeContext.userTimezone)
    ) {
      return rejectForModel(
        `calendar_create.end must use the UTC offset for ${timeContext.userTimezone} on the event date, including daylight-saving changes.`,
        "Could you restate the event time?"
      );
    }
    if (end.timestamp <= start.timestamp) {
      return rejectForUser("What time should it end?");
    }

    if (start.timestamp <= now) {
      if (resolution.date === "next_occurrence") {
        return rejectForModel(
          "calendar_create uses date resolution next_occurrence, but start is not in the future. Resolve the next future occurrence from TimeContext and try again.",
          "What time should it start?"
        );
      }
      return rejectForUser("That time has passed. What time should it start?");
    }

    const normalizedArgs = { ...args, start: start.value, end: end.value };
    const validated = CalendarCreateSchema.safeParse(normalizedArgs);
    if (!validated.success) {
      return rejectForModel(
        "calendar_create arguments do not satisfy the tool schema. Return a corrected structured call without inventing user input.",
        "Could you restate the event details?"
      );
    }

    return [withArguments(call, validated.data)];
  });

  return {
    calls: guardedCalls,
    ...(clarification ? { clarification } : {}),
    ...(retryInstruction ? { retryInstruction } : {}),
  };
}

export function getCalendarCreateRecoveryAction(
  policy: { retryInstruction?: string; clarification?: string },
  alreadyRetried: boolean
) {
  if (policy.retryInstruction && !alreadyRetried) return "retry" as const;
  if (policy.clarification) return "clarify" as const;
  return "continue" as const;
}
