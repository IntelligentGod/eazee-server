const SIGNOFF_LINE_PATTERN = /^(?:best|regards|thanks|thank you|sincerely),?$/i;
const SIGNATURE_NAME_PATTERN = /^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}$/;

function stripTrailingSignoffBlock(value: string) {
  const lines = value.split(/\r?\n/);
  let lastNonEmptyIndex = lines.length - 1;
  while (lastNonEmptyIndex >= 0 && !lines[lastNonEmptyIndex].trim()) {
    lastNonEmptyIndex -= 1;
  }

  if (lastNonEmptyIndex < 0) return "";

  if (SIGNOFF_LINE_PATTERN.test(lines[lastNonEmptyIndex].trim())) {
    return lines.slice(0, lastNonEmptyIndex).join("\n");
  }

  const firstCandidateIndex = Math.max(0, lastNonEmptyIndex - 3);
  for (let index = lastNonEmptyIndex - 1; index >= firstCandidateIndex; index -= 1) {
    if (!SIGNOFF_LINE_PATTERN.test(lines[index].trim())) continue;
    if (index === 0 || lines[index - 1].trim()) continue;

    const trailingLines = lines.slice(index + 1, lastNonEmptyIndex + 1).filter((line) => line.trim());
    const isSignatureBlock =
      trailingLines.length > 0 &&
      trailingLines.length <= 2 &&
      trailingLines.every((line) => {
        const trimmed = line.trim();
        return trimmed.length <= 80 && SIGNATURE_NAME_PATTERN.test(trimmed);
      });

    if (isSignatureBlock) {
      return lines.slice(0, index).join("\n");
    }
  }

  return value;
}

export function cleanEmailDraftText(value: string) {
  const withoutFences = value.replace(/```[a-z]*\s*/gi, "").replace(/```/g, "").trim();
  const withoutPlaceholders = withoutFences
    .replace(/^\s*["']|["']\s*$/g, "")
    .replace(/\[(?:your\s+name|name)\]/gi, "")
    .replace(/[ \t]{2,}/g, " ");

  return stripTrailingSignoffBlock(withoutPlaceholders).trim();
}
