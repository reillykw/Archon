export function isClaudeModel(model: string): boolean {
  return (
    model === 'sonnet' ||
    model === 'opus' ||
    model === 'haiku' ||
    model === 'inherit' ||
    model.startsWith('claude-')
  );
}

export function isGeminiModel(model: string): boolean {
  return model.startsWith('gemini-');
}

export function isModelCompatible(
  provider: 'claude' | 'codex' | 'gemini',
  model?: string
): boolean {
  if (!model) return true;
  if (provider === 'claude') return isClaudeModel(model);
  if (provider === 'gemini') return isGeminiModel(model);
  // Codex: accept most models, but reject obvious Claude/Gemini aliases/prefixes
  return !isClaudeModel(model) && !isGeminiModel(model);
}
