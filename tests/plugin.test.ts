/**
 * The built plugin, loaded as each OpenCode major's loader loads it, sending
 * through the SDK bundled inside it to a fake ingest.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { V1Client, V1Hooks, V2Cleanup, V2Context } from '../src/opencode';
import { runIdOf } from '../src/record';
import { SHUTDOWN_WAIT_MS } from '../src/send';
import {
  FakeIngest,
  T0,
  type V1Fixture,
  attributesOf,
  fakeClient,
  fakeContext,
  shifted,
  tempDir,
  until,
  v1Fixture,
  v2Fixture,
} from './helpers';

const PLUGIN = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));

interface Definition {
  id?: unknown;
  setup?: unknown;
  server?: unknown;
  tui?: unknown;
}

async function definition(): Promise<{ module: Record<string, unknown>; value: Definition }> {
  expect(existsSync(PLUGIN), 'build the plugin first: npm run build').toBe(true);
  const module = (await import(pathToFileURL(PLUGIN).href)) as Record<string, unknown>;
  return { module, value: module['default'] as Definition };
}

/**
 * As OpenCode 1.19 loads a plugin: a default export that is an object with
 * an `id` and a `server` function, and no `tui`, is called as `server(input,
 * options)`; named exports are not looked at.
 */
async function asOpenCode1(input: unknown): Promise<V1Hooks> {
  const { module, value } = await definition();
  expect(value !== null && typeof value === 'object').toBe(true);
  expect(typeof value.id === 'string' && value.id.trim() !== '').toBe(true);
  expect(typeof value.server).toBe('function');
  expect(value.tui).toBeUndefined();
  expect(Object.keys(module)).toEqual(['default']);
  return (value.server as (input: unknown, options: unknown) => Promise<V1Hooks>)(input, undefined);
}

/** As OpenCode 2.0.27 loads a plugin: a default definition with a string `id` and a `setup` function, called with the context. */
async function asOpenCode2(context: unknown): Promise<V2Cleanup | void> {
  const { value } = await definition();
  expect(typeof value.id).toBe('string');
  expect(typeof value.setup).toBe('function');
  return (value.setup as (context: unknown) => Promise<V2Cleanup | void>)(context);
}

const ENV = ['HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'TELMONI_API_KEY', 'TELMONI_ENDPOINT'];

let saved: Record<string, string | undefined>;
let home: { path: string; remove: () => void };
let ingest: FakeIngest;
let endpoint: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  home = tempDir();
  ingest = new FakeIngest();
  endpoint = await ingest.start();
  // A home of the test's own: no key file of the person's is ever read.
  process.env['HOME'] = home.path;
  process.env['XDG_STATE_HOME'] = join(home.path, 'state');
  process.env['XDG_CONFIG_HOME'] = join(home.path, 'config');
  delete process.env['OPENCODE_CONFIG_DIR'];
  process.env['TELMONI_API_KEY'] = 'telmoni_test';
  process.env['TELMONI_ENDPOINT'] = endpoint;
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await ingest.stop();
  home.remove();
});

const logPath = (): string => join(home.path, 'state', 'telmoni', 'opencode', 'plugin.log');

/** The fixture's times moved to now, as if it were happening as the test runs. */
const now = <T>(fixture: T): T => shifted(fixture, Date.now() - T0);

/**
 * An OpenCode 1 fixture moved to now in place, once the plugin is loaded and
 * just before its events are replayed: the plugin reads a session's going
 * busy by its own clock, and a slow first import must not age the turn.
 */
const happening = (fixture: V1Fixture): void => void Object.assign(fixture, now(fixture));

const runs = (): number => ingest.spans().filter((span) => span.name === 'invoke_agent opencode').length;

describe('the plugin, as OpenCode 1 loads it', () => {
  it('is called as a server plugin, and sends each turn through the SDK to ingest', async () => {
    const fixture = v1Fixture('turn');
    const hooks = await asOpenCode1({
      client: fakeClient(fixture),
      project: { id: 'prj_v1_0001', worktree: '/work/…' },
      directory: '/work/…',
      worktree: '/work/…',
      serverUrl: new URL('http://localhost:4096'),
      $: undefined,
    });
    happening(fixture);
    for (const event of fixture.events) await hooks.event!({ event });
    expect(await until(() => runs() === 1, 10_000)).toBe(true);
    const spans = ingest.spans();
    const run = spans.find((span) => span.name === 'invoke_agent opencode')!;
    expect(attributesOf(run)['gen_ai.conversation.id']).toBe('ses_v1_root_0001');
    expect(attributesOf(run)['telmoni.run_id']).toBe(runIdOf('ses_v1_root_0001', 'msg_v1_u_0001'));
    expect(run.traceId).toBe(runIdOf('ses_v1_root_0001', 'msg_v1_u_0001').replaceAll('-', ''));
    expect(spans.filter((span) => span.name === 'chat claude-sonnet-4-5')).toHaveLength(3);
    expect(spans.filter((span) => span.name.startsWith('execute_tool ')).map((span) => span.name).sort()).toEqual(
      ['bash', 'edit', 'glob', 'grep', 'read'].map((name) => `execute_tool ${name}`),
    );
    expect(ingest.received[0]!.headers['authorization']).toBe('Bearer telmoni_test');
    const bodies = ingest.received.map((request) => request.body).join('');
    expect(bodies).not.toContain('…');
    expect(bodies).not.toContain('/work');
    await hooks.dispose!();
    expect(existsSync(logPath())).toBe(false);
  }, 20_000);

  it('is set up as a definition too, as OpenCode 1.19 does through its own host, and stays out of it there', async () => {
    const fixture = v1Fixture('turn');
    const hooks = await asOpenCode1({ client: fakeClient(fixture) });
    // What OpenCode 1.19.0 hands `setup`, seen live: no event stream among it.
    const host = Object.fromEntries(
      ['agent', 'aisdk', 'catalog', 'command', 'integration', 'options', 'plugin', 'reference', 'skill'].map((key) => [key, {}]),
    );
    expect(await asOpenCode2(host)).toBeUndefined();
    happening(fixture);
    for (const event of fixture.events) await hooks.event!({ event });
    expect(await until(() => runs() === 1, 10_000)).toBe(true);
    await hooks.dispose!();
    expect(runs()).toBe(1);
    expect(existsSync(logPath())).toBe(false);
  }, 20_000);

  it('sends a turn it is still reading as OpenCode shuts down, as a one-shot run does as its turn ends', async () => {
    const fixture = v1Fixture('turn');
    const client = fakeClient(fixture);
    let answer = (): void => undefined;
    const reading = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const held: V1Client = {
      session: {
        get: (options) => client.session.get(options),
        messages: async (options) => {
          await reading;
          return client.session.messages(options);
        },
      },
    };
    const hooks = await asOpenCode1({ client: held });
    happening(fixture);
    for (const event of fixture.events) await hooks.event!({ event });
    const disposed = hooks.dispose!();
    answer();
    await disposed;
    expect(runs()).toBe(1);
  });
});

describe('the plugin, as OpenCode 2 loads it', () => {
  it('is set up as a plugin definition, and sends each turn through the SDK to ingest, its key read from telmoni.json', async () => {
    delete process.env['TELMONI_API_KEY'];
    delete process.env['TELMONI_ENDPOINT'];
    const config = join(home.path, 'config', 'opencode');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'telmoni.json'), JSON.stringify({ apiKey: 'telmoni_file', endpoint }));
    chmodSync(join(config, 'telmoni.json'), 0o600);
    const context = fakeContext(now(v2Fixture('subagent')).events);
    const cleanup = await asOpenCode2(context);
    expect(typeof cleanup).toBe('function');
    expect(await until(() => runs() === 1, 10_000)).toBe(true);
    expect(ingest.received[0]!.headers['authorization']).toBe('Bearer telmoni_file');
    const spans = ingest.spans();
    const run = spans.find((span) => span.name === 'invoke_agent opencode')!;
    expect(attributesOf(run)['telmoni.run_id']).toBe(runIdOf('ses_v2_root_0002', 'msg_v2_u_0101'));
    const step = spans.find((span) => span.name === 'subagent explore')!;
    expect(spans.filter((span) => span.parentSpanId === step.spanId).map((span) => span.name).sort()).toEqual([
      'chat claude-haiku-4-5',
      'chat claude-haiku-4-5',
      'execute_tool grep',
    ]);
    expect(ingest.received.map((request) => request.body).join('')).not.toContain('…');
    await (cleanup as V2Cleanup)();
    expect(await until(() => context.closed(), 2_000)).toBe(true);
    // Nothing written beside OpenCode's configuration, which OpenCode 2 reloads on every write there.
    expect(readdirSync(config)).toEqual(['telmoni.json']);
    expect(existsSync(logPath())).toBe(false);
  }, 20_000);

  it('loaded twice, under both `plugin` and `plugins`, sends the same turn as the same bytes, which ingest answers once', async () => {
    const events = now(v2Fixture('turn')).events;
    const cleanups = [await asOpenCode2(fakeContext(events)), await asOpenCode2(fakeContext(events))];
    expect(await until(() => ingest.received.length === 2, 10_000)).toBe(true);
    expect(ingest.received[0]!.body).toBe(ingest.received[1]!.body);
    for (const cleanup of cleanups) await (cleanup as V2Cleanup)();
  }, 20_000);

  it('says so in its log where OpenCode’s event stream ends while it is loaded', async () => {
    const context: V2Context = { event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) } };
    const cleanup = await asOpenCode2(context);
    expect(await until(() => existsSync(logPath()), 2_000)).toBe(true);
    expect(readFileSync(logPath(), 'utf8').trim().split('\n').map((line) => line.replace(/^\S+ /, ''))).toEqual(['opencode 2: event stream ended']);
    await (cleanup as V2Cleanup)();
  });
});

describe('the plugin, either way', () => {
  it('with no key, sends nothing, and says so once each time it is loaded', async () => {
    delete process.env['TELMONI_API_KEY'];
    expect(await asOpenCode1({ client: fakeClient(v1Fixture('turn')) })).toEqual({});
    let followed = false;
    const events = fakeContext(v2Fixture('turn').events).event!;
    const context: V2Context = {
      event: {
        subscribe: (options) => {
          followed = true;
          return events.subscribe(options);
        },
      },
    };
    expect(await asOpenCode2(context)).toBeUndefined();
    expect(followed).toBe(false);
    expect(ingest.received).toEqual([]);
    const lines = readFileSync(logPath(), 'utf8').trim().split('\n').map((line) => line.replace(/^\S+ /, ''));
    const advice = 'no key: set TELMONI_API_KEY, or apiKey in telmoni.json beside your OpenCode configuration; nothing is sent until then';
    expect(lines).toEqual([`opencode 1: ${advice}`, `opencode 2: ${advice}`]);
  });

  it('never throws into OpenCode and never waits on Telmoni but as it shuts down, however slow it answers or whatever it is handed', async () => {
    ingest.delayMs = 2_000;
    const v1 = v1Fixture('turn');
    const hooks = await asOpenCode1({ client: fakeClient(v1) });
    for (const input of [undefined, null, 42, 'event', { event: null }, { event: { type: 'session.status', properties: 'busy' } }]) {
      await expect(hooks.event!(input as never)).resolves.toBeUndefined();
    }
    happening(v1);
    let slowest = 0;
    for (const event of v1.events) {
      const started = performance.now();
      await hooks.event!({ event });
      slowest = Math.max(slowest, performance.now() - started);
    }
    const garbage = [null, 42, 'event', { type: 'session.step.started', data: 'x' }];
    const context = fakeContext([...(garbage as never[]), ...now(v2Fixture('turn')).events]) as V2Context & { closed: () => boolean };
    let started = performance.now();
    const cleanup = await asOpenCode2(context);
    slowest = Math.max(slowest, performance.now() - started);
    expect(await until(() => ingest.received.length === 2, 10_000)).toBe(true);
    // Every hook OpenCode waits on while it works returned long before ingest answered anything.
    expect(slowest).toBeLessThan(500);
    expect(ingest.answered).toBe(0);
    // At shutdown alone it waits for what is still to send — a one-shot run
    // exits as its turn ends — and never past its cap.
    started = performance.now();
    await hooks.dispose!();
    await (cleanup as V2Cleanup)();
    expect(performance.now() - started).toBeLessThan(2 * SHUTDOWN_WAIT_MS);
    expect(await until(() => ingest.answered === 2, 5_000)).toBe(true);
    expect(runs()).toBe(2);
  }, 25_000);
});
