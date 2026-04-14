/**
 * Gemini CLI wrapper
 * Provides async generator interface for streaming Gemini CLI responses
 * using the gemini-cli binary in subprocess mode.
 */
import { spawn } from 'child_process';
import * as readline from 'readline';
import {
  type SendQueryOptions,
  type IAgentProvider,
  type MessageChunk,
  type TokenUsage,
  type ProviderCapabilities,
} from '../types';
import { GEMINI_CAPABILITIES } from './capabilities';
import { createLogger, getArchonHome } from '@archon/paths';
import { resolveGeminiBinaryPath } from './binary-resolver';
import { parseGeminiConfig } from './config';
import { existsSync, mkdirSync } from 'fs';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.gemini');
  return cachedLog;
}

/** Max retries for transient subprocess failures */
const MAX_SUBPROCESS_RETRIES = 3;

/** Delay between retries in milliseconds */
const RETRY_BASE_DELAY_MS = 2000;

/** Patterns indicating rate limiting in stderr/error messages */
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'quota', 'overloaded'];

/** Patterns indicating auth issues in stderr/error messages */
const AUTH_PATTERNS = [
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
  'api key not valid',
  'permission denied',
];

function classifySubprocessError(
  errorMessage: string,
  stderrOutput: string
): 'rate_limit' | 'auth' | 'crash' | 'unknown' {
  const combined = `${errorMessage} ${stderrOutput}`.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => combined.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => combined.includes(p))) return 'auth';
  // Assume other errors are crashes/transient unless specifically known
  return 'crash';
}

/** Sentinel error class to identify timeout rejections in withFirstMessageTimeout. */
class FirstEventTimeoutError extends Error {}

/**
 * Wraps an async generator so that the first call to .next() must resolve
 * within `timeoutMs`. If it doesn't, aborts the controller and throws a
 * descriptive error. Subsequent .next() calls are forwarded directly.
 */
export async function* withFirstMessageTimeout<T>(
  gen: AsyncGenerator<T>,
  controller: AbortController,
  timeoutMs: number,
  diagnostics: Record<string, unknown>
): AsyncGenerator<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let firstValue: IteratorResult<T>;
  try {
    firstValue = await Promise.race([
      gen.next(),
      new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          reject(new FirstEventTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof FirstEventTimeoutError) {
      controller.abort();
      getLog().error({ ...diagnostics, timeoutMs }, 'gemini.first_event_timeout');
      throw new Error(
        'Gemini CLI subprocess produced no output within ' +
          timeoutMs +
          'ms. ' +
          'See logs for gemini.first_event_timeout diagnostic dump.'
      );
    }
    throw err;
  } finally {
    clearTimeout(timerId);
  }

  if (firstValue.done) return;
  yield firstValue.value;

  yield* gen;
}

export class GeminiProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    if (!existsSync(cwd)) {
      try {
        mkdirSync(cwd, { recursive: true });
        getLog().info({ cwd }, 'gemini_cwd_created');
      } catch (err) {
        getLog().warn({ cwd, err }, 'gemini_cwd_create_failed');
      }
    }

    const assistantConfig = parseGeminiConfig(requestOptions?.assistantConfig ?? {});

    let geminiExecutable =
      (await resolveGeminiBinaryPath(assistantConfig.geminiBinaryPath)) ?? 'gemini';

    // If we're relying on the system PATH ('gemini'), try to resolve the absolute path
    // using Bun.which. This prevents ENOENT errors in subshells or when spawn() fails
    // to search the PATH properly in dev mode.
    if (geminiExecutable === 'gemini' && typeof Bun !== 'undefined') {
      const resolvedPath = Bun.which('gemini');
      if (resolvedPath) {
        geminiExecutable = resolvedPath;
      }
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      const controller = new AbortController();
      if (requestOptions?.abortSignal) {
        requestOptions.abortSignal.addEventListener(
          'abort',
          () => {
            controller.abort();
          },
          { once: true }
        );
      }

      const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--approval-mode',
        'yolo', // Equivalent to bypassPermissions in Claude
      ];

      if (requestOptions?.model) {
        args.push('-m', requestOptions.model);
      }

      if (resumeSessionId) {
        args.push('--resume', resumeSessionId);
      }

      // Bypass path boundary restrictions by including the Archon home directory
      // (which contains the worktrees, logs, and artifacts directories)
      // plus any explicitly requested additional directories.
      const includeDirs = [getArchonHome()];
      args.push('--include-directories', includeDirs.join(','));

      const subprocessEnv = { ...process.env, ...(requestOptions?.env ?? {}) };

      // Map Archon's internal Gemini env vars to the standard Google Cloud SDK vars
      // that the Gemini CLI expects.
      if (subprocessEnv.GEMINI_API_KEY && !subprocessEnv.GOOGLE_API_KEY) {
        subprocessEnv.GOOGLE_API_KEY = subprocessEnv.GEMINI_API_KEY;
      }
      if (subprocessEnv.GEMINI_VERTEX_PROJECT) {
        subprocessEnv.GOOGLE_CLOUD_PROJECT = subprocessEnv.GEMINI_VERTEX_PROJECT;
        subprocessEnv.GOOGLE_GENAI_USE_VERTEXAI = 'true';
      }
      if (subprocessEnv.GEMINI_VERTEX_LOCATION) {
        subprocessEnv.GOOGLE_CLOUD_LOCATION = subprocessEnv.GEMINI_VERTEX_LOCATION;
      }

      let childProcess: ReturnType<typeof spawn> | undefined;
      const stderrLines: string[] = [];
      let returnedSessionId: string | undefined;

      try {
        let cmd = geminiExecutable;
        let finalArgs = args;

        // On Unix, globally installed npm binaries are usually symlinks to JS files with shebangs.
        // If the shebang uses "env -S node", posix_spawn often fails with ENOENT.
        // We can bypass the shebang entirely by running the current runtime and passing the file as the first arg.
        // On Windows, npm creates `.cmd` wrappers which MUST be executed with shell: true.
        const isWindows = process.platform === 'win32';
        const spawnOptions = {
          cwd,
          env: subprocessEnv,
          stdio: ['ignore', 'pipe', 'pipe'] as import('child_process').SpawnOptions['stdio'],
          shell: isWindows,
        };

        // If it's a native binary (like from our `bun --compile` vendor directory),
        // we shouldn't execute it with `bun`.
        if (
          !isWindows &&
          !geminiExecutable.endsWith('gemini.exe') &&
          !geminiExecutable.endsWith('gemini-linux-x64') &&
          !geminiExecutable.endsWith('gemini-darwin-arm64')
        ) {
          cmd = process.execPath;
          finalArgs = [geminiExecutable, ...args];
        }

        getLog().debug(
          {
            cmd,
            finalArgs,
            cwd,
            isWindows,
            project: subprocessEnv.GOOGLE_CLOUD_PROJECT,
            location: subprocessEnv.GOOGLE_CLOUD_LOCATION,
            api_key: !!subprocessEnv.GEMINI_API_KEY,
            raw_project: subprocessEnv.GEMINI_VERTEX_PROJECT,
          },
          'gemini.spawn_args'
        );

        childProcess = spawn(cmd, finalArgs, spawnOptions);

        const errorPromise = new Promise<never>((_, reject) => {
          childProcess?.on('error', err => {
            reject(err);
          });
        });

        if (childProcess?.stderr) {
          childProcess.stderr.on('data', (data: Buffer) => {
            const output = data.toString().trim();
            if (output) {
              stderrLines.push(output);
              const isError =
                output.toLowerCase().includes('error') ||
                output.toLowerCase().includes('fatal') ||
                output.toLowerCase().includes('failed') ||
                output.toLowerCase().includes('exception');
              if (isError) {
                getLog().error({ stderr: output }, 'subprocess_error');
              }
            }
          });
        }

        // Handle abort
        controller.signal.addEventListener('abort', () => {
          childProcess?.kill('SIGKILL');
        });

        const streamEvents = (async function* (): AsyncGenerator<MessageChunk> {
          if (!childProcess?.stdout) return;
          const rl = readline.createInterface({
            input: childProcess.stdout,
            crlfDelay: Infinity,
          });

          const lineIterator = rl[Symbol.asyncIterator]();

          while (true) {
            if (controller.signal.aborted) {
              break;
            }

            // Race the next line against process spawn errors
            const result = await Promise.race([lineIterator.next(), errorPromise]);

            if (result.done) {
              break;
            }

            const line = result.value;
            if (!line.trim()) continue;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let event: any;
            try {
              event = JSON.parse(line);
            } catch (e) {
              getLog().warn({ line, err: e }, 'gemini.parse_line_error');
              continue;
            }

            // Map Gemini stream-json events to MessageChunk
            if (event.type === 'init') {
              if (event.session_id) {
                returnedSessionId = event.session_id;
              }
            } else if (event.type === 'message' && event.role === 'assistant') {
              if (event.content) {
                yield { type: 'assistant', content: event.content } as MessageChunk;
              }
            } else if (event.type === 'tool_use') {
              yield {
                type: 'tool',
                toolName: event.tool_name ?? 'unknown',
                toolInput: event.parameters ?? {},
                ...(event.tool_id ? { toolCallId: event.tool_id } : {}),
              } as MessageChunk;
            } else if (event.type === 'tool_result') {
              yield {
                type: 'tool_result',
                toolName: event.tool_name ?? 'unknown',
                toolOutput:
                  event.output === undefined
                    ? ''
                    : typeof event.output === 'string'
                      ? event.output
                      : JSON.stringify(event.output),
                ...(event.tool_id ? { toolCallId: event.tool_id } : {}),
              } as MessageChunk;
            } else if (event.type === 'result') {
              if (event.status === 'error') {
                const errorMessage =
                  typeof event.error === 'string'
                    ? event.error
                    : (event.error?.message ?? JSON.stringify(event.error));
                throw new Error(errorMessage);
              }

              // Final result
              const inputTokens = event.stats?.input_tokens ?? 0;
              const outputTokens = event.stats?.output_tokens ?? 0;
              const totalTokens = event.stats?.total_tokens ?? inputTokens + outputTokens;

              const usage: TokenUsage | undefined =
                totalTokens > 0
                  ? {
                      input: inputTokens,
                      output: outputTokens,
                      total: totalTokens,
                    }
                  : undefined;

              yield {
                type: 'result',
                sessionId: returnedSessionId,
                ...(usage ? { tokens: usage } : {}),
                ...(event.stats?.models ? { modelUsage: event.stats.models } : {}),
              } as MessageChunk;
            }
          }

          // Wait for process exit if it hasn't already
          await Promise.race([
            errorPromise,
            new Promise<void>((resolve, reject) => {
              if (!childProcess) {
                resolve();
                return;
              }
              if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
                if (childProcess.exitCode !== 0 && childProcess.exitCode !== null) {
                  reject(new Error(`Process exited with code ${childProcess.exitCode}`));
                } else {
                  resolve();
                }
                return;
              }

              childProcess.on('close', code => {
                if (code !== 0 && code !== null) {
                  reject(new Error(`Process exited with code ${code}`));
                } else {
                  resolve();
                }
              });
              childProcess.on('error', reject);
            }),
          ]);
        })();

        const timeoutMs = 60_000;
        const diagnostics = {
          executable: geminiExecutable,
          args,
          cwd,
        };

        const events = withFirstMessageTimeout(streamEvents, controller, timeoutMs, diagnostics);
        for await (const chunk of events) {
          yield chunk;
        }

        return; // Success, exit retry loop
      } catch (error) {
        const err = error as Error & { code?: string };

        if (controller.signal.aborted) {
          throw new Error('Query aborted');
        }

        if (err.code === 'ENOENT') {
          throw new Error(
            `Gemini CLI binary not found ("${geminiExecutable}").\n\n` +
              'Please install the Gemini CLI by running:\n' +
              '  npm install -g @google/gemini-cli\n\n' +
              'Or set GEMINI_BIN_PATH in your .env if it is already installed in a custom location.'
          );
        }

        const stderrContext = stderrLines.join('\n');
        const errorClass = classifySubprocessError(err.message, stderrContext);

        getLog().error(
          { err, stderrContext, errorClass, attempt, maxRetries: MAX_SUBPROCESS_RETRIES },
          'query_error'
        );

        if (errorClass === 'auth') {
          const enrichedError = new Error(
            `Gemini CLI auth error: ${err.message}${stderrContext ? ` (${stderrContext})` : ''}`
          );
          enrichedError.cause = error;
          throw enrichedError;
        }

        if (
          attempt < MAX_SUBPROCESS_RETRIES &&
          (errorClass === 'rate_limit' || errorClass === 'crash')
        ) {
          const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
          getLog().info({ attempt, delayMs, errorClass }, 'retrying_subprocess');
          await new Promise(resolve => setTimeout(resolve, delayMs));
          lastError = err;
          continue;
        }

        const enrichedMessage = stderrContext
          ? `Gemini CLI ${errorClass}: ${err.message} (stderr: ${stderrContext})`
          : `Gemini CLI ${errorClass}: ${err.message}`;
        const enrichedError = new Error(enrichedMessage);
        enrichedError.cause = error;
        throw enrichedError;
      } finally {
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGKILL');
        }
      }
    }

    throw lastError ?? new Error('Gemini CLI query failed after retries');
  }

  getType(): string {
    return 'gemini';
  }

  getCapabilities(): ProviderCapabilities {
    return GEMINI_CAPABILITIES;
  }
}
