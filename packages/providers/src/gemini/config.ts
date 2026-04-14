import type { GeminiProviderDefaults } from '../types';

export type { GeminiProviderDefaults } from '../types';

export function parseGeminiConfig(raw: Record<string, unknown>): GeminiProviderDefaults {
  const result: GeminiProviderDefaults = {};
  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }
  if (typeof raw.geminiBinaryPath === 'string') {
    result.geminiBinaryPath = raw.geminiBinaryPath;
  }
  return result;
}
