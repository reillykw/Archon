/**
 * Gemini binary resolver for compiled (bun --compile) archon binaries.
 *
 * This module resolves an alternative path to the native Gemini CLI binary,
 * bypassing the broken resolution in compiled binaries where
 * `import.meta.url` is frozen to the build host's path.
 *
 * Resolution order:
 * 1. `GEMINI_BIN_PATH` environment variable
 * 2. `assistants.gemini.geminiBinaryPath` in config
 * 3. `~/.archon/vendor/gemini/<platform-binary>` (user-placed)
 * 4. Throw with install instructions
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the SDK
 * uses its normal node_modules-based resolution (or we just spawn 'gemini').
 */
import { existsSync as _existsSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_IS_BINARY, getArchonHome, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('gemini-binary');
  return cachedLog;
}

const GEMINI_VENDOR_DIR = 'vendor/gemini';

const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'];

/** Returns the vendor binary filename for the current platform, or undefined if unsupported. */
function getVendorBinaryName(): string | undefined {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) return undefined;
  if (process.arch !== 'x64' && process.arch !== 'arm64') return undefined;
  return process.platform === 'win32' ? 'gemini.exe' : 'gemini';
}

/**
 * Resolve the path to the Gemini native binary.
 *
 * In dev mode: returns undefined (let system resolve via PATH).
 * In binary mode: resolves from env/config/vendor dir, or throws with install instructions.
 */
export async function resolveGeminiBinaryPath(
  configGeminiBinaryPath?: string
): Promise<string | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

  // 1. Environment variable override
  const envPath = process.env.GEMINI_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `GEMINI_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the Gemini CLI binary.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'gemini.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  if (configGeminiBinaryPath) {
    if (!fileExists(configGeminiBinaryPath)) {
      throw new Error(
        `assistants.gemini.geminiBinaryPath is set to "${configGeminiBinaryPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the Gemini CLI binary.'
      );
    }
    getLog().info(
      { binaryPath: configGeminiBinaryPath, source: 'config' },
      'gemini.binary_resolved'
    );
    return configGeminiBinaryPath;
  }

  // 3. Check vendor directory (user-placed binary)
  const binaryName = getVendorBinaryName();
  if (binaryName) {
    const archonHome = getArchonHome();
    const vendorBinaryPath = join(archonHome, GEMINI_VENDOR_DIR, binaryName);

    if (fileExists(vendorBinaryPath)) {
      getLog().info({ binaryPath: vendorBinaryPath, source: 'vendor' }, 'gemini.binary_resolved');
      return vendorBinaryPath;
    }
  }

  // 4. Not found — throw with install instructions
  const vendorPath = `~/.archon/${GEMINI_VENDOR_DIR}/`;
  throw new Error(
    'Gemini CLI binary not found. The Gemini provider requires a native binary\n' +
      'that cannot be resolved automatically in compiled Archon builds.\n\n' +
      'To fix, choose one of:\n' +
      '  1. Install globally: npm install -g @google/gemini-cli\n' +
      '     Then set: GEMINI_BIN_PATH=$(which gemini)\n\n' +
      `  2. Place the binary at: ${vendorPath}\n\n` +
      '  3. Set the path in config:\n' +
      '     # .archon/config.yaml\n' +
      '     assistants:\n' +
      '       gemini:\n' +
      '         geminiBinaryPath: /path/to/gemini\n'
  );
}
