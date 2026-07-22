import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { PathEscapeError, resolveProjectPath } from './directory.js';

describe('resolveProjectPath', () => {
  const root = path.resolve('/tmp/example-project-root');

  it('returns the root itself when given the empty relative path', () => {
    expect(resolveProjectPath(root, '')).toBe(root);
  });

  it('resolves a simple relative path inside the root', () => {
    expect(resolveProjectPath(root, 'src')).toBe(path.join(root, 'src'));
    expect(resolveProjectPath(root, 'data/maps/town.json')).toBe(
      path.join(root, 'data', 'maps', 'town.json'),
    );
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(resolveProjectPath(root, 'data\\maps')).toBe(path.join(root, 'data', 'maps'));
  });

  it('rejects ".." path traversal escapes', () => {
    expect(() => resolveProjectPath(root, '..')).toThrow(PathEscapeError);
    expect(() => resolveProjectPath(root, '../..')).toThrow(PathEscapeError);
    expect(() => resolveProjectPath(root, 'src/../../escape')).toThrow(PathEscapeError);
  });

  it('rejects absolute paths supplied as the "relative" portion', () => {
    const abs = path.resolve('/tmp/other-project');
    expect(() => resolveProjectPath(root, abs)).toThrow(PathEscapeError);
  });

  it('allows paths that resolve back to within the root', () => {
    expect(resolveProjectPath(root, 'src/./.')).toBe(path.join(root, 'src'));
    expect(resolveProjectPath(root, 'src/sub/..')).toBe(path.join(root, 'src'));
  });
});
