import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentTurnEvent } from '@rom-editor/shared';
import { spawnCompat, killProcessTree } from './spawn-compat.js';

export interface RunTurnOptions {
  readonly prompt: string;
  readonly projectRoot: string;
  readonly claudeSessionId: string;
  readonly claudeBinary: string;
  readonly mcpConfigPath: string;
  readonly signal?: AbortSignal;
  /** Inject a custom spawn for tests. Defaults to node:child_process.spawn. */
  readonly spawnFn?: typeof spawn;
  /** Fires once per parsed stream-json event as it arrives. The WS route
   *  hooks here to push events live; the buffered POST route ignores it
   *  and reads the final events array from the resolved TurnResult. */
  readonly onEvent?: (event: AgentTurnEvent) => void;
  /** AI-4.1 dev mode: when true, the spawner appends a system-prompt
   *  addendum telling the agent it can use Edit/Write/Bash on the
   *  editor's own source tree (one parent up from projectRoot). The
   *  toggle is persisted on the frontend and shipped over the WS
   *  turn_start frame. Default false (safe - agents can't edit
   *  the editor's source). */
  readonly devMode?: boolean;
  /** AI-4.1: absolute path to the editor repo root (used in the
   *  dev-mode system prompt so the agent knows WHERE to edit). When
   *  omitted in dev mode, the prompt falls back to telling the agent
   *  to derive the path from `git rev-parse --show-toplevel`. */
  readonly repoRoot?: string;
  /** Session-handling mode for the `claude` CLI. The CLI accepts
   *  EITHER `--session-id <UUID>` (create-a-new-session-with-this-id)
   *  OR `--resume <UUID>` (continue-an-existing-session). Passing
   *  --session-id for a UUID that already exists fails with
   *  "Session ID <uuid> is already in use". So: first turn = create;
   *  subsequent turns = resume. The route owns the AgentSession +
   *  turnCount and flips this flag accordingly.
   *
   *  Default false (create) for backwards compatibility with existing
   *  tests that don't care which mode is used. */
  readonly isResume?: boolean;
}

const DEV_MODE_SYSTEM_PROMPT_BASE = [
  '',
  '## Dev mode enabled',
  '',
  "You are running in the ROM editor's DEVELOPER MODE. In addition to",
  'your standard MCP tools (propose_patch, propose_species_edit, etc.),',
  'you are permitted to use the built-in Edit, Write, Read, Bash, Grep,',
  'and Glob tools on the EDITOR\'S OWN SOURCE TREE - not just the open',
  'ROM project. This unblocks the self-extending workflow: when a',
  'user request needs a capability that no MCP tool yet exposes, you',
  'can read the engine + backend + frontend source, draft new code,',
  'add tests, and verify by running `npm test --workspaces` and',
  '`npx tsc --noEmit`.',
  '',
  'Conventions for editor-source edits:',
  '  - NEVER commit. Stage changes only. The user reviews via `git',
  '    diff` and commits manually.',
  '  - ALWAYS run `npm test --workspaces` + `npx tsc --noEmit` before',
  '    reporting that an editor extension is complete. If either fails,',
  '    iterate. Do not declare done with a red test or a typecheck error.',
  '  - Match the existing code style + patterns. The engine uses pure',
  '    functions + structural detection (no baked offsets); the backend',
  '    uses Fastify routes + manifest lifters; the frontend uses Zustand',
  '    + React + PixiJS.',
  '  - When unsure where editor source lives, run `git rev-parse',
  '    --show-toplevel` from any subdirectory.',
  '',
  'The MCP tool `propose_editor_extension` lets you formally surface a',
  'capability gap to the user without unilaterally making the change.',
  'Use it when you want sign-off BEFORE diving into a multi-file edit.',
].join('\n');

function buildDevModeSystemPrompt(repoRoot?: string): string {
  if (repoRoot) {
    return `${DEV_MODE_SYSTEM_PROMPT_BASE}\n\nEditor source tree: \`${repoRoot}\`\n`;
  }
  return DEV_MODE_SYSTEM_PROMPT_BASE;
}

export interface TurnResult {
  readonly events: ReadonlyArray<AgentTurnEvent>;
  readonly finalText: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stderr: string;
}

export type TurnErrorCode =
  | 'spawn_failed'
  | 'nonzero_exit'
  | 'aborted'
  /** Claude CLI exited because the user hasn't authenticated (or the
   *  cached token expired). The frontend renders a "Run `claude /login`
   *  in a terminal" banner instead of a generic "claude exited with
   *  code N". Detected by matching the stderr pattern. */
  | 'not_logged_in'
  /** Claude CLI exited because the supplied --session-id is already
   *  in use (typically from a prior crashed turn that left the lock
   *  in place). The frontend offers a "Reset session" button that
   *  calls /reset-session to mint a fresh UUID. */
  | 'session_in_use';

/** Heuristic stderr matchers that promote a generic 'nonzero_exit' to
 *  one of the more-specific error codes above. Each entry: (regex,
 *  promoted code, human-friendly message). The matcher list is ordered
 * - first match wins - so put the most-specific patterns first. */
const STDERR_PROMOTIONS: ReadonlyArray<{
  re: RegExp;
  code: TurnErrorCode;
  message: string;
}> = [
  {
    re: /Not logged in.*Please run \/login/i,
    code: 'not_logged_in',
    message:
      "Claude CLI isn't authenticated. Open a terminal and run `claude /login` once - the auth token is shared across all `claude` invocations, so the AgentPanel will work after that.",
  },
  {
    re: /Session ID .* is already in use/i,
    code: 'session_in_use',
    message:
      'The agent session id is locked by another (probably stale) claude process. Click "Reset agent session" to mint a fresh id.',
  },
];

/** Inspect stderr for known patterns + return a refined TurnError, or
 *  null if nothing matched (caller falls back to the generic nonzero
 *  exit error). Exposed for direct testing. */
export function classifyClaudeStderr(stderr: string): TurnError | null {
  for (const { re, code, message } of STDERR_PROMOTIONS) {
    if (re.test(stderr)) {
      return new TurnError(code, message, stderr);
    }
  }
  return null;
}

export class TurnError extends Error {
  constructor(
    public readonly code: TurnErrorCode,
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'TurnError';
  }
}

/**
 * Spawn `claude` for one turn:
 *   - cwd is the project root (so claude's own Edit/Bash/Read tools
 *     land in the right place).
 *   - --session-id reuses the per-project AgentSession id, so multiple
 *     turns chain into one conversation.
 *   - --mcp-config registers our rom-editor MCP server (binary +
 *     ROM_EDITOR_PROJECT_ROOT env).
 *   - --output-format stream-json emits one JSON event per line on
 *     stdout; we NDJSON-parse and surface them as AgentTurnEvent.
 *   - --input-format stream-json + writing one user-message envelope
 *     to stdin lets us pass the prompt without shell quoting risk.
 */
export async function runAgentTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const startedAt = Date.now();
  const events: AgentTurnEvent[] = [];
  let stderr = '';
  let finalText = '';

  // First turn for this session id: --session-id creates the session.
  // Subsequent turns: --resume reuses it. Passing --session-id twice
  // for the same UUID fails with "Session ID <uuid> is already in use".
  const sessionFlag = opts.isResume === true ? '--resume' : '--session-id';
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    sessionFlag, opts.claudeSessionId,
    '--mcp-config', opts.mcpConfigPath,
    '--verbose',
  ];

  // Allow-list our MCP tools so they don't auto-deny in print mode.
  // Without this, every propose_patch / propose_species_edit / etc.
  // call in the agent surfaces as "tool denied" - the whole point of
  // the editor's AI pipe breaks. Wildcard matches the rom-editor MCP
  // server's full namespace (see mcp-config.ts: server name 'rom-editor'
  // → tool names like mcp__rom-editor__propose_patch).
  //
  // In dev mode we ALSO allow Edit/Write/Read/Bash/Grep/Glob so the
  // agent can edit + test the editor's source tree, AND we add the
  // repo root to --add-dir so those file ops aren't sandbox-blocked,
  // AND we use --permission-mode acceptEdits so file edits don't
  // prompt the user. The dev mode toggle is opt-in via the UI; user
  // knows they're widening the surface area when they flip it.
  const allowedTools = ['mcp__rom-editor__*'];
  if (opts.devMode === true) {
    allowedTools.push('Edit', 'Write', 'Read', 'Bash', 'Grep', 'Glob');
    if (opts.repoRoot) {
      args.push('--add-dir', opts.repoRoot);
    }
    args.push('--permission-mode', 'acceptEdits');
  }
  // Per the docs the values are space-separated argv slots after the
  // --allowedTools flag (matches `claude --allowedTools "Read" "Edit"`).
  args.push('--allowedTools', ...allowedTools);

  // INTENTIONALLY no --append-system-prompt CLI arg. Dev-mode guidance
  // is injected via stdin (the user message) - see buildPromptText
  // below. Why not the CLI flag? When the claude binary is a Windows
  // .cmd shim, spawn() needs shell:true (or EINVAL - see spawn-compat.ts).
  // shell:true passes args UNQUOTED to cmd.exe, which splits on
  // newlines → the multi-line dev-mode prompt gets shattered and
  // claude exits with "option '--append-system-prompt <prompt>'
  // argument missing". Stdin JSON-stringifies the prompt so newlines
  // become \n literals in the JSON string and survive the round-trip.

  return new Promise<TurnResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      // Use spawnCompat instead of node:child_process.spawn so the
      // npm-global `claude.cmd` shim on Windows doesn't blow up with
      // EINVAL - see spawn-compat.ts for the rationale. Tests can
      // still inject opts.spawnFn for full mockability.
      child = (opts.spawnFn ?? spawnCompat)(opts.claudeBinary, args, {
        cwd: opts.projectRoot,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      return reject(
        new TurnError(
          'spawn_failed',
          `Failed to spawn claude: ${(err as Error).message}`,
        ),
      );
    }

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      // Kill the entire process tree, not just the immediate child.
      // When spawn-compat routed through shell:true for a .cmd shim,
      // `child` is cmd.exe; the underlying claude.exe survives a
      // plain child.kill() and keeps running as an orphan → the
      // AgentPanel Stop button "doesn't work". taskkill /F /T on
      // Windows recurses to descendants.
      void killProcessTree(child);
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        void killProcessTree(child);
        return reject(new TurnError('aborted', 'Aborted before spawn completed'));
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Non-JSON noise on stdout - surface as raw so the frontend
          // can still inspect it, but don't crash the parser.
          const rawEvent: AgentTurnEvent = { type: 'raw_text', data: { line } };
          events.push(rawEvent);
          if (opts.onEvent) {
            try {
              opts.onEvent(rawEvent);
            } catch {
              /* see comment below */
            }
          }
          continue;
        }
        const t = typeof parsed.type === 'string' ? parsed.type : 'unknown';
        const event: AgentTurnEvent = { type: t, data: parsed };
        events.push(event);
        if (opts.onEvent) {
          try {
            opts.onEvent(event);
          } catch {
            // A subscriber crashing must not derail the spawn lifecycle.
          }
        }
        if (t === 'result' && typeof parsed.result === 'string') {
          finalText = parsed.result;
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(
        new TurnError(
          'spawn_failed',
          `Failed to spawn claude: ${err.message}`,
          stderr,
        ),
      );
    });

    child.on('exit', (code, signal) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - startedAt;
      if (aborted || signal === 'SIGTERM' || signal === 'SIGKILL') {
        return reject(new TurnError('aborted', 'claude subprocess killed', stderr));
      }
      if (code !== 0) {
        // Try to promote the generic nonzero_exit to a more-specific
        // error code (not_logged_in, session_in_use) based on stderr
        // contents. The frontend renders these with actionable copy.
        const promoted = classifyClaudeStderr(stderr);
        return reject(
          promoted ??
            new TurnError('nonzero_exit', `claude exited with code ${code}`, stderr),
        );
      }
      resolve({ events, finalText, exitCode: code ?? 0, durationMs, stderr });
    });

    // Build the prompt text. If dev mode is on AND this is the FIRST
    // turn (session creation), prepend the dev-mode guidance - the
    // agent will see it as part of the conversation history on every
    // subsequent --resume turn without us having to re-inject it.
    //
    // Why not just always inject? It would bloat every --resume turn's
    // context with re-stated guidance that's already in the transcript.
    // Why not the --append-system-prompt CLI flag? See the
    // "INTENTIONALLY no --append-system-prompt" comment above.
    const promptText =
      opts.devMode === true && opts.isResume !== true
        ? [
            '<<DEV_MODE_GUIDANCE>>',
            buildDevModeSystemPrompt(opts.repoRoot),
            '<<END_DEV_MODE_GUIDANCE>>',
            '',
            'User request:',
            opts.prompt,
          ].join('\n')
        : opts.prompt;
    const userMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: promptText }],
      },
    };
    child.stdin.write(`${JSON.stringify(userMessage)}\n`);
    child.stdin.end();
  });
}
