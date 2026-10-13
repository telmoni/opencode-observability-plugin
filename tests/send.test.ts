import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord, StepRecord, ToolCallRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Outbox, Sender, connect, fitted } from '../src/send';
import { FakeIngest, at, attributesOf, tempDir } from './helpers';

let ingest: FakeIngest;
let endpoint: string;
let logged: string[];

beforeEach(async () => {
  ingest = new FakeIngest();
  endpoint = await ingest.start();
  logged = [];
});

afterEach(async () => {
  await ingest.stop();
});

function turn(runId: string): RunRecord {
  return {
    runId,
    agent: 'opencode',
    sessionId: 'ses_send_0001',
    start: at(0),
    end: at(9_000),
    inside: [
      {
        type: 'model_call',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        start: at(0),
        end: at(4_000),
        usage: { inputTokens: 4_700, outputTokens: 120, cacheReadInputTokens: 3_000, cacheWriteInputTokens: 500 },
      },
      { type: 'tool_call', name: 'bash', start: at(4_000), end: at(9_000), errorType: 'ToolError' },
    ],
  };
}

describe('a sender', () => {
  it('sends each turn through the SDK, to ingest, from one client', async () => {
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    expect(ingest.received).toHaveLength(2);
    for (const request of ingest.received) {
      expect(request.url).toBe('/otlp/v1/traces');
      expect(request.headers['authorization']).toBe('Bearer telmoni_test');
    }
    const runs = ingest.spans().filter((span) => span.name === 'invoke_agent opencode');
    expect(runs.map((span) => attributesOf(span)['gen_ai.conversation.id'])).toEqual(['ses_send_0001', 'ses_send_0001']);
    const call = ingest.spans().find((span) => span.name === 'chat claude-sonnet-4-5')!;
    expect(attributesOf(call)['gen_ai.usage.input_tokens']).toBe(4_700);
    expect(logged).toEqual([]);
  });

  it('logs a turn the platform refused, naming why and nothing else', async () => {
    ingest.status = 403;
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^Telmoni did not take all of the turn: .*403/);
    expect(logged[0]).not.toContain('telmoni_test');
  });

  it('passes over a turn the SDK refuses, sending nothing', async () => {
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), end: at(-1) });
    expect(ingest.received).toEqual([]);
    expect(logged).toEqual(['turn refused by the SDK: RangeError']);
  });

  it('cuts a turn larger than the SDK queues to its earliest calls, its run kept, and says so', async () => {
    const calls = Array.from({ length: 3_000 }, (_, index): ToolCallRecord => ({ type: 'tool_call', name: 'glob', start: at(index), end: at(index + 1) }));
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    expect(await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), inside: calls })).toBe(true);
    const spans = ingest.spans();
    expect(spans).toHaveLength(2_048);
    expect(spans.filter((span) => span.name === 'invoke_agent opencode')).toHaveLength(1);
    expect(logged).toEqual(['turn cut to the 2046 calls the SDK sends of it, the earliest; 954 left out']);
  });
});

describe('a turn fitted to the SDK', () => {
  const call = (index: number): ToolCallRecord => ({ type: 'tool_call', name: 'glob', start: at(index), end: at(index + 1) });
  const run = (inside: RunRecord['inside']): RunRecord => ({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), inside });

  it('is the turn itself where it fits', () => {
    const whole = run([call(0), { type: 'step', name: 'subagent explore', start: at(1), end: at(5), calls: [call(2), call(3)] }]);
    expect(fitted(whole, 6)).toEqual({ record: whole, left: 0 });
  });

  it('keeps its earliest calls, a step cut to the calls of it that fit', () => {
    const step: StepRecord = { type: 'step', name: 'subagent explore', start: at(1), end: at(9), calls: [call(2), call(3), call(4)] };
    const { record, left } = fitted(run([call(0), step, call(10)]), 6);
    expect(record.inside).toEqual([call(0), { ...step, calls: [call(2), call(3)] }]);
    expect(left).toBe(2);
  });
});

describe('the outbox', () => {
  const outbox = (keep?: number): Outbox =>
    new Outbox({
      sender: (log) => new Sender({ endpoint, apiKey: 'telmoni_test' }, log),
      log: (line) => void logged.push(line),
      ...(keep === undefined ? {} : { keep }),
    });
  const runIdsSent = (): unknown[] =>
    ingest.spans().filter((span) => span.name === 'invoke_agent opencode').map((span) => attributesOf(span)['telmoni.run_id']);

  it('keeps a turn the SDK gave up sending, and sends it again, oldest first, as the next turn ends', async () => {
    const box = outbox();
    ingest.status = 503;
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    await box.flush();
    expect(box.waiting).toBe(1);
    expect(logged).toEqual([expect.stringMatching(/^ses_send_000: not sent; kept to send again: telmoni: export failed after 3 attempts \(503/)]);
    ingest.status = 200;
    box.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    await box.flush();
    expect(box.waiting).toBe(0);
    expect(runIdsSent()).toEqual([
      ...Array<string>(3).fill('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'),
      '3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d',
      '4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e',
    ]);
    // Every copy is the same bytes, which ingest stores once.
    expect(new Set(ingest.received.slice(0, 4).map((request) => request.body)).size).toBe(1);
    expect(ingest.stored).toBe(2);
  });

  it(
    'keeps a turn while Telmoni is down, and sends it once it is back, stored once',
    async () => {
      const port = Number(new URL(endpoint).port);
      await ingest.stop();
      const box = outbox();
      box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
      await box.flush();
      expect(box.waiting).toBe(1);
      expect(logged).toEqual([expect.stringMatching(/kept to send again: telmoni: export failed after 3 attempts \(TypeError\)/)]);
      ingest = new FakeIngest();
      await ingest.start(port);
      box.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
      await box.flush();
      expect(box.waiting).toBe(0);
      expect(runIdsSent()).toEqual(['3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d', '4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e']);
      expect(ingest.stored).toBe(2);
    },
    20_000,
  );

  it('passes over a turn Telmoni answered and refused, holding back none after it', async () => {
    const box = outbox();
    ingest.status = 403;
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    await box.flush();
    expect(box.waiting).toBe(0);
    ingest.status = 400;
    box.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    await box.flush();
    expect(box.waiting).toBe(0);
    ingest.status = 200;
    box.send(turn('5f8a0c3e-7d4a-4b9c-9e2f-0a3b4c5d6e7f'));
    await box.flush();
    // Each sent once: a refusal is the same whenever it is asked again.
    expect(runIdsSent()).toEqual([
      '3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d',
      '4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e',
      '5f8a0c3e-7d4a-4b9c-9e2f-0a3b4c5d6e7f',
    ]);
    expect(logged).toEqual([
      'ses_send_000: Telmoni did not take all of the turn: telmoni: export refused with 403 /errors/authz/forbidden; the batch was dropped',
      'ses_send_000: Telmoni did not take all of the turn: telmoni: export refused with 400 /errors/authz/forbidden; the batch was dropped',
    ]);
  });

  it('passes over a turn Telmoni took but for a span, which it would answer the same way for the hour', async () => {
    const box = outbox();
    ingest.partial = 'span 5b8aa5a2d2c872e8 refused: name over its cap';
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    await box.flush();
    expect(box.waiting).toBe(0);
    ingest.partial = undefined;
    box.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    await box.flush();
    expect(runIdsSent()).toEqual(['3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d', '4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e']);
    expect(logged).toEqual(['ses_send_000: Telmoni did not take all of the turn: telmoni: the server refused a span: name over its cap']);
  });

  it('asks a Telmoni that does not answer once a round, about its oldest turn, not once a turn', async () => {
    const box = outbox();
    ingest.status = 503;
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    await box.flush();
    box.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    await box.flush();
    expect(box.waiting).toBe(2);
    // Two rounds, each the SDK's three attempts at the oldest turn alone.
    expect(runIdsSent()).toEqual(Array<string>(6).fill('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
  });

  it('sends one turn at a time, however many end together', async () => {
    const box = outbox();
    ingest.delayMs = 100;
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    box.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    box.send(turn('5f8a0c3e-7d4a-4b9c-9e2f-0a3b4c5d6e7f'));
    await box.flush();
    expect(runIdsSent()).toHaveLength(3);
    expect(ingest.busiest).toBe(1);
  });

  it('keeps the newest turns past its bound, and says how many it dropped', async () => {
    const box = outbox(2);
    ingest.status = 503;
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    box.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    box.send(turn('5f8a0c3e-7d4a-4b9c-9e2f-0a3b4c5d6e7f'));
    await box.flush();
    expect(box.waiting).toBe(2);
    expect(logged.filter((line) => line.startsWith('dropped 1 turn Telmoni had not taken'))).toHaveLength(1);
  });

  it('sends what waits as OpenCode shuts down', async () => {
    const box = outbox();
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    await box.drain();
    expect(runIdsSent()).toEqual(['3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d']);
  });

  it('lets OpenCode go at its cap when Telmoni does not answer', async () => {
    const box = new Outbox({
      sender: () => ({ send: () => new Promise<boolean>(() => undefined), close: () => Promise.resolve() }),
      log: (line) => void logged.push(line),
    });
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    const started = Date.now();
    await box.drain(Promise.resolve(), 200);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('connecting', () => {
  it('gives a sender where there is a key, and nothing, said once in the log, where there is none', () => {
    const home = tempDir();
    try {
      const env = { HOME: home.path, XDG_STATE_HOME: join(home.path, 'state') };
      expect(connect(1, { ...env, TELMONI_API_KEY: 'telmoni_test', TELMONI_ENDPOINT: endpoint })?.outbox).toBeInstanceOf(Outbox);
      expect(connect(2, env)).toBeUndefined();
      const log = readFileSync(join(home.path, 'state', 'telmoni', 'opencode', 'plugin.log'), 'utf8').trim().split('\n');
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/^\S+ opencode 2: no key: set TELMONI_API_KEY, or apiKey in telmoni\.json/);
    } finally {
      home.remove();
    }
  });

  it('gives nothing where the endpoint is no URL to send to, said once, and never logs it', () => {
    const home = tempDir();
    try {
      const env = { HOME: home.path, XDG_STATE_HOME: join(home.path, 'state') };
      for (const bad of ['api.telmoni.example', 'ftp://ingest.example', 'https://']) {
        expect(connect(2, { ...env, TELMONI_API_KEY: 'telmoni_test', TELMONI_ENDPOINT: bad })).toBeUndefined();
      }
      const log = readFileSync(join(home.path, 'state', 'telmoni', 'opencode', 'plugin.log'), 'utf8').trim().split('\n');
      expect(log).toHaveLength(3);
      for (const line of log) expect(line).toMatch(/opencode 2: endpoint is no http or https URL; nothing is sent$/);
      expect(log.join('\n')).not.toContain('example');
    } finally {
      home.remove();
    }
  });

  it('gives nothing where the endpoint would carry the key in the clear, and never logs the endpoint or the key', () => {
    const home = tempDir();
    try {
      const env = { HOME: home.path, XDG_STATE_HOME: join(home.path, 'state') };
      expect(connect(1, { ...env, TELMONI_API_KEY: 'telmoni_test', TELMONI_ENDPOINT: 'http://ingest.example' })).toBeUndefined();
      const log = readFileSync(join(home.path, 'state', 'telmoni', 'opencode', 'plugin.log'), 'utf8');
      expect(log).toMatch(/opencode 1: endpoint refused by the SDK: TypeError; nothing is sent/);
      expect(log).not.toContain('ingest.example');
      expect(log).not.toContain('telmoni_test');
    } finally {
      home.remove();
    }
  });
});
