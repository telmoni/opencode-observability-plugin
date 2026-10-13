import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Outbox, Sender, connect } from '../src/send';
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
    expect(logged[0]).toMatch(/^not sent: .*403/);
    expect(logged[0]).not.toContain('telmoni_test');
  });

  it('passes over a turn the SDK refuses, sending nothing', async () => {
    const sender = new Sender({ endpoint, apiKey: 'telmoni_test' }, (line) => void logged.push(line));
    await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), end: at(-1) });
    expect(ingest.received).toEqual([]);
    expect(logged).toEqual(['turn refused by the SDK: RangeError']);
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

  it('keeps a turn the platform did not take, and sends it again, oldest first, as the next turn ends', async () => {
    const box = outbox();
    ingest.status = 403;
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    await box.flush();
    expect(box.waiting).toBe(1);
    ingest.status = 200;
    box.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    await box.flush();
    expect(box.waiting).toBe(0);
    expect(runIdsSent()).toEqual([
      '3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d',
      '3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d',
      '4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e',
    ]);
    // The refused copy and the one taken are the same bytes, which ingest answers once.
    expect(ingest.received[0]!.body).toBe(ingest.received[1]!.body);
  });

  it('keeps the newest turns past its bound, and says how many it dropped', async () => {
    const box = outbox(2);
    ingest.status = 403;
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
