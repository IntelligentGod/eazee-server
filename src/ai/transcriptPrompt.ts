export type TranscriptSegment = {
  start: number;
  duration?: number;
  text: string;
};

export type TranscriptPromptChunk = {
  startSeconds: number;
  endSeconds: number;
  transcript: string;
};

const MAX_COMPACT_TRANSCRIPT_LINE_LENGTH = 500;

function compactTranscriptLine(second: number, text: string) {
  return `[${second}s] ${text}`.slice(0, MAX_COMPACT_TRANSCRIPT_LINE_LENGTH);
}

export function buildTranscriptPromptChunks(
  segments: TranscriptSegment[],
  maxChars = 24000
): TranscriptPromptChunk[] {
  if (maxChars < 1) {
    return [];
  }

  const chunks: TranscriptPromptChunk[] = [];
  let lines: string[] = [];
  let currentLength = 0;
  let lastSecond = -1;
  let startSeconds = 0;
  let endSeconds = 0;

  const flushChunk = () => {
    if (!lines.length) {
      return;
    }

    chunks.push({
      startSeconds,
      endSeconds,
      transcript: lines.join("\n"),
    });
    lines = [];
    currentLength = 0;
    lastSecond = -1;
  };

  for (const segment of segments) {
    if (!segment.text) {
      continue;
    }

    const second = Math.max(0, Math.floor(segment.start));
    const line = compactTranscriptLine(second, segment.text);

    if (!lines.length) {
      startSeconds = second;
      endSeconds = second;
    }

    if (second == lastSecond && lines.length) {
      const previous = lines[lines.length - 1];
      const merged = compactTranscriptLine(second, `${previous.replace(/^\[\d+s\]\s*/, "")} ${segment.text}`);
      currentLength += merged.length - previous.length;
      lines[lines.length - 1] = merged;
      endSeconds = second;
      continue;
    }

    const additionLength = line.length + (lines.length ? 1 : 0);
    if (lines.length && currentLength + additionLength > maxChars) {
      flushChunk();
      startSeconds = second;
      endSeconds = second;
    }

    lines.push(line);
    currentLength += line.length + (lines.length > 1 ? 1 : 0);
    lastSecond = second;
    endSeconds = second;
  }

  flushChunk();
  return chunks;
}
