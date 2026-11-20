import { afterEach, describe, expect, it, vi } from 'vitest';
import { LATEST_ALIAS, aliasKey, followSuccessors, shownId, successor } from '../src/ai/models';
import { listModels, type AiSettings } from '../src/ai/client';

describe('OpenRouter\'s "latest" aliases only (26.080)', () => {
  it('an alias stands for its family: a version chosen before moves on to it; ids shown without the ~', () => {
    expect(LATEST_ALIAS.test('~anthropic/claude-opus-latest')).toBe(true);
    expect(LATEST_ALIAS.test('openai/gpt-chat-latest')).toBe(false);
    expect(LATEST_ALIAS.test('anthropic/claude-opus-5.5')).toBe(false);
    expect(aliasKey('~anthropic/claude-opus-latest')).toBe('anthropic/claude-opus');
    expect(aliasKey('anthropic/claude-opus-5.5')).toBe('anthropic/claude-opus');
    expect(aliasKey('openai/gpt-6-astra')).toBe(aliasKey('~openai/gpt-astra-latest'));
    expect(aliasKey('google/gemini-3.9-flash-preview')).toBe(aliasKey('~google/gemini-flash-latest'));
    expect(aliasKey('google/gemini-3.5-flash-lite')).not.toBe(aliasKey('~google/gemini-flash-latest'));
    const list = [{ id: '~anthropic/claude-opus-latest' }, { id: '~google/gemini-flash-latest' }, { id: '~openai/gpt-astra-latest' }];
    expect(successor('anthropic/claude-opus-5.5', list)?.id).toBe('~anthropic/claude-opus-latest');
    expect(successor('openai/gpt-6.1-astra', list)?.id).toBe('~openai/gpt-astra-latest');
    expect(successor('qwen/qwen3.8-max', list)).toBeNull();
    expect(followSuccessors({ 'konium:model': 'google/gemini-3.9-flash', 'konium:text': 'qwen/qwen3.8-max' }, 'konium', list, true)).toEqual({ 'konium:model': '~google/gemini-flash-latest' });
    expect(shownId('~anthropic/claude-opus-latest')).toBe('anthropic/claude-opus-latest');
    expect(shownId('anthropic/claude-opus-5.5')).toBe('anthropic/claude-opus-5.5');
  });

  describe('your own key', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const data = [
      { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000004', completion: '0.00002' } },
      { id: '~anthropic/claude-opus-latest', name: 'Anthropic: Claude Opus Latest', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000004', completion: '0.00002' } },
      { id: '~anthropic/claude-fable-latest', name: '~Anthropic: Claude Fable Latest', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.00001', completion: '0.00005' } },
      { id: '~deepseek/deepseek-pro-latest', name: 'DeepSeek: DeepSeek Pro Latest', architecture: { input_modalities: ['text'] }, pricing: { prompt: '0.0000001', completion: '0.000008' } },
      { id: 'openai/gpt-chat-latest', name: 'OpenAI: GPT Chat Latest', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.000005', completion: '0.00003' } },
      { id: '~google/gemini-flash-latest', name: '~Google: Gemini Flash Latest', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0.00000075', completion: '0.00000375' } },
    ];
    const cfg = (o: Partial<AiSettings>): AiSettings => ({ aiMode: 'key', aiProvider: 'openrouter', aiCustomBase: 'https://llm.example/v1', aiLocalBase: '', aiModels: {}, aiShareCache: false, ...o });
    it('OpenRouter: the aliases of the families offered (26.082: no Claude Fable, too dear), taking pictures, the cheapest first (26.083), named without the ~; another endpoint: all it lists', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data }))));
      const or = await listModels('key', cfg({}));
      expect(or.map((m) => [m.id, m.name])).toEqual([['~google/gemini-flash-latest', 'Google: Gemini Flash Latest'], ['~anthropic/claude-opus-latest', 'Anthropic: Claude Opus Latest']]);
      const custom = await listModels('key', cfg({ aiProvider: 'custom' }));
      expect(custom).toHaveLength(6);
    });
  });
});
