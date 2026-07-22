import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface McpConfigOptions {
  readonly projectRoot: string;
  readonly mcpServerCommand: string;
  readonly mcpServerArgs: ReadonlyArray<string>;
  /** Optional base URL the spawned MCP server can use to POST back to
   *  Fastify (propose_patch, etc.). Forwarded as ROM_EDITOR_BASE_URL. */
  readonly baseUrl?: string;
}

export interface McpConfigHandle {
  readonly path: string;
  cleanup(): Promise<void>;
}

/**
 * Stage a temp `--mcp-config` JSON file describing how `claude`
 * should spawn our rom-editor MCP server. ROM_EDITOR_PROJECT_ROOT is
 * passed in `env` so the spawned MCP server knows which project's
 * manifest to read.
 */
export async function writeTempMcpConfig(opts: McpConfigOptions): Promise<McpConfigHandle> {
  const configPath = path.join(tmpdir(), `rom-editor-mcp-${randomUUID()}.json`);
  const env: Record<string, string> = { ROM_EDITOR_PROJECT_ROOT: opts.projectRoot };
  if (opts.baseUrl) env.ROM_EDITOR_BASE_URL = opts.baseUrl;
  const body = {
    mcpServers: {
      'rom-editor': {
        type: 'stdio',
        command: opts.mcpServerCommand,
        args: [...opts.mcpServerArgs],
        env,
      },
    },
  };
  await fsp.writeFile(configPath, JSON.stringify(body, null, 2), 'utf8');
  return {
    path: configPath,
    cleanup: async () => {
      try {
        await fsp.unlink(configPath);
      } catch {
        // best-effort: leave a stale tmp file rather than crash
      }
    },
  };
}
