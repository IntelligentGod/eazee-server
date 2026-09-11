export type GlobalContext = {
  currentTab?: "todo" | "calendar";
  user?: { name?: string };
  // note?: { html?: string }; 
  todos?: {
    items?: Array<{
      text: string;
      dueDate?: string;
      workspace?: string;
      details?: string;
      starred?: boolean;
    }>;
  };
  calendar?: Record<string, any>;
};

export function buildContext(ctx: GlobalContext) {
  return `Context:\n${JSON.stringify(ctx).slice(0, 8000)};`;
}

