import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RunRecord } from 'telmoni';

import type { V1Client, V1Event, V1Result, V2Context, V2Event } from '../src/opencode';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Where every fixture's times are counted from: 2026-10-12T09:00:00Z. */
export const T0 = Date.UTC(2026, 9, 12, 9, 0, 0);

export const at = (ms: number): number => T0 + ms;

export interface V1Fixture {
  events: Array<V1Event & { id: string }>;
  sessions: Record<string, { info: Record<string, unknown>; messages: Array<{ info: Record<string, unknown>; parts: unknown[] }> }>;
}

export interface V2Fixture {
  events: Array<V2Event & { id: string }>;
}

export function v1Fixture(name: string): V1Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, 'v1', `${name}.json`), 'utf8')) as V1Fixture;
}

export function v2Fixture(name: string): V2Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, 'v2', `${name}.json`), 'utf8')) as V2Fixture;
}

/** The fields of a fixture that are times, and only those. */
const TIMES = new Set(['created', 'completed', 'updated', 'start', 'end', 'started', 'at', 'next', 'time']);

/** `value` with every time in it moved by `offset` milliseconds, as if it had happened that much later. */
export function shifted<T>(value: T, offset: number): T {
  const walk = (item: unknown, key: string | undefined): unknown => {
    if (typeof item === 'number' && key !== undefined && TIMES.has(key)) return item + offset;
    if (Array.isArray(item)) return item.map((each) => walk(each, undefined));
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, walk(v, k)]));
    }
    return item;
  };
  return walk(value, undefined) as T;
}

export function tempDir(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'telmoni-opencode-'));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * OpenCode 1's client as the plugin meets it, answering from a fixture's
 * sessions: a page of the newest messages before a cursor, oldest first,
 * with the cursor of the page before it in `X-Next-Cursor`, as OpenCode's
 * own server pages them.
 */
export function fakeClient(fixture: V1Fixture): V1Client & { reads: Array<{ path: string; query?: unknown }> } {
  const reads: Array<{ path: string; query?: unknown }> = [];
  const notFound = (): V1Result => ({ error: { name: 'NotFoundError', data: { message: '…' } }, response: { status: 404, headers: new Headers() } });
  return {
    reads,
    session: {
      messages: async ({ path, query }) => {
        reads.push({ path: `/session/${path.id}/message`, query });
        const session = fixture.sessions[path.id];
        if (session === undefined) return notFound();
        const all = session.messages;
        const end = query?.before === undefined ? all.length : Number(query.before.replace('cur_', ''));
        const start = query?.limit === undefined ? 0 : Math.max(0, end - query.limit);
        const headers = new Headers();
        if (start > 0) headers.set('X-Next-Cursor', `cur_${start}`);
        return { data: structuredClone(all.slice(start, end)), response: { status: 200, headers } };
      },
      get: async ({ path }) => {
        reads.push({ path: `/session/${path.id}` });
        const session = fixture.sessions[path.id];
        return session === undefined ? notFound() : { data: structuredClone(session.info), response: { status: 200, headers: new Headers() } };
      },
    },
  };
}

/** OpenCode 2's plugin context as the plugin meets it: a stream that yields the fixture's events, then waits to be closed. */
export function fakeContext(events: readonly V2Event[]): V2Context & { closed: () => boolean } {
  let closed = false;
  return {
    closed: () => closed,
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield structuredClone(event);
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          closed = true;
        },
      }),
    },
  };
}

export async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

/** Every key a record may hold: ids, names, models, providers, counts, times and outcomes. */
export const RECORD_KEYS = [
  'agent',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'calls',
  'cancelled',
  'end',
  'errorType',
  'inputTokens',
  'inside',
  'model',
  'name',
  'outputTokens',
  'provider',
  'runId',
  'sessionId',
  'start',
  'type',
  'usage',
];

/** The keys of `records`, at every depth. */
export function keysOf(records: readonly RunRecord[]): string[] {
  const keys = new Set<string>();
  JSON.parse(JSON.stringify(records), (key, value: unknown) => {
    if (key !== '' && Number.isNaN(Number(key))) keys.add(key);
    return value;
  });
  return [...keys].sort();
}

export interface JsonSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status?: { code: number };
}

export interface Received {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Ingest as the SDK meets it: an OTLP/JSON lane that keeps what it is sent,
 * and answers `status`, `delayMs` late — never, at `Infinity`, until
 * `release` is called. A `200` carries `partial`, a partial success's
 * message, where it is set; a `429` or `503` asks to be tried again at once.
 * A body is stored the first time it is answered `200`, as ingest's claim
 * on a body answers its copies.
 */
export class FakeIngest {
  readonly received: Received[] = [];
  status = 200;
  partial: string | undefined;
  delayMs = 0;
  answered = 0;
  /** The most requests it was ever answering at once. */
  busiest = 0;
  readonly #stored = new Set<string>();
  readonly #held = new Set<() => void>();
  #open = 0;
  #server: Server | undefined;

  /** How many different bodies it stored. */
  get stored(): number {
    return this.#stored.size;
  }

  async start(port = 0): Promise<string> {
    this.#server = createServer((request, response) => {
      this.#open += 1;
      this.busiest = Math.max(this.busiest, this.#open);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.received.push({ url: request.url ?? '', headers: request.headers, body });
        const status = this.status;
        const partial = this.partial;
        const answer = (): void => {
          if (status === 200) {
            this.#stored.add(createHash('sha256').update(body).digest('hex'));
            response.writeHead(200, { 'Content-Type': 'application/json', 'Telmoni-Content-Mode': 'off' });
            response.end(JSON.stringify({ partialSuccess: partial === undefined ? null : { rejectedSpans: 1, errorMessage: partial } }));
          } else if (status === 429 || status === 503) {
            response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '0' });
            response.end(JSON.stringify({ code: 14, message: '/errors/telemetry/store-unavailable: the span store is not taking rows; retry in a second' }));
          } else {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ code: 7, message: '/errors/authz/forbidden: this API key does not hold the ingest scope' }));
          }
          this.#open -= 1;
          this.answered += 1;
        };
        if (this.delayMs <= 0) {
          answer();
          return;
        }
        const timer = Number.isFinite(this.delayMs) ? setTimeout(() => release(), this.delayMs) : undefined;
        const release = (): void => {
          clearTimeout(timer);
          this.#held.delete(release);
          answer();
        };
        this.#held.add(release);
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}`;
  }

  /** Answers every request still held, now. */
  release(): void {
    for (const answer of [...this.#held]) answer();
  }

  /** Answers what is held, so no export is left to retry, and closes once every connection is done. */
  stop(): Promise<void> {
    this.release();
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  spans(): JsonSpan[] {
    return this.received.flatMap((request) => {
      const body = JSON.parse(request.body) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: JsonSpan[] }> }>;
      };
      return body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
    });
  }
}

export function attributesOf(span: JsonSpan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attribute of span.attributes) {
    const value = attribute.value;
    out[attribute.key] = 'intValue' in value ? Number(value['intValue']) : Object.values(value)[0];
  }
  return out;
}
