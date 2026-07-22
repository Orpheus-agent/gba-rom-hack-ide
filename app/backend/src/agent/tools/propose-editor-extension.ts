import { z } from 'zod';
import type { ToolContext } from '../types.js';

export const PROPOSE_EDITOR_EXTENSION_TOOL_NAME = 'propose_editor_extension';

export const PROPOSE_EDITOR_EXTENSION_DESCRIPTION =
  'Surface a capability gap to the user - call this when the user has ' +
  'asked for something that no existing MCP tool exposes, AND the right ' +
  "fix is to EXTEND THE EDITOR'S OWN SOURCE (a new MCP tool, a new " +
  'detector, a new frontend inspector, etc.) rather than working around ' +
  "the limitation manually.\n\n" +
  'The returned proposal is formatted as a structured markdown block the ' +
  "user reads in the AgentPanel. It tells them WHAT capability is " +
  "missing, WHY their request needs it, and what files would change. " +
  "After reading, the user toggles dev mode in the AgentPanel header and " +
  "asks you to proceed. With dev mode on you have access to Edit/Write/" +
  "Bash on the editor source and can implement the extension yourself.\n\n" +
  'When to call:\n' +
  '  - User asks for an entity type with no propose_X_edit tool (RT-3 ' +
  'shipped 5 of 15; the rest are gaps).\n' +
  "  - A detector underperforms on the user's ROM and you'd need to " +
  'rewrite scanner heuristics.\n' +
  "  - A rendering bug needs frontend changes you can't make via MCP " +
  'tools alone.\n' +
  '  - A new asset format (sprite atlas, music sequence, etc.) needs ' +
  'engine code to decode.\n\n' +
  "When NOT to call:\n" +
  "  - When propose_patch + binary_write_bytes can do the job directly " +
  "(one-off byte edits don't need a dedicated tool).\n" +
  "  - When the user asked for ROM data edits - those go through the " +
  'existing propose_* tools, not editor extensions.\n' +
  '  - When you can solve via existing MCP tools by composing them.\n\n' +
  'After calling this tool, STOP and let the user respond. Do not start ' +
  'editing source files until they confirm + dev mode is on.';

const COMPLEXITY = z.enum(['small', 'medium', 'large']);

export const proposeEditorExtensionInputShape = {
  /** One-line summary of the capability you want to add. */
  capability: z.string().min(5).max(160),
  /** Why this is needed - what user request triggered the proposal. */
  useCase: z.string().min(10).max(500),
  /** Approximate scope. small=1 file, medium=2-5 files, large=6+ files. */
  complexity: COMPLEXITY,
  /** Concrete files you expect to modify or create. Optional but
   *  strongly recommended - gives the user a preview of the diff scope. */
  plannedFiles: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Optional risk note - anything the user should consider before
   *  approving (e.g. "this changes the engine API; downstream consumers
   *  will need updates"). */
  risks: z.string().min(1).max(500).optional(),
} as const;

interface ExtensionArgs {
  capability: string;
  useCase: string;
  complexity: 'small' | 'medium' | 'large';
  plannedFiles?: string[];
  risks?: string;
}

export interface ProposeEditorExtensionResult {
  readonly proposedAtUtc: string;
  readonly capability: string;
  readonly useCase: string;
  readonly complexity: 'small' | 'medium' | 'large';
  readonly plannedFiles: ReadonlyArray<string>;
  readonly risks: string | null;
  readonly userInstruction: string;
  /** A formatted markdown block the agent can echo into its reply
   *  so the user sees the proposal in-stream. */
  readonly renderedMarkdown: string;
}

function renderMarkdown(args: ExtensionArgs): string {
  const lines: string[] = [];
  lines.push('### 🔧 Editor extension proposal');
  lines.push('');
  lines.push(`**Capability:** ${args.capability}`);
  lines.push('');
  lines.push(`**Why:** ${args.useCase}`);
  lines.push('');
  lines.push(`**Complexity:** ${args.complexity}`);
  if (args.plannedFiles && args.plannedFiles.length > 0) {
    lines.push('');
    lines.push('**Files I\'d touch:**');
    for (const f of args.plannedFiles) lines.push(`  - \`${f}\``);
  }
  if (args.risks) {
    lines.push('');
    lines.push(`**Risks:** ${args.risks}`);
  }
  lines.push('');
  lines.push(
    "**Next step:** Toggle the **DEV** pill in the AgentPanel header (top right), then send me a follow-up like \"go ahead\" or \"yes, implement it\". With dev mode on I'll edit the source, run `npm test --workspaces` + `npx tsc --noEmit` to verify, and report back with the diff for you to review via `git diff` before committing.",
  );
  return lines.join('\n');
}

export async function proposeEditorExtension(
  _ctx: ToolContext,
  args: ExtensionArgs,
): Promise<ProposeEditorExtensionResult> {
  const plannedFiles = args.plannedFiles ?? [];
  const proposal: ProposeEditorExtensionResult = {
    proposedAtUtc: new Date().toISOString(),
    capability: args.capability,
    useCase: args.useCase,
    complexity: args.complexity,
    plannedFiles: Object.freeze([...plannedFiles]),
    risks: args.risks ?? null,
    userInstruction:
      'Toggle DEV mode in the AgentPanel header, then send a follow-up to proceed. Without dev mode on, this tool produces a proposal only - no source changes are made.',
    renderedMarkdown: renderMarkdown(args),
  };
  return proposal;
}
