import { describe, expect, test, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import { EventEmitter } from 'events';

// Mock child_process.spawn
const mockSpawnController = {
  killed: false,
  kill: mock(() => {
    mockSpawnController.killed = true;
  }),
  stdout: new EventEmitter(),
  stderr: new EventEmitter(),
  on: mock(),
  exitCode: null as number | null,
  signalCode: null as string | null,
};

mock.module('child_process', () => ({
  spawn: mock(() => mockSpawnController),
}));

// Mock readline
let mockLines: string[] | (() => AsyncGenerator<string>) = [];
mock.module('readline', () => ({
  createInterface: mock(() => {
    if (typeof mockLines === 'function') {
      return mockLines();
    }
    return (async function* () {
      // @ts-expect-error it is an array here
      for (const line of mockLines) {
        yield line;
      }
    })();
  }),
}));

import { GeminiProvider } from './provider';

describe('GeminiProvider', () => {
  beforeEach(() => {
    mockSpawnController.killed = false;
    mockSpawnController.exitCode = 0;
    mockSpawnController.signalCode = null;
    mockSpawnController.kill.mockClear();
    mockSpawnController.on.mockClear();
    mockLines = [];
  });

  test('getType returns gemini', () => {
    const client = new GeminiProvider();
    expect(client.getType()).toBe('gemini');
  });

  test('streams assistant chunks successfully', async () => {
    const client = new GeminiProvider({ retryBaseDelayMs: 1 });

    mockLines = [
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: ' World' }),
      JSON.stringify({
        type: 'result',
        stats: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    ];

    const chunks = [];
    for await (const chunk of client.sendQuery('Hi', '/test/cwd')) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello' });
    expect(chunks[1]).toEqual({ type: 'assistant', content: ' World' });
    expect(chunks[2].type).toBe('result');
    expect((chunks[2] as any).tokens).toEqual({ input: 10, output: 5, total: 15 });
  });

  test('streams tool chunks successfully', async () => {
    const client = new GeminiProvider({ retryBaseDelayMs: 1 });

    mockLines = [
      JSON.stringify({
        type: 'tool_use',
        tool_name: 'test_tool',
        parameters: { foo: 'bar' },
        tool_id: '123',
      }),
      JSON.stringify({
        type: 'tool_result',
        tool_name: 'test_tool',
        output: 'success',
        tool_id: '123',
      }),
      JSON.stringify({
        type: 'result',
        stats: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    ];

    const chunks = [];
    for await (const chunk of client.sendQuery('Hi', '/test/cwd')) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({
      type: 'tool',
      toolName: 'test_tool',
      toolInput: { foo: 'bar' },
      toolCallId: '123',
    });
    expect(chunks[1]).toEqual({
      type: 'tool_result',
      toolName: 'test_tool',
      toolOutput: 'success',
      toolCallId: '123',
    });
  });

  test('retries on crash/error if exit code is non-zero', async () => {
    const client = new GeminiProvider({ retryBaseDelayMs: 1 });

    let attempt = 0;
    mockLines = async function* () {
      attempt++;
      if (attempt === 1) {
        mockSpawnController.exitCode = 1; // Crash
        // Emit a stderr line to trigger crash classification
        mockSpawnController.stderr.emit('data', Buffer.from('exited with code 1'));
      } else {
        mockSpawnController.exitCode = 0;
        yield JSON.stringify({ type: 'message', role: 'assistant', content: 'Success' });
        yield JSON.stringify({ type: 'result', stats: { total_tokens: 1 } });
      }
    };

    const chunks = [];
    for await (const chunk of client.sendQuery('Hi', '/test/cwd')) {
      chunks.push(chunk);
    }

    // Should succeed on second attempt
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ type: 'assistant', content: 'Success' });
  });

  test('aborts early if signal is aborted', async () => {
    const client = new GeminiProvider({ retryBaseDelayMs: 1 });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.sendQuery('Hi', '/test/cwd', undefined, { abortSignal: controller.signal }).next()
    ).rejects.toThrow('Query aborted');
  });

  test('yields init chunk session id', async () => {
    const client = new GeminiProvider({ retryBaseDelayMs: 1 });

    mockLines = [
      JSON.stringify({ type: 'init', session_id: 'session-456' }),
      JSON.stringify({
        type: 'result',
        stats: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    ];

    const chunks = [];
    for await (const chunk of client.sendQuery('Hi', '/test/cwd')) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'result', sessionId: 'session-456' });
  });

  test('yields tool call with fallback unknown toolName and empty args', async () => {
    const client = new GeminiProvider({ retryBaseDelayMs: 1 });

    mockLines = [
      JSON.stringify({ type: 'tool_use' }),
      JSON.stringify({ type: 'tool_result' }),
      JSON.stringify({ type: 'result', stats: { total_tokens: 1 } }),
    ];

    const chunks = [];
    for await (const chunk of client.sendQuery('Hi', '/test/cwd')) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ type: 'tool', toolName: 'unknown', toolInput: {} });
    expect(chunks[1]).toEqual({ type: 'tool_result', toolName: 'unknown', toolOutput: '' });
  });

  test('throws if result chunk has error status', async () => {
    const client = new GeminiProvider({ retryBaseDelayMs: 1 });

    let attempt = 0;
    mockLines = async function* () {
      attempt++;
      if (attempt === 1) {
        yield JSON.stringify({
          type: 'result',
          status: 'error',
          error: { type: 'unknown', message: 'API Error' },
        });
      } else {
        mockSpawnController.exitCode = 0;
        yield JSON.stringify({ type: 'result', stats: { total_tokens: 1 } });
      }
    };

    const chunks = [];
    for await (const chunk of client.sendQuery('Hi', '/test/cwd')) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(attempt).toBeGreaterThan(1);
  });

  test('throws auth error with enriched context', async () => {
    const client = new GeminiProvider({ retryBaseDelayMs: 1 });

    let attempt = 0;
    mockLines = async function* () {
      attempt++;
      mockSpawnController.stderr.emit('data', Buffer.from('API key not valid'));
      throw new Error('API Error');
    };

    await expect(client.sendQuery('Hi', '/test/cwd').next()).rejects.toThrow(
      /Gemini CLI auth error/
    );
    expect(attempt).toBe(1); // Auth errors are not retried
  });
});
