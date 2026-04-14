/**
 * Tests for the Gemini binary resolver in dev mode.
 *
 * Must run in its own bun test invocation because it mocks @archon/paths
 * with BUNDLED_IS_BINARY=false.
 */
import { describe, test, expect, mock, spyOn, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();

// Mock @archon/paths with BUNDLED_IS_BINARY = false (dev mode)
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

import { resolveGeminiBinaryPath } from './binary-resolver';

describe('resolveGeminiBinaryPath (dev mode)', () => {
  beforeEach(() => {
    delete process.env.GEMINI_BIN_PATH;
  });

  test('returns undefined when BUNDLED_IS_BINARY is false', async () => {
    process.env.GEMINI_BIN_PATH = '/some/path/to/gemini';
    const result = await resolveGeminiBinaryPath();
    expect(result).toBeUndefined();
  });

  test('returns undefined even with config path set', async () => {
    const result = await resolveGeminiBinaryPath('/config/path/gemini');
    expect(result).toBeUndefined();
  });
});
