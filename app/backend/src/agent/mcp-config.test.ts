import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import { writeTempMcpConfig } from './mcp-config.js';

describe('writeTempMcpConfig', () => {
  it('writes a valid mcp-config JSON pointing at our server with the projectRoot env', async () => {
    const handle = await writeTempMcpConfig({
      projectRoot: 'C:\\path\\to\\projects\\pokefirered',
      mcpServerCommand: 'node',
      mcpServerArgs: ['/abs/path/to/dist/agent/mcp-server.js'],
    });
    try {
      const body = JSON.parse(await fsp.readFile(handle.path, 'utf8')) as Record<string, unknown>;
      const servers = body.mcpServers as Record<string, Record<string, unknown>>;
      const entry = servers['rom-editor'];
      expect(entry?.type).toBe('stdio');
      expect(entry?.command).toBe('node');
      expect(entry?.args).toEqual(['/abs/path/to/dist/agent/mcp-server.js']);
      const env = entry?.env as Record<string, string>;
      expect(env.ROM_EDITOR_PROJECT_ROOT).toBe('C:\\path\\to\\projects\\pokefirered');
    } finally {
      await handle.cleanup();
    }
  });

  it('cleanup removes the tmp file', async () => {
    const handle = await writeTempMcpConfig({
      projectRoot: '/tmp/proj',
      mcpServerCommand: 'node',
      mcpServerArgs: ['x.js'],
    });
    await fsp.access(handle.path);
    await handle.cleanup();
    await expect(fsp.access(handle.path)).rejects.toBeTruthy();
  });
});
