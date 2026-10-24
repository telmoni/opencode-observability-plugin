/**
 * A turn of OpenCode as the SDK's run record, whichever major it came from: the turn a run of `opencode`, each reply a
 * model call, each tool a tool call, and each subagent a step with the subagent's own calls inside it.
 */

import { createHash } from 'node:crypto';

import type {
  CallRecord,
  ModelCallRecord,
  RecordOutcome,
  RunRecord,
  StepRecord,
  ToolCallRecord,
  Usage,
} from 'telmoni';

import { fieldsOf } from './opencode.js';

export const AGENT = 'opencode';

/** The plugin's own namespace for run ids, so no other tool's ids can meet them. */
const NAMESPACE = 'e214b7a9-7f77-4e85-b211-fc033eb46049';

/** The tools that start a subagent: OpenCode 1's `task`, OpenCode 2's `subagent`. */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['task', 'subagent']);

/** Subagents nest; past this depth one's calls are not read. */
export const MAX_DEPTH = 4;

/** A version 5 UUID (RFC 9562): the same turn always gets the same run id. */
export function uuid5(namespace: string, name: string): string {
  const hash = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name, 'utf8').digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The run id of the turn `anchor` opened in the session: its user message, or its first reply where it has none of its own. */
export function runIdOf(sessionId: string, anchor: string): string {
  return uuid5(NAMESPACE, `${sessionId}/${anchor}`);
}

/**
 * OpenCode's provider ids where the GenAI conventions spell the same provider otherwise; every other id is the same in
 * both, or has no name in the conventions and is sent as OpenCode gives it.
 */
const PROVIDERS: ReadonlyMap<string, string> = new Map([
  ['amazon-bedrock', 'aws.bedrock'],
  ['azure', 'azure.ai.openai'],
  ['azure-cognitive-services', 'azure.ai.openai'],
  ['google', 'gcp.gemini'],
  ['google-vertex', 'gcp.vertex_ai'],
  ['google-vertex-anthropic', 'gcp.vertex_ai'],
  ['mistral', 'mistral_ai'],
  ['xai', 'x_ai'],
]);

export function providerOf(providerId: string): string {
  return PROVIDERS.get(providerId) ?? providerId;
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * OpenCode's token counts as the conventions count them: both majors write input apart from the cache's reads and
 * writes and output apart from reasoning, where the SDK takes input and output with those in, the cache's two also apart.
 */
export function usageOf(tokens: unknown): Usage | undefined {
  const counts = fieldsOf(tokens);
  if (counts === undefined) return undefined;
  const cache = fieldsOf(counts['cache']);
  const read = countOf(cache?.['read']);
  const write = countOf(cache?.['write']);
  return {
    inputTokens: countOf(counts['input']) + read + write,
    outputTokens: countOf(counts['output']) + countOf(counts['reasoning']),
    cacheReadInputTokens: read,
    cacheWriteInputTokens: write,
  };
}

/** Two counts as one: a reply OpenCode answered in several steps counts each step's tokens apart. */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheWriteInputTokens: (a.cacheWriteInputTokens ?? 0) + (b.cacheWriteInputTokens ?? 0),
  };
}

/** A kind of error, as OpenCode names one — `APIError`, `provider.rate-limit` — and never its message. */
const ERROR_TYPE = /^[A-Za-z][\w.:-]{0,63}$/;

export function errorTypeOf(name: unknown, fallback: string): string {
  return typeof name === 'string' && ERROR_TYPE.test(name) ? name : fallback;
}

/** An agent's name names a step: a plain name, or none. */
const AGENT_NAME = /^[\w.:-]{1,64}$/;

export function agentOf(value: unknown): string | undefined {
  return typeof value === 'string' && AGENT_NAME.test(value) ? value : undefined;
}

/**
 * A tool's name: a plain name, as every provider has a tool's, within the 145 characters ingest takes. OpenCode 2 hands
 * over whatever name the model wrote, so anything else is text, and is recorded as `unknown`.
 */
const TOOL_NAME = /^[\w.:@+-]{1,145}$/;

export function toolNameOf(value: unknown): string {
  return typeof value === 'string' && TOOL_NAME.test(value) ? value : 'unknown';
}

/** Ingest takes a model's and a provider's name to 128 characters, as the SDK does. */
const NAME_MAX = 128;

/** A name holds no control character. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A file's path, which a model's name, chosen in a person's configuration, may be: never recorded. */
const PATH = /^(?:[/\\]|~(?:[/\\]|$)|\.{1,2}[/\\]|[A-Za-z]:[/\\]|file:)/i;

/** A path ending in a local model's weights, from anywhere: the file's name is the model's, and is kept without its folders. */
const MODEL_FILE = /[/\\]([^/\\]+\.(?:gguf|ggml|bin|safetensors|llamafile))$/i;

/** `value`'s characters, as ingest counts them, where it is a name: something in it, and no control character. */
function charactersOf(value: string): string[] | undefined {
  const name = value.trim();
  return name === '' || CONTROL.test(name) ? undefined : Array.from(name);
}

/**
 * A model's name as OpenCode spells it, cut to what ingest takes: a model file's own name for its path, and `unknown`
 * for any other path or no name.
 */
function modelNameOf(value: string): string {
  const characters = charactersOf(value);
  if (characters === undefined) return 'unknown';
  const file = MODEL_FILE.exec(characters.join(''))?.[1];
  if (file !== undefined) return Array.from(file).slice(0, NAME_MAX).join('');
  const name = characters.slice(0, NAME_MAX).join('');
  return PATH.test(name) ? 'unknown' : name;
}

/** A provider's name, the conventions' where they have one, or none where ingest would not take it whole. */
function providerNameOf(providerId: string): string | undefined {
  const characters = charactersOf(providerOf(providerId));
  return characters !== undefined && characters.length <= NAME_MAX ? characters.join('') : undefined;
}

/** When something ran, and how it ended; neither outcome set is ok. */
export interface Span {
  start: number;
  end: number;
  errorType?: string | undefined;
  cancelled?: boolean | undefined;
}

function settle<T extends RecordOutcome>(target: T, span: Span): T {
  if (span.errorType !== undefined) target.errorType = span.errorType;
  else if (span.cancelled === true) target.cancelled = true;
  return target;
}

export function modelCall(model: string, providerId: string | undefined, span: Span, usage: Usage | undefined): ModelCallRecord {
  const call: ModelCallRecord = { type: 'model_call', model: modelNameOf(model), start: span.start, end: Math.max(span.start, span.end) };
  const provider = providerId === undefined ? undefined : providerNameOf(providerId);
  if (provider !== undefined) call.provider = provider;
  if (usage !== undefined) call.usage = usage;
  return settle(call, span);
}

export function toolCall(name: string, span: Span): ToolCallRecord {
  return settle<ToolCallRecord>({ type: 'tool_call', name: toolNameOf(name), start: span.start, end: Math.max(span.start, span.end) }, span);
}

/** A subagent's work: a step named by its agent, holding its calls, from the first of them to the last. */
export function subagentStep(agent: string | undefined, span: Span, calls: readonly CallRecord[]): StepRecord {
  const inside = ordered(calls);
  const { start, end } = boundsOf(span, inside);
  return settle<StepRecord>({ type: 'step', name: `subagent ${agent ?? 'unknown'}`, start, end, calls: inside }, span);
}

/** From the first start to the last end of `span` and `items`, a loop's, since a spread of a long turn's would throw. */
function boundsOf(span: Span, items: ReadonlyArray<{ start: Date | number; end: Date | number }>): { start: number; end: number } {
  let start = span.start;
  let end = Math.max(span.start, span.end);
  for (const item of items) {
    start = Math.min(start, Number(item.start));
    end = Math.max(end, Number(item.end));
  }
  return { start, end };
}

/**
 * In the order they started, so the record, and the ids the SDK derives from
 * each span's place in it, come out the same however OpenCode delivered them.
 */
function ordered<T extends { start: Date | number }>(items: readonly T[]): T[] {
  const order = new Map(items.map((item, index) => [item, index]));
  return [...items].sort((a, b) => Number(a.start) - Number(b.start) || order.get(a)! - order.get(b)!);
}

/** The turn as a run, from its opening, or its first work, to the last of its work. */
export function runOf(sessionId: string, anchor: string, span: Span, items: ReadonlyArray<CallRecord | StepRecord>): RunRecord {
  const inside = ordered(items);
  const { start, end } = boundsOf(span, inside);
  return settle<RunRecord>({ runId: runIdOf(sessionId, anchor), agent: AGENT, sessionId, start, end, inside }, span);
}
