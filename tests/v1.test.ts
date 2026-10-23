import type { ModelCallRecord, RunRecord, StepRecord, ToolCallRecord } from 'telmoni';
import { describe, expect, it } from 'vitest';

import { AGENT, runIdOf } from '../src/record';
import { type V1Deps, V1Turns } from '../src/v1';
import { RECORD_KEYS, T0, type V1Fixture, at, fakeClient, keysOf, v1Fixture } from './helpers';

async function replay(
  fixture: V1Fixture | string,
  deps: Partial<V1Deps> = {},
): Promise<{ sent: RunRecord[]; logged: string[]; reads: Array<{ path: string; query?: unknown }> }> {
  const data = typeof fixture === 'string' ? v1Fixture(fixture) : fixture;
  const sent: RunRecord[] = [];
  const logged: string[] = [];
  const client = fakeClient(data);
  const turns = new V1Turns({
    client,
    send: (record) => void sent.push(record),
    log: (line) => void logged.push(line),
    now: () => T0,
    ...deps,
  });
  for (const event of data.events) turns.handle(event);
  await turns.settled();
  return { sent, logged, reads: client.reads };
}

function only(records: RunRecord[]): RunRecord {
  expect(records).toHaveLength(1);
  return records[0]!;
}

/** The fixture's replies' tokens, summed over their steps the conventions' way, independently of the plugin. */
function stepTotals(fixture: V1Fixture): Map<string, { input: number; output: number; read: number; write: number }> {
  const totals = new Map<string, { input: number; output: number; read: number; write: number }>();
  for (const session of Object.values(fixture.sessions)) {
    for (const message of session.messages) {
      for (const part of message.parts as Array<Record<string, any>>) {
        if (part['type'] !== 'step-finish') continue;
        const tokens = part['tokens'];
        const total = totals.get(String(message.info['id'])) ?? { input: 0, output: 0, read: 0, write: 0 };
        total.input += tokens.input + tokens.cache.read + tokens.cache.write;
        total.output += tokens.output + tokens.reasoning;
        total.read += tokens.cache.read;
        total.write += tokens.cache.write;
        totals.set(String(message.info['id']), total);
      }
    }
  }
  return totals;
}

const assistant = (id: string, sessionID: string, parentID: string, created: number, extra: Record<string, unknown> = {}) => ({
  id,
  sessionID,
  role: 'assistant',
  time: { created },
  parentID,
  modelID: 'claude-sonnet-4-5',
  providerID: 'anthropic',
  mode: 'build',
  agent: 'build',
  path: { cwd: '/work/…', root: '/work/…' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
});

const stepped = (messageID: string, sessionID: string) => [
  { id: `prt_${messageID}_s`, sessionID, messageID, type: 'step-start' },
  { id: `prt_${messageID}_t`, sessionID, messageID, type: 'text', text: '…' },
  {
    id: `prt_${messageID}_f`,
    sessionID,
    messageID,
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  },
];

const status = (sessionID: string, type: string) => ({ id: `evt_${sessionID}_${type}`, type: 'session.status', properties: { sessionID, status: { type } } });

const updated = (info: Record<string, unknown>) => ({
  id: `evt_${String(info['id'])}`,
  type: 'message.updated',
  properties: { sessionID: info['sessionID'], info },
});

/** A turn whose `task` call ran a subagent, which ran one of its own, and so on, `depth` sessions below the turn's. */
function chain(depth: number): V1Fixture {
  const events: V1Fixture['events'] = [];
  const sessions: V1Fixture['sessions'] = {};
  for (let level = 0; level <= depth; level++) {
    const id = `ses_chain_${level}`;
    const info = { id, ...(level === 0 ? {} : { parentID: `ses_chain_${level - 1}` }), title: '…' };
    const parts: unknown[] = stepped(`msg_chain_${level}_a`, id);
    if (level < depth) {
      parts.push({
        id: `prt_chain_${level}_task`,
        sessionID: id,
        messageID: `msg_chain_${level}_a`,
        type: 'tool',
        callID: `call_chain_${level}`,
        tool: 'task',
        state: {
          status: 'completed',
          input: { description: '…', prompt: '…', subagent_type: 'general' },
          output: '…',
          title: '…',
          metadata: { sessionId: `ses_chain_${level + 1}` },
          time: { start: at((level + 1) * 1_000), end: at(30_000 - level * 1_000) },
        },
      });
    }
    sessions[id] = {
      info,
      messages: [
        { info: { id: `msg_chain_${level}_u`, sessionID: id, role: 'user', time: { created: at(level * 1_000 + 50) }, agent: 'general' }, parts: [] },
        {
          info: {
            ...assistant(`msg_chain_${level}_a`, id, `msg_chain_${level}_u`, at(level * 1_000 + 100)),
            agent: 'general',
            time: { created: at(level * 1_000 + 100), completed: at(30_000 - level * 1_000) },
          },
          parts,
        },
      ],
    };
    events.push({ id: `evt_chain_${level}`, type: 'session.created', properties: { sessionID: id, info } });
  }
  events.push(status('ses_chain_0', 'busy'), updated(assistant('msg_chain_0_a', 'ses_chain_0', 'msg_chain_0_u', at(100))), status('ses_chain_0', 'idle'));
  return { events, sessions };
}

describe('a turn of OpenCode 1', () => {
  it('is one run of opencode in the session, named by the prompt it answers, from the prompt to its last reply', async () => {
    const run = only((await replay('turn')).sent);
    expect(run.agent).toBe(AGENT);
    expect(run.sessionId).toBe('ses_v1_root_0001');
    expect(run.runId).toBe(runIdOf('ses_v1_root_0001', 'msg_v1_u_0001'));
    expect(run.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([run.start, run.end]).toEqual([at(0), at(15_000)]);
    expect(run.errorType).toBeUndefined();
    expect(run.cancelled).toBeUndefined();
  });

  it('has a model call per reply, from its request to the end of its answer, its steps’ tokens summed the conventions’ way', async () => {
    const fixture = v1Fixture('turn');
    const run = only((await replay(fixture)).sent);
    const calls = (run.inside ?? []).filter((item): item is ModelCallRecord => item.type === 'model_call');
    expect(calls.map((call) => [call.model, call.provider, call.start, call.end])).toEqual([
      ['claude-sonnet-4-5', 'anthropic', at(200), at(2_150)],
      ['claude-sonnet-4-5', 'anthropic', at(6_300), at(10_000)],
      ['claude-sonnet-4-5', 'anthropic', at(12_100), at(14_900)],
    ]);
    const totals = [...stepTotals(fixture).values()];
    expect(calls.map((call) => call.usage)).toEqual(
      totals.map((t) => ({ inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.read, cacheWriteInputTokens: t.write })),
    );
    // The second reply ran two steps: a reply's own count holds only the last.
    expect(calls[1]!.usage).toEqual({ inputTokens: 9_400, outputTokens: 90, cacheReadInputTokens: 8_800, cacheWriteInputTokens: 100 });
  });

  it('has a tool call per tool, timed by its state and failed where it errored', async () => {
    const run = only((await replay('turn')).sent);
    const tools = (run.inside ?? []).filter((item): item is ToolCallRecord => item.type === 'tool_call');
    expect(tools.map((tool) => [tool.name, tool.start, tool.end, tool.errorType, tool.cancelled])).toEqual([
      ['read', at(2_100), at(2_400), undefined, undefined],
      ['grep', at(2_150), at(2_600), undefined, undefined],
      ['bash', at(7_500), at(9_000), 'ToolError', undefined],
      ['edit', at(7_600), at(8_000), undefined, undefined],
      ['glob', at(9_600), at(9_900), undefined, undefined],
    ]);
    expect((run.inside ?? []).map((item) => item.type)).toEqual([
      'model_call',
      'tool_call',
      'tool_call',
      'model_call',
      'tool_call',
      'tool_call',
      'tool_call',
      'model_call',
    ]);
  });

  it('ends at session.status turning idle or at session.idle, whichever comes first, and is recorded once', async () => {
    const fixture = v1Fixture('turn');
    expect((await replay(fixture)).sent).toHaveLength(1);
    const idleOnly = { ...fixture, events: fixture.events.filter((event) => event.id !== 'evt_v1_0015') };
    const statusOnly = { ...fixture, events: fixture.events.filter((event) => event.type !== 'session.idle') };
    expect((await replay(idleOnly)).sent).toEqual((await replay(fixture)).sent);
    expect((await replay(statusOnly)).sent).toEqual((await replay(fixture)).sent);
  });

  it('is open while its session retries, so one the plugin came into then keeps the reply it was retrying', async () => {
    const fixture: V1Fixture = {
      events: [
        { id: 'evt_rt_retry', type: 'session.status', properties: { sessionID: 'ses_rt', status: { type: 'retry', attempt: 1, message: '…', next: at(3_000) } } },
        updated(assistant('msg_rt_a', 'ses_rt', 'msg_rt_u', at(-500))),
        status('ses_rt', 'busy'),
        status('ses_rt', 'idle'),
      ],
      sessions: {
        ses_rt: {
          info: { id: 'ses_rt', title: '…' },
          messages: [
            { info: { id: 'msg_rt_u', sessionID: 'ses_rt', role: 'user', time: { created: at(-1_000) } }, parts: [] },
            { info: { ...assistant('msg_rt_a', 'ses_rt', 'msg_rt_u', at(-500)), time: { created: at(-500), completed: at(4_000) } }, parts: stepped('msg_rt_a', 'ses_rt') },
          ],
        },
      },
    };
    expect(only((await replay(fixture)).sent).runId).toBe(runIdOf('ses_rt', 'msg_rt_u'));
  });

  it('has the same run id, and the same record, every time it is read', async () => {
    for (const name of ['turn', 'subagent', 'interrupted', 'failed']) {
      expect((await replay(name)).sent).toEqual((await replay(name)).sent);
    }
  });

  it('is read a page further back where it is longer than a page', async () => {
    const whole = await replay('turn');
    const paged = await replay('turn', { pageSize: 2 });
    expect(paged.sent).toEqual(whole.sent);
    expect(paged.reads.filter((read) => read.path.endsWith('/message')).length).toBeGreaterThan(1);
    expect(paged.reads.some((read) => (read.query as { before?: string } | undefined)?.before !== undefined)).toBe(true);
  });
});

describe('a subagent in OpenCode 1', () => {
  it('is a step named by its agent holding its calls, its own subagent’s calls beside the call that started it', async () => {
    const { sent, reads } = await replay('subagent');
    const run = only(sent);
    expect(run.runId).toBe(runIdOf('ses_v1_root_0002', 'msg_v1_u_0101'));
    expect([run.start, run.end]).toEqual([at(0), at(28_000)]);
    expect((run.inside ?? []).map((item) => (item.type === 'step' ? item.name : item.type))).toEqual([
      'model_call',
      'subagent explore',
      'model_call',
    ]);
    const step = (run.inside ?? []).find((item): item is StepRecord => item.type === 'step')!;
    expect([step.start, step.end]).toEqual([at(1_000), at(25_000)]);
    expect((step.calls ?? []).map((call) => [call.type, call.type === 'model_call' ? call.model : call.name, call.start, call.end])).toEqual([
      ['model_call', 'claude-haiku-4-5', at(1_200), at(7_050)],
      ['tool_call', 'grep', at(5_000), at(6_000)],
      ['tool_call', 'read', at(6_100), at(7_000)],
      ['tool_call', 'task', at(7_050), at(9_500)],
      ['model_call', 'gpt-5-mini', at(7_200), at(7_500)],
      ['tool_call', 'webfetch', at(7_500), at(8_500)],
      ['model_call', 'claude-haiku-4-5', at(12_100), at(23_900)],
    ]);
    const nested = (step.calls ?? []).find((call): call is ModelCallRecord => call.type === 'model_call' && call.model === 'gpt-5-mini')!;
    expect(nested.provider).toBe('openai');
    expect(nested.usage).toEqual({ inputTokens: 300, outputTokens: 50, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
    // Each subagent session read once, and no session asked after: their parents were named as they were created.
    expect(reads.map((read) => read.path)).toEqual([
      '/session/ses_v1_root_0002/message',
      '/session/ses_v1_kid_0001/message',
      '/session/ses_v1_kid_0002/message',
    ]);
  });

  it('run in the background holds what it did by the end of its parent’s turn, after its call had returned', async () => {
    const fixture: V1Fixture = {
      events: [
        status('ses_bg_root', 'busy'),
        updated(assistant('msg_bg_a1', 'ses_bg_root', 'msg_bg_u', at(100))),
        { id: 'evt_bg_kid', type: 'session.created', properties: { sessionID: 'ses_bg_kid', info: { id: 'ses_bg_kid', parentID: 'ses_bg_root', title: '…' } } },
        updated(assistant('msg_bg_a2', 'ses_bg_root', 'msg_bg_u', at(2_000))),
        status('ses_bg_root', 'idle'),
      ],
      sessions: {
        ses_bg_root: {
          info: { id: 'ses_bg_root', title: '…' },
          messages: [
            { info: { id: 'msg_bg_u', sessionID: 'ses_bg_root', role: 'user', time: { created: at(0) } }, parts: [] },
            {
              info: { ...assistant('msg_bg_a1', 'ses_bg_root', 'msg_bg_u', at(100)), time: { created: at(100), completed: at(1_000) } },
              parts: [
                ...stepped('msg_bg_a1', 'ses_bg_root'),
                {
                  id: 'prt_bg_task',
                  sessionID: 'ses_bg_root',
                  messageID: 'msg_bg_a1',
                  type: 'tool',
                  callID: 'call_bg',
                  tool: 'task',
                  state: {
                    status: 'completed',
                    input: { description: '…', prompt: '…', subagent_type: 'explore', background: true },
                    output: '…',
                    title: '…',
                    metadata: { parentSessionId: 'ses_bg_root', sessionId: 'ses_bg_kid', background: true },
                    time: { start: at(500), end: at(600) },
                  },
                },
              ],
            },
            {
              info: { ...assistant('msg_bg_a2', 'ses_bg_root', 'msg_bg_u', at(2_000)), time: { created: at(2_000), completed: at(9_000) } },
              parts: stepped('msg_bg_a2', 'ses_bg_root'),
            },
          ],
        },
        ses_bg_kid: {
          info: { id: 'ses_bg_kid', parentID: 'ses_bg_root', title: '…' },
          messages: [
            { info: { id: 'msg_bg_ku', sessionID: 'ses_bg_kid', role: 'user', time: { created: at(550) }, agent: 'explore' }, parts: [] },
            {
              info: { ...assistant('msg_bg_k1', 'ses_bg_kid', 'msg_bg_ku', at(700)), agent: 'explore', time: { created: at(700), completed: at(8_000) } },
              parts: stepped('msg_bg_k1', 'ses_bg_kid'),
            },
          ],
        },
      },
    };
    const run = only((await replay(fixture)).sent);
    const background = (run.inside ?? []).find((item): item is StepRecord => item.type === 'step')!;
    expect(background.name).toBe('subagent explore');
    expect((background.calls ?? []).map((call) => [call.start, call.end])).toEqual([[at(700), at(8_000)]]);
    expect([background.start, background.end]).toEqual([at(500), at(8_000)]);
  });

  it('is read back only as far as the call that took it up, however long its session', async () => {
    const before = Array.from({ length: 20 }, (_, index) => ({
      info: { id: `msg_long_old_${String(index).padStart(2, '0')}`, sessionID: 'ses_long_kid', role: index % 2 === 0 ? 'user' : 'assistant', time: { created: at(-200_000 + index * 1_000) } },
      parts: [],
    }));
    const fixture: V1Fixture = {
      events: [
        { id: 'evt_long_kid', type: 'session.created', properties: { sessionID: 'ses_long_kid', info: { id: 'ses_long_kid', parentID: 'ses_long', title: '…' } } },
        status('ses_long', 'busy'),
        updated(assistant('msg_long_a', 'ses_long', 'msg_long_u', at(100))),
        status('ses_long', 'idle'),
      ],
      sessions: {
        ses_long: {
          info: { id: 'ses_long', title: '…' },
          messages: [
            { info: { id: 'msg_long_u', sessionID: 'ses_long', role: 'user', time: { created: at(0) } }, parts: [] },
            {
              info: { ...assistant('msg_long_a', 'ses_long', 'msg_long_u', at(100)), time: { created: at(100), completed: at(5_000) } },
              parts: [
                ...stepped('msg_long_a', 'ses_long'),
                {
                  id: 'prt_long_task',
                  sessionID: 'ses_long',
                  messageID: 'msg_long_a',
                  type: 'tool',
                  callID: 'call_long',
                  tool: 'task',
                  state: { status: 'completed', input: {}, output: '…', title: '…', metadata: { sessionId: 'ses_long_kid' }, time: { start: at(1_000), end: at(4_000) } },
                },
              ],
            },
          ],
        },
        ses_long_kid: {
          info: { id: 'ses_long_kid', parentID: 'ses_long', title: '…' },
          messages: [
            ...before,
            { info: { id: 'msg_long_ku', sessionID: 'ses_long_kid', role: 'user', time: { created: at(1_050) }, agent: 'explore' }, parts: [] },
            {
              info: { ...assistant('msg_long_k1', 'ses_long_kid', 'msg_long_ku', at(1_100)), agent: 'explore', time: { created: at(1_100), completed: at(3_900) } },
              parts: stepped('msg_long_k1', 'ses_long_kid'),
            },
          ],
        },
      },
    };
    const { sent, reads } = await replay(fixture, { pageSize: 2 });
    const step = (only(sent).inside ?? []).find((item): item is StepRecord => item.type === 'step')!;
    expect((step.calls ?? []).map((call) => call.start)).toEqual([at(1_100)]);
    // Its newest page, then the one before, which reaches back past the call: no further.
    expect(reads.filter((read) => read.path === '/session/ses_long_kid/message')).toHaveLength(2);
  });

  it('is never a run of its own, even where its parent is learned only by reading its session', async () => {
    const fixture: V1Fixture = {
      events: [
        status('ses_kid', 'busy'),
        updated(assistant('msg_kid_a', 'ses_kid', 'msg_kid_u', at(100))),
        status('ses_kid', 'idle'),
      ],
      sessions: {
        ses_kid: {
          info: { id: 'ses_kid', parentID: 'ses_parent', title: '…', directory: '/work/…' },
          messages: [{ info: { ...assistant('msg_kid_a', 'ses_kid', 'msg_kid_u', at(100)) }, parts: stepped('msg_kid_a', 'ses_kid') }],
        },
      },
    };
    const { sent, reads } = await replay(fixture);
    expect(sent).toEqual([]);
    expect(reads.map((read) => read.path)).toEqual(['/session/ses_kid']);
  });

  it('is read four deep at most: a deeper subagent’s session is never read, and the call that ran it stands as a call', async () => {
    const { sent, reads } = await replay(chain(6));
    const step = (only(sent).inside ?? []).find((item): item is StepRecord => item.type === 'step')!;
    expect(step.name).toBe('subagent general');
    expect((step.calls ?? []).map((call) => [call.type === 'model_call' ? 'model' : call.name, call.start])).toEqual([
      ['model', at(1_100)],
      ['task', at(2_000)],
      ['model', at(2_100)],
      ['task', at(3_000)],
      ['model', at(3_100)],
      ['task', at(4_000)],
      ['model', at(4_100)],
      ['task', at(5_000)],
    ]);
    expect(reads.map((read) => read.path)).toEqual([0, 1, 2, 3, 4].map((level) => `/session/ses_chain_${level}/message`));
  });

  it('whose session cannot be read stands as the call that ran it, the log naming the read’s status alone', async () => {
    const fixture = chain(1);
    delete fixture.sessions['ses_chain_1'];
    const { sent, logged } = await replay(fixture);
    expect((only(sent).inside ?? []).map((item) => (item.type === 'tool_call' ? item.name : item.type))).toEqual(['model_call', 'task']);
    expect(logged).toEqual(['ses_chain_0: subagent not read: ReadError:404']);
  });
});

describe('an OpenCode 1 turn that did not end well', () => {
  it('is cancelled where the person interrupted it, its unanswered tools with it', async () => {
    const run = only((await replay('interrupted')).sent);
    expect(run.cancelled).toBe(true);
    expect(run.errorType).toBeUndefined();
    expect((run.inside ?? []).map((item) => [item.type === 'model_call' ? item.model : (item as ToolCallRecord).name, item.start, item.end, item.cancelled])).toEqual([
      ['claude-sonnet-4-5', at(200), at(1_600), true],
      ['bash', at(1_500), at(9_000), true],
      ['glob', at(1_600), at(9_000), true],
    ]);
    // No step finished, and the reply's own count is empty: no tokens are claimed.
    expect((run.inside![0] as ModelCallRecord).usage).toBeUndefined();
  });

  it('fails with the kind of its last reply’s error, never its message', async () => {
    const run = only((await replay('failed')).sent);
    expect(run.errorType).toBe('APIError');
    const calls = (run.inside ?? []).filter((item): item is ModelCallRecord => item.type === 'model_call');
    expect(calls.map((call) => [call.start, call.end, call.errorType])).toEqual([
      [at(100), at(1_000), undefined],
      [at(3_100), at(9_000), 'APIError'],
    ]);
    expect(calls[0]!.usage).toEqual({ inputTokens: 1_200, outputTokens: 30, cacheReadInputTokens: 0, cacheWriteInputTokens: 200 });
  });
});

describe('what is no turn in OpenCode 1', () => {
  it('a command the person ran in the shell: a reply with no step of the model in it', async () => {
    const fixture: V1Fixture = {
      events: [status('ses_sh', 'busy'), updated(assistant('msg_sh_a', 'ses_sh', 'msg_sh_u', at(100))), status('ses_sh', 'idle')],
      sessions: {
        ses_sh: {
          info: { id: 'ses_sh', title: '…' },
          messages: [
            {
              info: { id: 'msg_sh_u', sessionID: 'ses_sh', role: 'user', time: { created: at(0) }, agent: 'build' },
              parts: [{ id: 'prt_sh_1', sessionID: 'ses_sh', messageID: 'msg_sh_u', type: 'text', text: '…', synthetic: true }],
            },
            {
              info: { ...assistant('msg_sh_a', 'ses_sh', 'msg_sh_u', at(100)), time: { created: at(100), completed: at(900) } },
              parts: [
                {
                  id: 'prt_sh_2',
                  sessionID: 'ses_sh',
                  messageID: 'msg_sh_a',
                  type: 'tool',
                  callID: 'call_sh',
                  tool: 'bash',
                  state: { status: 'completed', input: { command: '…' }, output: '…', title: '…', metadata: {}, time: { start: at(150), end: at(800) } },
                },
              ],
            },
          ],
        },
      },
    };
    expect((await replay(fixture)).sent).toEqual([]);
  });

  it('a fork’s copied history, or an old reply touched again while a later turn runs', async () => {
    const old = assistant('msg_old_a', 'ses_fork', 'msg_old_u', at(-3_600_000), { finish: 'stop' });
    const fixture: V1Fixture = {
      events: [
        { id: 'evt_fork_1', type: 'session.created', properties: { sessionID: 'ses_fork', info: { id: 'ses_fork', title: '…' } } },
        updated(old),
        status('ses_fork', 'busy'),
        updated(old),
        updated(assistant('msg_new_a', 'ses_fork', 'msg_new_u', at(200))),
        status('ses_fork', 'idle'),
      ],
      sessions: {
        ses_fork: {
          info: { id: 'ses_fork', title: '…' },
          messages: [
            { info: { id: 'msg_old_u', sessionID: 'ses_fork', role: 'user', time: { created: at(-3_600_100) } }, parts: [] },
            { info: { ...old, time: { created: at(-3_600_000), completed: at(-3_590_000) } }, parts: stepped('msg_old_a', 'ses_fork') },
            { info: { id: 'msg_new_u', sessionID: 'ses_fork', role: 'user', time: { created: at(0) } }, parts: [] },
            {
              info: { ...assistant('msg_new_a', 'ses_fork', 'msg_new_u', at(200)), time: { created: at(200), completed: at(900) } },
              parts: stepped('msg_new_a', 'ses_fork'),
            },
          ],
        },
      },
    };
    const run = only((await replay(fixture)).sent);
    expect(run.runId).toBe(runIdOf('ses_fork', 'msg_new_u'));
    expect((run.inside ?? []).map((item) => item.start)).toEqual([at(200)]);
  });
});

describe('an OpenCode 1 turn’s name', () => {
  it('is its first reply where it takes up a prompt an earlier turn already answered, and it opens there', async () => {
    const fixture: V1Fixture = {
      events: [
        status('ses_again', 'busy'),
        updated(assistant('msg_a1', 'ses_again', 'msg_u1', at(100))),
        status('ses_again', 'idle'),
        status('ses_again', 'busy'),
        updated(assistant('msg_a2', 'ses_again', 'msg_u1', at(1_000))),
        status('ses_again', 'idle'),
      ],
      sessions: {
        ses_again: {
          info: { id: 'ses_again', title: '…' },
          messages: [
            { info: { id: 'msg_u1', sessionID: 'ses_again', role: 'user', time: { created: at(0) } }, parts: [] },
            { info: { ...assistant('msg_a1', 'ses_again', 'msg_u1', at(100)), time: { created: at(100), completed: at(500) } }, parts: stepped('msg_a1', 'ses_again') },
            { info: { ...assistant('msg_a2', 'ses_again', 'msg_u1', at(1_000)), time: { created: at(1_000), completed: at(1_500) } }, parts: stepped('msg_a2', 'ses_again') },
          ],
        },
      },
    };
    const { sent } = await replay(fixture);
    expect(sent.map((run) => run.runId)).toEqual([runIdOf('ses_again', 'msg_u1'), runIdOf('ses_again', 'msg_a2')]);
    expect(sent.map((run) => [run.start, run.end])).toEqual([
      [at(0), at(500)],
      [at(1_000), at(1_500)],
    ]);
  });
});

describe('an OpenCode 1 turn OpenCode wrote over', () => {
  it('leaves out a reply taken back while it ran, and reads no further back for it', async () => {
    const earlier = Array.from({ length: 12 }, (_, index) => ({
      info: { id: `msg_rm_old_${index}`, sessionID: 'ses_rm', role: index % 2 === 0 ? 'user' : 'assistant', time: { created: at(-60_000 + index * 1_000) } },
      parts: [],
    }));
    const fixture: V1Fixture = {
      events: [
        status('ses_rm', 'busy'),
        updated(assistant('msg_rm_a1', 'ses_rm', 'msg_rm_u', at(100))),
        updated(assistant('msg_rm_a2', 'ses_rm', 'msg_rm_u', at(1_000))),
        { id: 'evt_rm_removed', type: 'message.removed', properties: { sessionID: 'ses_rm', messageID: 'msg_rm_a2' } },
        status('ses_rm', 'idle'),
      ],
      sessions: {
        ses_rm: {
          info: { id: 'ses_rm', title: '…' },
          messages: [
            ...earlier,
            { info: { id: 'msg_rm_u', sessionID: 'ses_rm', role: 'user', time: { created: at(0) } }, parts: [] },
            { info: { ...assistant('msg_rm_a1', 'ses_rm', 'msg_rm_u', at(100)), time: { created: at(100), completed: at(900) } }, parts: stepped('msg_rm_a1', 'ses_rm') },
          ],
        },
      },
    };
    const { sent, reads } = await replay(fixture, { pageSize: 2 });
    const run = only(sent);
    expect(run.runId).toBe(runIdOf('ses_rm', 'msg_rm_u'));
    expect((run.inside ?? []).map((item) => item.start)).toEqual([at(100)]);
    // The prompt and its one reply are the newest page: a reply it waited on in vain would read back to the session's start.
    expect(reads.filter((read) => read.path.endsWith('/message'))).toHaveLength(1);
  });
});

describe('an OpenCode 1 turn in a session too long to read back through', () => {
  it('is read forty pages back at most, and recorded from what was read', async () => {
    const earlier = Array.from({ length: 200 }, (_, index) => ({
      info: { id: `msg_huge_old_${String(index).padStart(3, '0')}`, sessionID: 'ses_huge', role: index % 2 === 0 ? 'user' : 'assistant', time: { created: at(-600_000 + index * 1_000) } },
      parts: [],
    }));
    const fixture: V1Fixture = {
      events: [
        status('ses_huge', 'busy'),
        updated(assistant('msg_huge_a1', 'ses_huge', 'msg_huge_u', at(100))),
        // A reply OpenCode made and then took back with no event to say so: never found.
        updated(assistant('msg_huge_gone', 'ses_huge', 'msg_huge_u', at(500))),
        status('ses_huge', 'idle'),
      ],
      sessions: {
        ses_huge: {
          info: { id: 'ses_huge', title: '…' },
          messages: [
            ...earlier,
            { info: { id: 'msg_huge_u', sessionID: 'ses_huge', role: 'user', time: { created: at(0) } }, parts: [] },
            { info: { ...assistant('msg_huge_a1', 'ses_huge', 'msg_huge_u', at(100)), time: { created: at(100), completed: at(900) } }, parts: stepped('msg_huge_a1', 'ses_huge') },
          ],
        },
      },
    };
    const { sent, reads } = await replay(fixture, { pageSize: 2 });
    expect(reads.filter((read) => read.path.endsWith('/message'))).toHaveLength(40);
    const run = only(sent);
    expect(run.runId).toBe(runIdOf('ses_huge', 'msg_huge_u'));
    expect((run.inside ?? []).map((item) => item.start)).toEqual([at(100)]);
  });
});

describe('an OpenCode 1 turn whose clock runs backwards', () => {
  it('never holds a span that ends before it starts, which the SDK would refuse whole', async () => {
    // Every time in every fixture's messages mirrored, so each later thing
    // reads as earlier: the worst a clock stepping back can do.
    for (const name of ['turn', 'subagent', 'interrupted', 'failed']) {
      const fixture = v1Fixture(name);
      const mirror = (value: unknown, key?: string): unknown => {
        if (typeof value === 'number' && key !== undefined && ['created', 'completed', 'start', 'end'].includes(key)) return 2 * T0 - value;
        if (Array.isArray(value)) return value.map((each) => mirror(each));
        if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mirror(v, k)]));
        return value;
      };
      const mirrored = { ...fixture, sessions: mirror(fixture.sessions) as V1Fixture['sessions'] };
      for (const run of (await replay(mirrored, { now: () => 2 * T0 - at(60_000) })).sent) {
        const spans = [run, ...(run.inside ?? []), ...(run.inside ?? []).flatMap((item) => (item.type === 'step' ? (item.calls ?? []) : []))];
        for (const span of spans) expect(Number(span.end)).toBeGreaterThanOrEqual(Number(span.start));
      }
    }
  });
});

describe('an OpenCode 1 read that fails', () => {
  it('is logged by its status alone, and nothing is sent', async () => {
    const fixture: V1Fixture = {
      events: [
        { id: 'evt_gone_1', type: 'session.created', properties: { sessionID: 'ses_gone_0001', info: { id: 'ses_gone_0001', title: '…' } } },
        status('ses_gone_0001', 'busy'),
        updated(assistant('msg_gone_a', 'ses_gone_0001', 'msg_gone_u', at(100))),
        status('ses_gone_0001', 'idle'),
      ],
      sessions: {},
    };
    const { sent, logged } = await replay(fixture);
    expect(sent).toEqual([]);
    expect(logged).toEqual(['ses_gone_000: turn not read: ReadError:404']);
  });
});

describe('an OpenCode 1 record', () => {
  it('carries nothing of what was said: no text, no input or output, no title, no path, no error message', async () => {
    const records: RunRecord[] = [];
    for (const name of ['turn', 'subagent', 'interrupted', 'failed']) records.push(...(await replay(name)).sent);
    const json = JSON.stringify(records);
    expect(json).not.toContain('…');
    expect(json).not.toContain('/');
    expect(keysOf(records)).toEqual([...RECORD_KEYS].sort());
  });

  it('is handed on whatever OpenCode sends it, and a malformed event is passed over', async () => {
    const fixture = v1Fixture('turn');
    const noise = [{}, { type: 'session.status' }, { type: 'message.updated', properties: null }, { type: 'session.status', properties: { sessionID: '../..', status: { type: 'busy' } } }];
    const { sent } = await replay({ ...fixture, events: [...(noise as V1Fixture['events']), ...fixture.events] });
    expect(sent).toHaveLength(1);
  });
});
