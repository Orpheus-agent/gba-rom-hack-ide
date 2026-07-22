import { spawn } from 'node:child_process';

export interface RunCommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Override the parsed argv. If absent, the command string is split on whitespace. */
  readonly argvOverride?: ReadonlyArray<string>;
}

export interface RunCommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly spawnError: string | null;
}

export function parseCommand(command: string): string[] {
  // Whitespace split. We intentionally do NOT use a shell - keeps execution
  // surface predictable and immune to shell-metachar surprises. Operators who
  // need shell features can override via argvOverride.
  return command
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function runCommand(
  command: string,
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const argv = options.argvOverride ?? parseCommand(command);
  const startedAt = Date.now();

  if (argv.length === 0) {
    return {
      command,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      durationMs: 0,
      spawnError: 'empty command',
    };
  }

  return new Promise<RunCommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;

    const argvHead = argv[0];
    if (argvHead === undefined) {
      resolve({
        command,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        durationMs: 0,
        spawnError: 'empty argv',
      });
      return;
    }
    const child = spawn(argvHead, argv.slice(1), {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.on('error', (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({
        command,
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        spawnError,
      });
    });
  });
}
