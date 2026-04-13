export function buildDigestSystemPrompt(): string {
  return `You are a feedback analyst for a prompt engineering platform. You will receive evaluator feedback on prompt outputs and must produce a structured analysis.

Your output MUST be valid JSON with this exact schema:
{
  "summary": "2-3 sentence overview of the feedback patterns",
  "themes": [
    {
      "title": "Theme name",
      "severity": "high" | "medium" | "low",
      "description": "What evaluators are consistently saying",
      "feedbackCount": <number of feedback items contributing to this theme>
    }
  ],
  "recommendations": ["Actionable suggestion 1", "Actionable suggestion 2", ...]
}

Guidelines:
- Group similar feedback into themes
- Assign severity based on frequency and impact: "high" for issues mentioned by multiple evaluators or affecting core quality, "medium" for recurring but non-critical issues, "low" for minor or isolated observations
- Recommendations should be specific and actionable (e.g., "Add a tone constraint to the system message" not "Improve tone")
- Do NOT include evaluator names or IDs in the output
- Keep the summary concise — 2-3 sentences max
- Include 2-5 themes, not more
- Include 2-4 recommendations`;
}

export function buildDigestUserPrompt(context: {
  projectName: string;
  versionNumber: number;
  outputFeedback: Array<{
    blindLabel: string;
    highlightedText: string;
    comment: string;
    tags?: string[];
  }>;
  promptFeedback: Array<{
    targetField: string;
    highlightedText: string;
    comment: string;
    tags?: string[];
  }>;
  runComments: string[];
  preferences: {
    totalRatings: number;
    bestCount: number;
    acceptableCount: number;
    weakCount: number;
  } | null;
}): string {
  const parts: string[] = [];

  parts.push(`# Feedback for "${context.projectName}" v${context.versionNumber}\n`);

  if (context.preferences) {
    const p = context.preferences;
    parts.push(`## Preference Ratings (${p.totalRatings} total)`);
    parts.push(`- Best: ${p.bestCount}`);
    parts.push(`- Acceptable: ${p.acceptableCount}`);
    parts.push(`- Weak: ${p.weakCount}\n`);
  }

  if (context.outputFeedback.length > 0) {
    parts.push(`## Output Annotations (${context.outputFeedback.length})`);
    for (const fb of context.outputFeedback) {
      const tagStr = fb.tags?.length ? ` [${fb.tags.join(", ")}]` : "";
      parts.push(`- [Output ${fb.blindLabel}]${tagStr} "${fb.highlightedText}" → ${fb.comment}`);
    }
    parts.push("");
  }

  if (context.promptFeedback.length > 0) {
    parts.push(`## Prompt Annotations (${context.promptFeedback.length})`);
    for (const fb of context.promptFeedback) {
      const tagStr = fb.tags?.length ? ` [${fb.tags.join(", ")}]` : "";
      parts.push(`- [${fb.targetField}]${tagStr} "${fb.highlightedText}" → ${fb.comment}`);
    }
    parts.push("");
  }

  if (context.runComments.length > 0) {
    parts.push(`## General Comments (${context.runComments.length})`);
    for (const comment of context.runComments) {
      parts.push(`- ${comment}`);
    }
    parts.push("");
  }

  parts.push("Analyze this feedback and produce the JSON summary.");

  return parts.join("\n");
}
