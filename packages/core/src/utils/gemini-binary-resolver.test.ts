/**
 * Tests for the Gemini binary resolver in binary mode.
 *
 * Must run in its own bun test invocation because it mocks @archon/paths
 * with BUNDLED_IS_BINARY=true, which conflicts with other test files.
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();

// Mock @archon/paths with BUNDLED_IS_BINARY = true (binary mode)
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: true,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

import * as resolver from './gemini-binary-resolver';

describe('resolveGeminiBinaryPath (binary mode)', () => {
  const originalEnv = process.env.GEMINI_BIN_PATH;
  let fileExistsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.GEMINI_BIN_PATH;
    fileExistsSpy?.mockRestore();
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.GEMINI_BIN_PATH = originalEnv;
    } else {
      delete process.env.GEMINI_BIN_PATH;
    }
    fileExistsSpy?.mockRestore();
  });

  test('uses GEMINI_BIN_PATH env var when set and file exists', async () => {
    process.env.GEMINI_BIN_PATH = '/usr/local/bin/gemini';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveGeminiBinaryPath();
    expect(result).toBe('/usr/local/bin/gemini');
  });

  test('throws when GEMINI_BIN_PATH is set but file does not exist', async () => {
    process.env.GEMINI_BIN_PATH = '/nonexistent/gemini';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveGeminiBinaryPath()).rejects.toThrow('does not exist');
  });

  test('uses config geminiBinaryPath when file exists', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveGeminiBinaryPath('/custom/gemini/path');
    expect(result).toBe('/custom/gemini/path');
  });

  test('throws when config geminiBinaryPath file does not exist', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveGeminiBinaryPath('/nonexistent/gemini')).rejects.toThrow(
      'does not exist'
    );
  });

  test('env var takes precedence over config path', async () => {
    process.env.GEMINI_BIN_PATH = '/env/gemini';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveGeminiBinaryPath('/config/gemini');
    expect(result).toBe('/env/gemini');
  });

  test('checks vendor directory when no env or config path', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, '/');
      return normalized.includes('vendor/gemini');
    });

    const result = await resolver.resolveGeminiBinaryPath();
    expect(typeof result).toBe('string');
    const normalized = result!.replace(/\\/g, '/');
    expect(normalized).toContain('/tmp/test-archon-home/vendor/gemini/');
  });

  test('throws with install instructions when binary not found anywhere', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveGeminiBinaryPath()).rejects.toThrow('Gemini CLI binary not found');
  });
});
