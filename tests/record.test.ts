import type { ModelCallRecord, StepRecord, ToolCallRecord } from 'telmoni';
import { describe, expect, it } from 'vitest';

import {
  AGENT,
  addUsage,
  agentOf,
  errorTypeOf,
  modelCall,
  providerOf,
  runIdOf,
  runOf,
  subagentStep,
  toolCall,
  usageOf,
  uuid5,
} from '../src/record';
import { at } from './helpers';

const UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('a run id', () => {
  it('is a version 5 UUID as RFC 9562 derives one', () => {
    // RFC 9562's own example: the DNS namespace and "www.example.com".
    expect(uuid5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('is the same for the same turn, and differs by session and by what opened the turn', () => {
    const id = runIdOf('ses_a', 'msg_1');
    expect(id).toMatch(UUID5);
    expect(runIdOf('ses_a', 'msg_1')).toBe(id);
    expect(runIdOf('ses_b', 'msg_1')).not.toBe(id);
    expect(runIdOf('ses_a', 'msg_2')).not.toBe(id);
  });
});

describe('a provider', () => {
  it('takes the GenAI conventions’ name where OpenCode’s id differs from it, and is given as is elsewhere', () => {
    expect(providerOf('amazon-bedrock')).toBe('aws.bedrock');
    expect(providerOf('azure')).toBe('azure.ai.openai');
    expect(providerOf('google')).toBe('gcp.gemini');
    expect(providerOf('google-vertex')).toBe('gcp.vertex_ai');
    expect(providerOf('google-vertex-anthropic')).toBe('gcp.vertex_ai');
    expect(providerOf('mistral')).toBe('mistral_ai');
    expect(providerOf('xai')).toBe('x_ai');
    for (const same of ['anthropic', 'openai', 'groq', 'deepseek', 'cohere', 'perplexity']) expect(providerOf(same)).toBe(same);
    for (const unnamed of ['openrouter', 'github-copilot', 'opencode', 'ollama', 'my-gateway']) expect(providerOf(unnamed)).toBe(unnamed);
    expect(providerOf('constructor')).toBe('constructor');
  });
});

describe('token counts', () => {
  it('count input with the cache’s reads and writes, and output with reasoning, as the conventions do', () => {
    expect(usageOf({ input: 1200, output: 80, reasoning: 40, cache: { read: 3000, write: 500 } })).toEqual({
      inputTokens: 4700,
      outputTokens: 120,
      cacheReadInputTokens: 3000,
      cacheWriteInputTokens: 500,
    });
  });

  it('read a count that is missing, negative or not a number as none, and nothing as nothing', () => {
    expect(usageOf({ input: -5, output: Number.NaN, reasoning: '7', cache: null })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    expect(usageOf(undefined)).toBeUndefined();
    expect(usageOf([1, 2])).toBeUndefined();
  });

  it('add up across a reply’s steps', () => {
    const a = usageOf({ input: 400, output: 60, reasoning: 0, cache: { read: 4200, write: 0 } });
    const b = usageOf({ input: 100, output: 20, reasoning: 10, cache: { read: 4600, write: 100 } });
    expect(addUsage(a, b)).toEqual({ inputTokens: 9400, outputTokens: 90, cacheReadInputTokens: 8800, cacheWriteInputTokens: 100 });
    expect(addUsage(undefined, b)).toBe(b);
    expect(addUsage(a, undefined)).toBe(a);
  });
});

describe('an error’s kind', () => {
  it('is kept where it is a name, and never where it reads like a message', () => {
    expect(errorTypeOf('APIError', 'Error')).toBe('APIError');
    expect(errorTypeOf('provider.rate-limit', 'Error')).toBe('provider.rate-limit');
    expect(errorTypeOf('the file /etc/passwd was not found', 'Error')).toBe('Error');
    expect(errorTypeOf(undefined, 'Error')).toBe('Error');
    expect(errorTypeOf('x'.repeat(65), 'Error')).toBe('Error');
  });

  it('and an agent’s name only where it is a plain name', () => {
    expect(agentOf('explore')).toBe('explore');
    expect(agentOf('code-reviewer')).toBe('code-reviewer');
    expect(agentOf('…')).toBeUndefined();
    expect(agentOf('a/b')).toBeUndefined();
    expect(agentOf('')).toBeUndefined();
  });
});

describe('a name a record holds', () => {
  it('is a tool’s where it is a plain name, and `unknown` where it reads like text the model wrote', () => {
    for (const name of ['bash', 'github_create_issue', 'mcp__linear__list', 'functions.read', 'x'.repeat(145)]) {
      expect(toolCall(name, { start: at(0), end: at(1) }).name).toBe(name);
    }
    for (const junk of ['read the file at /etc/hosts', 'a/b', '…', '', 'x'.repeat(146), 'tab\there']) {
      expect(toolCall(junk, { start: at(0), end: at(1) }).name).toBe('unknown');
    }
  });

  it('is a model’s as OpenCode spells it, within ingest’s 128, and never a path', () => {
    for (const model of ['claude-sonnet-4-5', 'anthropic/claude-sonnet-4.5', '@cf/meta/llama-3.1-8b-instruct', 'qwen2.5-coder:7b', 'claude-3-5-sonnet@20240620', '~anthropic/claude-sonnet-latest', 'TheBloke/Mistral-7B-Instruct-v0.2-GGUF', 'models/gemini-2.5-pro', 'qwen2.5-coder-7b-q4_k_m.gguf']) {
      expect(modelCall(model, undefined, { start: at(0), end: at(1) }, undefined).model).toBe(model);
    }
    const long = modelCall('m'.repeat(200), undefined, { start: at(0), end: at(1) }, undefined).model;
    expect(long).toBe('m'.repeat(128));
    // Cut by characters, as ingest counts them, never inside one.
    expect(modelCall('😀'.repeat(130), undefined, { start: at(0), end: at(1) }, undefined).model).toBe('😀'.repeat(128));
    const files: Array<[string, string]> = [
      ['/home/someone/models/llama.gguf', 'llama.gguf'],
      ['models/x.gguf', 'x.gguf'],
      ['./models/x.gguf', 'x.gguf'],
      ['../acme/models/x.Q4_K_M.gguf', 'x.Q4_K_M.gguf'],
      ['TheBloke/Mistral-7B-Instruct-v0.2-GGUF/mistral-7b-instruct-v0.2.Q4_K_M.gguf', 'mistral-7b-instruct-v0.2.Q4_K_M.gguf'],
      ['~/models/ggml-model-q4_0.bin', 'ggml-model-q4_0.bin'],
      ['C:\\Users\\someone\\models\\m.safetensors', 'm.safetensors'],
      ['file:///home/someone/m.GGUF', 'm.GGUF'],
      ['/opt/x.llamafile', 'x.llamafile'],
      [`/home/someone/${'deep/'.repeat(30)}m.ggml`, 'm.ggml'],
    ];
    for (const [path, file] of files) expect(modelCall(path, undefined, { start: at(0), end: at(1) }, undefined).model).toBe(file);
    for (const path of ['~/models/x', '~', 'C:\\models\\x', 'D:/models/x', '.\\models\\x', '/opt/models/llama-3-8b', '/home/someone', 'file:///home/someone/m', 'FILE:m.gguf', 'a\nb', ' ']) {
      expect(modelCall(path, undefined, { start: at(0), end: at(1) }, undefined).model).toBe('unknown');
    }
  });

  it('is a provider’s within ingest’s 128, or none', () => {
    expect(modelCall('m', 'my-gateway', { start: at(0), end: at(1) }, undefined).provider).toBe('my-gateway');
    expect(modelCall('m', 'p'.repeat(129), { start: at(0), end: at(1) }, undefined).provider).toBeUndefined();
    expect(modelCall('m', 'bad\u0007id', { start: at(0), end: at(1) }, undefined).provider).toBeUndefined();
  });
});

describe('a run', () => {
  it('holds its calls in the order they started, from its opening to the last of its work', () => {
    const late: ToolCallRecord = toolCall('bash', { start: at(500), end: at(900), errorType: 'ToolError' });
    const early: ModelCallRecord = modelCall('m', 'google', { start: at(100), end: at(400) }, undefined);
    const run = runOf('ses_a', 'msg_1', { start: at(0), end: at(600), cancelled: true }, [late, early]);
    expect(run.agent).toBe(AGENT);
    expect(run.runId).toBe(runIdOf('ses_a', 'msg_1'));
    expect(run.inside).toEqual([early, late]);
    expect(run.start).toBe(at(0));
    expect(run.end).toBe(at(900));
    expect(run.cancelled).toBe(true);
    expect(early.provider).toBe('gcp.gemini');
    expect(late.errorType).toBe('ToolError');
  });

  it('takes a turn of any length, past the calls a spread of them could hold', () => {
    const calls = Array.from({ length: 200_000 }, (_, index) => toolCall('read', { start: at(index), end: at(index + 1) }));
    const run = runOf('ses_long', 'msg_1', { start: at(0), end: at(1) }, calls);
    expect([run.start, run.end]).toEqual([at(0), at(200_000)]);
    const step = subagentStep('explore', { start: at(5), end: at(6) }, calls);
    expect([step.start, step.end]).toEqual([at(0), at(200_000)]);
  });

  it('never ends a call before it starts, and a failure outranks a cancellation', () => {
    const call = toolCall('read', { start: at(500), end: at(100), errorType: 'ToolError', cancelled: true });
    expect(call.end).toBe(at(500));
    expect(call.errorType).toBe('ToolError');
    expect(call.cancelled).toBeUndefined();
  });

  it('holds a subagent as a step named by its agent, from its first call to its last', () => {
    const inner = [modelCall('m', 'anthropic', { start: at(1300), end: at(2100) }, undefined), toolCall('grep', { start: at(2050), end: at(3000) })];
    const step: StepRecord = subagentStep('explore', { start: at(1050), end: at(2500) }, inner);
    expect(step.name).toBe('subagent explore');
    expect([step.start, step.end]).toEqual([at(1050), at(3000)]);
    expect(step.calls).toEqual(inner);
    expect(subagentStep(undefined, { start: at(0), end: at(1) }, []).name).toBe('subagent unknown');
  });
});
