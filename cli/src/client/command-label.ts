export function buildCliCommandLabel(): string {
  const args = process.argv.slice(2);
  return args.length > 0 ? `paperclipai ${args.join(" ")}` : "paperclipai";
}

/**
 * Server-side cap on `command` in createCliAuthChallengeSchema
 * (packages/shared/src/validators/access.ts: z.string().min(1).max(240)).
 */
export const CLI_AUTH_COMMAND_MAX_LENGTH = 240;

/**
 * Fit a command label into the cli-auth challenge limit (wabnet local fix).
 * The label is display-only, shown on the approval page. Without this, a long argv
 * (for example `member permissions --payload-json '{...}'`) made the challenge
 * POST fail with "Validation error", and no approval URL was ever printed.
 * Over-long labels keep their start and end in an ellipsis. The length is counted
 * in UTF-16 code units, like zod's max(). A surrogate pair is never split.
 */
export function clampCliAuthCommandLabel(label: string, max = CLI_AUTH_COMMAND_MAX_LENGTH): string {
  if (label.length <= max) return label;
  const ellipsis = "…";
  const budget = max - ellipsis.length;
  let head = label.slice(0, Math.ceil(budget * 0.75));
  let tail = label.slice(label.length - (budget - head.length));
  // Drop a dangling high surrogate at the head's end or a low surrogate at the tail's start.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `${head}${ellipsis}${tail}`;
}
