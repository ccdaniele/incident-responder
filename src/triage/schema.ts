import { z } from "zod";

export const triageSchema = z
  .object({
    root_cause: z.string().min(1),
    suspect_commit: z.string().min(1),
    suspect_files: z.array(z.string().min(1)),
    evidence: z.array(z.string().min(1)),
    affected_area: z.enum(["checkout", "collections", "credit", "other"]),
    confidence: z.number().min(0).max(1),
    proposed_fix: z.string().min(1),
  })
  .strict();

export type TriageResult = z.infer<typeof triageSchema>;

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    }
    throw new Error("reply did not contain a JSON object");
  }
}

export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}
