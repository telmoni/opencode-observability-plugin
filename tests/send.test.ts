import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRecord, StepRecord, ToolCallRecord } from 'telmoni';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Outbox, Sender, connect, flushSecondsOf } from '../src/send';
import { FakeIngest, at, attributesOf, tempDir, until } from './helpers';

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
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    await sender.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    expect(ingest.received).toHaveLength(2);
    for (const request of ingest.received) {
      expect(request.url).toBe('/otlp/v1/traces');
      expect(request.headers['authorization']).toBe('Bearer tm_test');
    }
    const runs = ingest.spans().filter((span) => span.name === 'invoke_agent opencode');
    expect(runs.map((span) => attributesOf(span)['gen_ai.conversation.id'])).toEqual(['ses_send_0001', 'ses_send_0001']);
    const call = ingest.spans().find((span) => span.name === 'chat claude-sonnet-4-5')!;
    expect(attributesOf(call)['gen_ai.usage.input_tokens']).toBe(4_700);
    expect(logged).toEqual([]);
  });

  it('passes over a turn refused for good, its key among it, and keeps one that may yet go, naming why and nothing else', async () => {
    for (const status of [400, 401, 402, 403, 413, 500, 404]) {
      ingest.status = status;
      const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
      try {
        expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(status !== 404);
      } finally {
        await sender.close();
      }
    }
    expect(logged.map((line) => line.slice(0, line.indexOf(' /')))).toEqual([
      ...[400, 401, 402, 403, 413, 500].map((status) => `refused, not sent again: telmoni: export refused with ${status}`),
      'not sent; kept to send again: telmoni: export refused with 404',
    ]);
    for (const line of logged) expect(line).not.toContain('tm_test');
  });

  it('keeps a turn ingest refused for a fault of its database, which a later round may find mended', async () => {
    ingest.status = 500;
    ingest.type = '/errors/internal/database';
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(false);
    } finally {
      await sender.close();
    }
    expect(logged).toEqual(['not sent; kept to send again: telmoni: export refused with 500 /errors/internal/database; the batch was dropped']);
  });

  it('counts a turn the SDK sent less a field it could not take as taken, rather than hold back every turn after it', async () => {
    const call = { type: 'model_call' as const, model: 'claude-sonnet-4-5', provider: 'anthropic', start: at(0), end: at(4_000), usage: { inputTokens: -1 } };
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    try {
      expect(await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), inside: [call] })).toBe(true);
    } finally {
      await sender.close();
    }
    expect(ingest.received).toHaveLength(1);
    expect(logged).toEqual(['taken in part: telmoni: gen_ai.usage.input_tokens must be a whole number from 0 within 64 bits; the call is sent without it']);
  });

  it('passes over a turn the SDK refuses, sending nothing', async () => {
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), end: at(-1) });
    expect(ingest.received).toEqual([]);
    expect(logged).toEqual(['turn refused by the SDK: RangeError']);
  });

  it('sends a turn whole, past the 2,048 spans the SDK queues by default', async () => {
    const calls = Array.from({ length: 3_000 }, (_, index): ToolCallRecord => ({ type: 'tool_call', name: 'glob', start: at(index), end: at(index + 1) }));
    const sender = new Sender({ endpoint, apiKey: 'tm_test' }, (line) => void logged.push(line));
    expect(await sender.send({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), inside: calls })).toBe(true);
    const spans = ingest.spans();
    expect(spans).toHaveLength(3_001);
    expect(spans.filter((span) => span.name === 'invoke_agent opencode')).toHaveLength(1);
    expect(spans.filter((span) => span.name === 'execute_tool glob')).toHaveLength(3_000);
    expect(logged).toEqual([]);
  });
});

describe('a turn’s flush', () => {
  const calls = (count: number): ToolCallRecord[] =>
    Array.from({ length: count }, (_, index) => ({ type: 'tool_call', name: 'glob', start: at(index), end: at(index + 1) }));
  const run = (inside: RunRecord['inside']): RunRecord => ({ ...turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'), inside });

  it('waits out the SDK’s worst case for each export of 512 spans, and half a minute more', () => {
    expect(flushSecondsOf(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'))).toBe(180);
    expect(flushSecondsOf(run(calls(510)))).toBe(180);
    expect(flushSecondsOf(run(calls(511)))).toBe(330);
    const step = (count: number): StepRecord => ({ type: 'step', name: 'subagent explore', start: at(0), end: at(count), calls: calls(count) });
    expect(flushSecondsOf(run([step(1_021)]))).toBe(330);
    expect(flushSecondsOf(run([step(1_022)]))).toBe(480);
  });
});

describe('the outbox', () => {
  const outbox = (keep?: number): Outbox =>
    new Outbox({
      sender: (log) => new Sender({ endpoint, apiKey: 'tm_test' }, log),
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
      expect(logged).toEqual([expect.stringMatching(/kept to send again: telmoni: export failed after 3 attempts \(Error\)/)]);
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

  it('passes over a turn refused for good, holding back none after it, and keeps one that may yet go', async () => {
    const box = outbox();
    ingest.status = 400;
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    await box.flush();
    expect(box.waiting).toBe(0);
    ingest.status = 404;
    box.send(turn('4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e'));
    await box.flush();
    expect(box.waiting).toBe(1);
    ingest.status = 200;
    box.send(turn('5f8a0c3e-7d4a-4b9c-9e2f-0a3b4c5d6e7f'));
    await box.flush();
    expect(box.waiting).toBe(0);
    // The one refused for good is never asked again; the one that may yet go goes again, oldest first.
    expect(runIdsSent()).toEqual([
      '3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d',
      '4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e',
      '4e7f9b2d-6c3f-4a8b-8d1e-9f2a3b4c5d6e',
      '5f8a0c3e-7d4a-4b9c-9e2f-0a3b4c5d6e7f',
    ]);
    expect(logged).toEqual([
      'ses_send_000: refused, not sent again: telmoni: export refused with 400 /errors/authz/forbidden; the batch was dropped',
      'ses_send_000: not sent; kept to send again: telmoni: export refused with 404 /errors/authz/forbidden; the batch was dropped',
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
    expect(logged).toEqual(['ses_send_000: taken in part: telmoni: the server refused a span: name over its cap']);
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

  it('tries a turn still waiting again on its own, though no turn ends, until it goes', async () => {
    const answers = [false, false, true];
    const tried: string[] = [];
    const box = new Outbox({
      sender: () => ({ send: async (record) => (tried.push(record.runId), answers.shift() ?? true), close: () => Promise.resolve() }),
      log: (line) => void logged.push(line),
      retryMs: 20,
    });
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    expect(await until(() => box.waiting === 0, 2_000)).toBe(true);
    expect(tried).toEqual(Array<string>(3).fill('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    // Nothing waits, so nothing more is tried.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tried).toHaveLength(3);
  });

  it('tries nothing on its own once OpenCode shuts the plugin down', async () => {
    let tries = 0;
    const box = new Outbox({
      sender: () => ({ send: async () => (tries++, false), close: () => Promise.resolve() }),
      log: (line) => void logged.push(line),
      retryMs: 100,
    });
    box.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
    // A round has failed, and the next is on its way.
    await box.flush();
    await box.drain();
    const drained = tries;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(tries).toBe(drained);
    expect(box.waiting).toBe(1);
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
      expect(connect(1, { ...env, TELMONI_API_KEY: 'tm_test', TELMONI_ENDPOINT: endpoint })?.outbox).toBeInstanceOf(Outbox);
      expect(connect(2, env)).toBeUndefined();
      const log = readFileSync(join(home.path, 'state', 'telmoni', 'opencode', 'plugin.log'), 'utf8').trim().split('\n');
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/^\S+ opencode 2: no key: set TELMONI_API_KEY, or apiKey in telmoni\.json/);
    } finally {
      home.remove();
    }
  });

  it.skipIf(process.platform === 'win32')('says why a key file was passed over, by kind, and never what is in it', () => {
    const home = tempDir();
    try {
      const env = { HOME: home.path, XDG_STATE_HOME: join(home.path, 'state'), XDG_CONFIG_HOME: join(home.path, 'config') };
      const file = join(home.path, 'config', 'opencode', 'telmoni.json');
      mkdirSync(join(home.path, 'config', 'opencode'), { recursive: true });
      writeFileSync(file, '{ "apiKey": "tm_secret_0001", ');
      chmodSync(file, 0o600);
      expect(connect(1, env)).toBeUndefined();
      writeFileSync(file, JSON.stringify({ apiKey: 'tm_secret_0001', endpoint: 'https://elsewhere.example' }));
      chmodSync(file, 0o644);
      expect(connect(2, env)).toBeUndefined();
      const log = readFileSync(join(home.path, 'state', 'telmoni', 'opencode', 'plugin.log'), 'utf8');
      expect(log).toContain('opencode 1: key file not used: not JSON');
      expect(log).toContain('opencode 2: key file not used: open to other users; chmod 600 it');
      for (const secret of ['tm_secret_0001', 'elsewhere', home.path]) expect(log).not.toContain(secret);
    } finally {
      home.remove();
    }
  });

  it.skipIf(process.platform === 'win32')('gives nothing past a key file it passed over, though the key is in the environment', () => {
    const home = tempDir();
    try {
      const env = { HOME: home.path, XDG_STATE_HOME: join(home.path, 'state'), XDG_CONFIG_HOME: join(home.path, 'config'), TELMONI_API_KEY: 'tm_env_0001' };
      const file = join(home.path, 'config', 'opencode', 'telmoni.json');
      mkdirSync(join(home.path, 'config', 'opencode'), { recursive: true });
      // Its endpoint a self-hosted one: the key must not go to the default instead.
      writeFileSync(file, JSON.stringify({ endpoint: 'https://self-hosted.example' }));
      chmodSync(file, 0o644);
      expect(connect(1, env)).toBeUndefined();
      const log = readFileSync(join(home.path, 'state', 'telmoni', 'opencode', 'plugin.log'), 'utf8');
      expect(log).toContain('opencode 1: key file not used: open to other users; chmod 600 it; fix it, or set both TELMONI_API_KEY and TELMONI_ENDPOINT; nothing is sent until then');
      for (const secret of ['tm_env_0001', 'self-hosted', home.path]) expect(log).not.toContain(secret);
    } finally {
      home.remove();
    }
  });

  it('takes an endpoint without its scheme as the SDK reads one, and sends to it', async () => {
    const home = tempDir();
    try {
      const env = { HOME: home.path, XDG_STATE_HOME: join(home.path, 'state'), TELMONI_API_KEY: 'tm_test' };
      expect(connect(2, { ...env, TELMONI_ENDPOINT: 'api.telmoni.example' })?.outbox).toBeInstanceOf(Outbox);
      const connection = connect(1, { ...env, TELMONI_ENDPOINT: endpoint.replace('http://', '') });
      connection?.outbox.send(turn('3d6f8a1c-5b2e-4f7a-9c0d-8e1f2a3b4c5d'));
      await connection?.outbox.flush();
      expect(ingest.received).toHaveLength(1);
      expect(existsSync(join(home.path, 'state', 'telmoni', 'opencode', 'plugin.log'))).toBe(false);
    } finally {
      home.remove();
    }
  });

  it('gives nothing where the SDK refuses the endpoint, and logs the SDK’s reason, which names no path, key or password', () => {
    const home = tempDir();
    try {
      const env = { HOME: home.path, XDG_STATE_HOME: join(home.path, 'state'), TELMONI_API_KEY: 'tm_test' };
      for (const bad of ['ftp://ingest.example/private', 'https://', 'https://someone:hunter2@ingest.example/private', 'http://ingest.example/private']) {
        expect(connect(2, { ...env, TELMONI_ENDPOINT: bad })).toBeUndefined();
      }
      const log = readFileSync(join(home.path, 'state', 'telmoni', 'opencode', 'plugin.log'), 'utf8').trim().split('\n').map((line) => line.replace(/^\S+ /, ''));
      const refused = 'opencode 2: endpoint refused by the SDK; nothing is sent:';
      expect(log).toEqual([
        `${refused} the endpoint must be an http:// or https:// URL`,
        `${refused} the endpoint must be an http:// or https:// URL`,
        `${refused} the endpoint must be an http:// or https:// URL`,
        `${refused} refusing to send the API key over unencrypted HTTP to 'ingest.example'; use HTTPS`,
      ]);
      for (const secret of ['private', 'someone', 'hunter2', 'tm_test']) expect(log.join('\n')).not.toContain(secret);
    } finally {
      home.remove();
    }
  });
});
