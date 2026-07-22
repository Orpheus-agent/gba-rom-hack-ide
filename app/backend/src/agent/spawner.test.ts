import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn as RealSpawn } from 'node:child_process';
import { runAgentTurn, TurnError, classifyClaudeStderr } from './spawner.js';

/** Build a fake child process that emits scripted stream-json lines on
 *  stdout, captures stdin, and emits an exit with the given code. */
function fakeSpawn(opts: {
  stdoutLines?: ReadonlyArray<string>;
  stderr?: string;
  exitCode?: number;
  exitSignal?: NodeJS.Signals;
  delayMs?: number;
  spawnThrows?: Error;
  onStdin?: (chunk: string) => void;
}): typeof RealSpawn {
  return ((..._args: unknown[]) => {
    if (opts.spawnThrows) throw opts.spawnThrows;
    const emitter = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals | number) => boolean;
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    emitter.stdin = stdin;
    emitter.stdout = stdout;
    emitter.stderr = stderr;
    let killed = false;
    emitter.kill = (signal?: NodeJS.Signals | number) => {
      killed = true;
      setImmediate(() => emitter.emit('exit', null, signal ?? 'SIGTERM'));
      return true;
    };

    if (opts.onStdin) {
      stdin.on('data', (b: Buffer) => opts.onStdin!(b.toString('utf8')));
    }

    setTimeout(() => {
      if (killed) return;
      for (const line of opts.stdoutLines ?? []) {
        stdout.write(`${line}\n`);
      }
      stdout.end();
      if (opts.stderr) {
        stderr.write(opts.stderr);
        stderr.end();
      } else {
        stderr.end();
      }
      setImmediate(() => {
        if (killed) return;
        emitter.emit('exit', opts.exitCode ?? 0, opts.exitSignal ?? null);
      });
    }, opts.delayMs ?? 1);

    return emitter as unknown as ReturnType<typeof RealSpawn>;
  }) as unknown as typeof RealSpawn;
}

describe('runAgentTurn', () => {
  it('parses NDJSON stream-json events and extracts finalText from the result event', async () => {
    let stdinCapture = '';
    const turn = await runAgentTurn({
      prompt: 'list trainers in cerulean',
      projectRoot: '/x',
      claudeSessionId: 'sess-1',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      spawnFn: fakeSpawn({
        onStdin: (c) => { stdinCapture += c; },
        stdoutLines: [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking up trainers…' }] } }),
          JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'Misty + 4 trainers in her gym.', duration_ms: 123 }),
        ],
        exitCode: 0,
      }),
    });
    expect(turn.events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
    expect(turn.finalText).toBe('Misty + 4 trainers in her gym.');
    expect(turn.exitCode).toBe(0);
    expect(stdinCapture).toContain('list trainers in cerulean');
  });

  it('survives non-JSON noise on stdout (surfaces it as raw_text)', async () => {
    const turn = await runAgentTurn({
      prompt: 'hi',
      projectRoot: '/x',
      claudeSessionId: 'sess',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      spawnFn: fakeSpawn({
        stdoutLines: [
          'WARNING: deprecated flag',
          JSON.stringify({ type: 'result', result: 'ok' }),
        ],
        exitCode: 0,
      }),
    });
    expect(turn.events[0]?.type).toBe('raw_text');
    expect(turn.events[1]?.type).toBe('result');
    expect(turn.finalText).toBe('ok');
  });

  it('rejects with TurnError(spawn_failed) when spawn throws synchronously', async () => {
    await expect(
      runAgentTurn({
        prompt: 'hi',
        projectRoot: '/x',
        claudeSessionId: 'sess',
        claudeBinary: '/fake/claude',
        mcpConfigPath: '/tmp/mcp.json',
        spawnFn: fakeSpawn({ spawnThrows: new Error('ENOENT') }),
      }),
    ).rejects.toBeInstanceOf(TurnError);
  });

  it('rejects with TurnError(nonzero_exit) when the child exits non-zero', async () => {
    let captured: TurnError | undefined;
    try {
      await runAgentTurn({
        prompt: 'hi',
        projectRoot: '/x',
        claudeSessionId: 'sess',
        claudeBinary: '/fake/claude',
        mcpConfigPath: '/tmp/mcp.json',
        spawnFn: fakeSpawn({ exitCode: 2, stderr: 'mcp config not found\n' }),
      });
    } catch (e) {
      captured = e as TurnError;
    }
    expect(captured).toBeInstanceOf(TurnError);
    expect(captured?.code).toBe('nonzero_exit');
    expect(captured?.stderr).toContain('mcp config not found');
  });

  it('fires onEvent once per parsed event, in order, before resolving', async () => {
    const observed: string[] = [];
    const turn = await runAgentTurn({
      prompt: 'hi',
      projectRoot: '/x',
      claudeSessionId: 'sess',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      onEvent: (e) => observed.push(e.type),
      spawnFn: fakeSpawn({
        stdoutLines: [
          JSON.stringify({ type: 'system', subtype: 'init' }),
          'WARNING noise',
          JSON.stringify({ type: 'assistant', message: { content: [] } }),
          JSON.stringify({ type: 'result', result: 'done' }),
        ],
        exitCode: 0,
      }),
    });
    expect(observed).toEqual(['system', 'raw_text', 'assistant', 'result']);
    expect(turn.events.map((e) => e.type)).toEqual(observed);
  });

  it('does not derail when onEvent throws', async () => {
    const turn = await runAgentTurn({
      prompt: 'hi',
      projectRoot: '/x',
      claudeSessionId: 'sess',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      onEvent: () => { throw new Error('subscriber broken'); },
      spawnFn: fakeSpawn({
        stdoutLines: [
          JSON.stringify({ type: 'result', result: 'ok' }),
        ],
        exitCode: 0,
      }),
    });
    expect(turn.finalText).toBe('ok');
  });

  it('rejects with TurnError(aborted) when the AbortSignal fires', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    let captured: TurnError | undefined;
    try {
      await runAgentTurn({
        prompt: 'hi',
        projectRoot: '/x',
        claudeSessionId: 'sess',
        claudeBinary: '/fake/claude',
        mcpConfigPath: '/tmp/mcp.json',
        signal: controller.signal,
        spawnFn: fakeSpawn({
          delayMs: 200,
          stdoutLines: [JSON.stringify({ type: 'result', result: 'never' })],
          exitCode: 0,
        }),
      });
    } catch (e) {
      captured = e as TurnError;
    }
    expect(captured).toBeInstanceOf(TurnError);
    expect(captured?.code).toBe('aborted');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2026-05-26 bug fixes - typed error promotion from stderr +
// --session-id vs --resume flag selection.
// ──────────────────────────────────────────────────────────────────────

describe('classifyClaudeStderr', () => {
  it('promotes "Not logged in" stderr to not_logged_in with actionable copy', () => {
    const got = classifyClaudeStderr('Not logged in · Please run /login\n');
    expect(got).toBeInstanceOf(TurnError);
    expect(got?.code).toBe('not_logged_in');
    expect(got?.message).toMatch(/claude \/login/);
  });

  it('promotes "Session ID already in use" stderr to session_in_use', () => {
    const got = classifyClaudeStderr(
      'Error: Session ID 1119b4c1-f0da-4090-91a3-cc79bf05563a is already in use.\n',
    );
    expect(got).toBeInstanceOf(TurnError);
    expect(got?.code).toBe('session_in_use');
    expect(got?.message).toMatch(/Reset agent session/);
  });

  it('returns null for unmatched stderr (caller keeps the generic nonzero_exit)', () => {
    expect(classifyClaudeStderr('')).toBeNull();
    expect(classifyClaudeStderr('Some other random error\n')).toBeNull();
    expect(classifyClaudeStderr('Connection timeout\n')).toBeNull();
  });

  it('is case-insensitive on the match patterns', () => {
    expect(classifyClaudeStderr('NOT LOGGED IN · please run /LOGIN\n')?.code).toBe('not_logged_in');
    expect(classifyClaudeStderr('SESSION ID abc IS ALREADY IN USE\n')?.code).toBe('session_in_use');
  });
});

describe('runAgentTurn - auth + session error promotion', () => {
  it('a nonzero exit with "Not logged in" stderr surfaces as not_logged_in (not nonzero_exit)', async () => {
    let captured: TurnError | undefined;
    try {
      await runAgentTurn({
        prompt: 'hi',
        projectRoot: '/x',
        claudeSessionId: 'sess-1',
        claudeBinary: '/fake/claude',
        mcpConfigPath: '/tmp/mcp.json',
        spawnFn: fakeSpawn({
          stderr: 'Not logged in · Please run /login\n',
          exitCode: 1,
        }),
      });
    } catch (e) {
      captured = e as TurnError;
    }
    expect(captured?.code).toBe('not_logged_in');
    expect(captured?.message).toMatch(/claude \/login/);
    expect(captured?.stderr).toMatch(/Not logged in/);
  });

  it('a nonzero exit with "Session ID is already in use" stderr surfaces as session_in_use', async () => {
    let captured: TurnError | undefined;
    try {
      await runAgentTurn({
        prompt: 'hi',
        projectRoot: '/x',
        claudeSessionId: 'sess-1',
        claudeBinary: '/fake/claude',
        mcpConfigPath: '/tmp/mcp.json',
        spawnFn: fakeSpawn({
          stderr: 'Error: Session ID 1119b4c1-f0da-4090-91a3-cc79bf05563a is already in use.\n',
          exitCode: 1,
        }),
      });
    } catch (e) {
      captured = e as TurnError;
    }
    expect(captured?.code).toBe('session_in_use');
  });

  it('an unmatched stderr still surfaces as the generic nonzero_exit', async () => {
    let captured: TurnError | undefined;
    try {
      await runAgentTurn({
        prompt: 'hi',
        projectRoot: '/x',
        claudeSessionId: 'sess-1',
        claudeBinary: '/fake/claude',
        mcpConfigPath: '/tmp/mcp.json',
        spawnFn: fakeSpawn({
          stderr: 'Network error: connection refused\n',
          exitCode: 1,
        }),
      });
    } catch (e) {
      captured = e as TurnError;
    }
    expect(captured?.code).toBe('nonzero_exit');
  });
});

describe('runAgentTurn - --session-id vs --resume flag', () => {
  /** Capture the args that the spawn function was called with, so we
   *  can assert which session flag landed in argv. */
  function captureArgs(): { fn: typeof RealSpawn; calls: Array<{ command: string; args: ReadonlyArray<string> }> } {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const fn = ((command: string, args: ReadonlyArray<string>) => {
      calls.push({ command, args });
      // Return a child that immediately exits cleanly (we only care about argv).
      return fakeSpawn({ exitCode: 0 })(command, args);
    }) as unknown as typeof RealSpawn;
    return { fn, calls };
  }

  it('first turn (isResume omitted/false) passes --session-id <uuid>', async () => {
    const cap = captureArgs();
    await runAgentTurn({
      prompt: 'hi',
      projectRoot: '/x',
      claudeSessionId: 'abc-uuid',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      spawnFn: cap.fn,
    });
    expect(cap.calls).toHaveLength(1);
    const { args } = cap.calls[0]!;
    expect(args).toContain('--session-id');
    expect(args).not.toContain('--resume');
    // The argument immediately after --session-id is the UUID.
    const idx = args.indexOf('--session-id');
    expect(args[idx + 1]).toBe('abc-uuid');
  });

  it('subsequent turn (isResume=true) passes --resume <uuid> instead', async () => {
    const cap = captureArgs();
    await runAgentTurn({
      prompt: 'hi',
      projectRoot: '/x',
      claudeSessionId: 'abc-uuid',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      isResume: true,
      spawnFn: cap.fn,
    });
    const { args } = cap.calls[0]!;
    expect(args).toContain('--resume');
    expect(args).not.toContain('--session-id');
    const idx = args.indexOf('--resume');
    expect(args[idx + 1]).toBe('abc-uuid');
  });

  it('isResume=false explicitly is equivalent to omitting the flag (creates)', async () => {
    const cap = captureArgs();
    await runAgentTurn({
      prompt: 'hi',
      projectRoot: '/x',
      claudeSessionId: 'abc-uuid',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      isResume: false,
      spawnFn: cap.fn,
    });
    expect(cap.calls[0]!.args).toContain('--session-id');
    expect(cap.calls[0]!.args).not.toContain('--resume');
  });
});

describe('runAgentTurn - dev mode prompt injection (via stdin, NOT --append-system-prompt)', () => {
  /** Helper: capture both args AND the stdin bytes written to the
   *  fake child, so we can assert (a) NO --append-system-prompt CLI
   *  arg ever leaves the spawner (which would shatter on Windows
   *  shell:true), (b) the dev-mode guidance is embedded in the user
   *  message text instead. */
  function captureAll(): {
    fn: typeof RealSpawn;
    calls: Array<{ command: string; args: ReadonlyArray<string>; stdin: string }>;
  } {
    const calls: Array<{ command: string; args: ReadonlyArray<string>; stdin: string }> = [];
    const fn = ((command: string, args: ReadonlyArray<string>) => {
      const entry = { command, args, stdin: '' };
      calls.push(entry);
      return fakeSpawn({
        exitCode: 0,
        onStdin: (chunk) => {
          entry.stdin += chunk;
        },
      })(command, args);
    }) as unknown as typeof RealSpawn;
    return { fn, calls };
  }

  it('NEVER passes --append-system-prompt as a CLI arg, even when devMode is true', async () => {
    // This is the regression test for the user-reported bug:
    //   error: option '--append-system-prompt <prompt>' argument missing
    // Cause: shell:true on Windows passes args unquoted to cmd.exe,
    // which splits on newlines, leaving the flag without its value.
    // Fix: don't use the CLI flag at all; inject via stdin instead.
    const cap = captureAll();
    await runAgentTurn({
      prompt: 'add a npc that sells rare candies',
      projectRoot: '/x',
      claudeSessionId: 'abc',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      devMode: true,
      repoRoot: '/abs/editor-repo',
      spawnFn: cap.fn,
    });
    expect(cap.calls[0]!.args).not.toContain('--append-system-prompt');
  });

  it('devMode=true + first turn (not resume) injects dev guidance into the stdin user message', async () => {
    const cap = captureAll();
    await runAgentTurn({
      prompt: 'how do I add a flag?',
      projectRoot: '/x',
      claudeSessionId: 'abc',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      devMode: true,
      isResume: false,
      spawnFn: cap.fn,
    });
    const stdin = cap.calls[0]!.stdin;
    const userMsg = JSON.parse(stdin.trim()) as {
      type: string;
      message: { content: Array<{ text: string }> };
    };
    expect(userMsg.type).toBe('user');
    const text = userMsg.message.content[0]!.text;
    expect(text).toContain('<<DEV_MODE_GUIDANCE>>');
    expect(text).toContain('Dev mode enabled');
    expect(text).toContain('User request:');
    expect(text).toContain('how do I add a flag?');
  });

  it('devMode=true + isResume=true does NOT re-inject guidance (it is already in transcript)', async () => {
    const cap = captureAll();
    await runAgentTurn({
      prompt: 'follow up question',
      projectRoot: '/x',
      claudeSessionId: 'abc',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      devMode: true,
      isResume: true,
      spawnFn: cap.fn,
    });
    const stdin = cap.calls[0]!.stdin;
    const userMsg = JSON.parse(stdin.trim()) as {
      message: { content: Array<{ text: string }> };
    };
    const text = userMsg.message.content[0]!.text;
    expect(text).toBe('follow up question');
    expect(text).not.toContain('<<DEV_MODE_GUIDANCE>>');
    expect(text).not.toContain('Dev mode enabled');
  });

  it('devMode=false (default) just passes the prompt as-is, no guidance prefix', async () => {
    const cap = captureAll();
    await runAgentTurn({
      prompt: 'plain prompt',
      projectRoot: '/x',
      claudeSessionId: 'abc',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      spawnFn: cap.fn,
    });
    const stdin = cap.calls[0]!.stdin;
    const userMsg = JSON.parse(stdin.trim()) as {
      message: { content: Array<{ text: string }> };
    };
    expect(userMsg.message.content[0]!.text).toBe('plain prompt');
  });

  it('the injected dev guidance survives JSON-serialization (newlines escape as \\n)', async () => {
    const cap = captureAll();
    await runAgentTurn({
      prompt: 'q',
      projectRoot: '/x',
      claudeSessionId: 'abc',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      devMode: true,
      spawnFn: cap.fn,
    });
    const stdin = cap.calls[0]!.stdin;
    // The raw NDJSON stdin payload should have no LITERAL newlines
    // inside its JSON body (only the trailing \n terminator). All
    // dev-mode prompt newlines should be escaped as \\n.
    // (The terminator is a single \n at the end.)
    const beforeTerminator = stdin.slice(0, stdin.lastIndexOf('\n'));
    expect(beforeTerminator).not.toMatch(/[\n]/);
    // ... but the unescaped string SHOULD have newlines after parsing.
    const userMsg = JSON.parse(stdin.trim()) as {
      message: { content: Array<{ text: string }> };
    };
    expect(userMsg.message.content[0]!.text).toContain('\n');
  });
});

describe('runAgentTurn - tool allowlist + permission mode + add-dir', () => {
  /** Reuse the args-capturing fake spawn. */
  function captureArgs(): {
    fn: typeof RealSpawn;
    calls: Array<{ command: string; args: ReadonlyArray<string> }>;
  } {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const fn = ((command: string, args: ReadonlyArray<string>) => {
      calls.push({ command, args });
      return fakeSpawn({ exitCode: 0 })(command, args);
    }) as unknown as typeof RealSpawn;
    return { fn, calls };
  }

  it('always allowlists mcp__rom-editor__* so MCP tools never auto-deny', async () => {
    // Regression for "MCP tools auto-deny" report. Without --allowedTools
    // in deny-by-default print mode, every propose_patch / list_entities
    // / etc. call would surface as a tool denial and the agent flow
    // breaks. The wildcard pattern matches our entire MCP namespace.
    const cap = captureArgs();
    await runAgentTurn({
      prompt: 'list maps',
      projectRoot: '/x',
      claudeSessionId: 'abc',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      spawnFn: cap.fn,
    });
    const { args } = cap.calls[0]!;
    const idx = args.indexOf('--allowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    // The first value after --allowedTools should be our MCP wildcard.
    expect(args[idx + 1]).toBe('mcp__rom-editor__*');
  });

  it('non-dev mode allowlists ONLY the MCP wildcard (Edit/Bash/etc. still gated)', async () => {
    const cap = captureArgs();
    await runAgentTurn({
      prompt: 'q',
      projectRoot: '/x',
      claudeSessionId: 'abc',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      spawnFn: cap.fn,
    });
    const { args } = cap.calls[0]!;
    // Non-dev mode: no Edit/Write/Bash in the allowlist.
    expect(args).not.toContain('Edit');
    expect(args).not.toContain('Write');
    expect(args).not.toContain('Bash');
    // Non-dev mode: no --add-dir.
    expect(args).not.toContain('--add-dir');
    // Non-dev mode: no --permission-mode override.
    expect(args).not.toContain('--permission-mode');
  });

  it('dev mode expands allowlist + adds --add-dir <repoRoot> + sets acceptEdits', async () => {
    const cap = captureArgs();
    await runAgentTurn({
      prompt: 'q',
      projectRoot: '/x',
      claudeSessionId: 'abc',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      devMode: true,
      repoRoot: '/abs/editor-repo',
      spawnFn: cap.fn,
    });
    const { args } = cap.calls[0]!;
    // --add-dir <repoRoot> for editor source access.
    const addDirIdx = args.indexOf('--add-dir');
    expect(addDirIdx).toBeGreaterThanOrEqual(0);
    expect(args[addDirIdx + 1]).toBe('/abs/editor-repo');
    // --permission-mode acceptEdits so file edits don't prompt.
    const modeIdx = args.indexOf('--permission-mode');
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(args[modeIdx + 1]).toBe('acceptEdits');
    // Allowlist includes both the MCP wildcard AND the dev tools.
    const allowIdx = args.indexOf('--allowedTools');
    const allowed = args.slice(allowIdx + 1);
    // Find where the allowlist ends (next flag starts with --).
    const allowEnd = allowed.findIndex((a) => a.startsWith('--'));
    const allowedSlice = allowEnd === -1 ? allowed : allowed.slice(0, allowEnd);
    expect(allowedSlice).toContain('mcp__rom-editor__*');
    expect(allowedSlice).toContain('Edit');
    expect(allowedSlice).toContain('Write');
    expect(allowedSlice).toContain('Read');
    expect(allowedSlice).toContain('Bash');
    expect(allowedSlice).toContain('Grep');
    expect(allowedSlice).toContain('Glob');
  });

  it('dev mode without repoRoot still works - just omits --add-dir', async () => {
    const cap = captureArgs();
    await runAgentTurn({
      prompt: 'q',
      projectRoot: '/x',
      claudeSessionId: 'abc',
      claudeBinary: '/fake/claude',
      mcpConfigPath: '/tmp/mcp.json',
      devMode: true,
      spawnFn: cap.fn,
    });
    const { args } = cap.calls[0]!;
    expect(args).not.toContain('--add-dir');
    // But the permission-mode + expanded allowlist are still set.
    expect(args).toContain('--permission-mode');
    expect(args).toContain('Edit');
  });
});
