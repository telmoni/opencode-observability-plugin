import type { ModelCallRecord, RunRecord, StepRecord, ToolCallRecord } from 'telmoni';
import { describe, expect, it } from 'vitest';

import type { V2Event } from '../src/opencode';
import { AGENT, runIdOf } from '../src/record';
import { V2Turns } from '../src/v2';
import { RECORD_KEYS, type V2Fixture, at, keysOf, v2Fixture } from './helpers';

function replay(fixture: V2Fixture | string | V2Event[]): { sent: RunRecord[]; logged: string[] } {
  const events = Array.isArray(fixture) ? fixture : (typeof fixture === 'string' ? v2Fixture(fixture) : fixture).events;
  const sent: RunRecord[] = [];
  const logged: string[] = [];
  const turns = new V2Turns({ send: (record) => void sent.push(record), log: (line) => void logged.push(line) });
  for (const event of events) turns.handle(event);
  return { sent, logged };
}

function only(records: RunRecord[]): RunRecord {
  expect(records).toHaveLength(1);
  return records[0]!;
}

const event = (type: string, ms: number, data: Record<string, unknown>): V2Event => ({ type, created: at(ms), data });

const step = (sessionID: string, assistantMessageID: string, ms: number, model = 'claude-sonnet-4-5', providerID = 'anthropic'): V2Event =>
  event('session.step.started', ms + 20, { sessionID, assistantMessageID, agent: 'build', model: { id: model, providerID }, started: at(ms) });

const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };

/** One reply of the model, from its request at `ms` to its answer's end 500 ms on. */
const reply = (sessionID: string, assistantMessageID: string, ms: number): V2Event[] => [
  step(sessionID, assistantMessageID, ms),
  event('session.step.streamed', ms + 500, { sessionID, assistantMessageID }),
  event('session.step.ended', ms + 510, { sessionID, assistantMessageID, finish: 'stop', cost: 0, tokens }),
];

const subagentCall = (sessionID: string, id: string, child: string, ms: number, until: number): { open: V2Event[]; close: V2Event } => ({
  open: [
    event('session.tool.input.started', ms, { sessionID, assistantMessageID: 'msg_root_a', id, name: 'subagent' }),
    event('session.tool.called', ms + 10, { sessionID, assistantMessageID: 'msg_root_a', id, input: { agent: 'explore', prompt: '…' }, executed: true }),
    event('session.tool.progress', ms + 20, { sessionID, assistantMessageID: 'msg_root_a', id, metadata: { sessionID: child, status: 'running' } }),
  ],
  close: event('session.tool.success', until, {
    sessionID,
    assistantMessageID: 'msg_root_a',
    id,
    content: [{ type: 'text', text: '…' }],
    metadata: { sessionID: child, status: 'completed' },
    executed: true,
  }),
});

describe('a turn of OpenCode 2', () => {
  it('is one run of opencode in the session, named by its prompt, from the execution’s start to its end', () => {
    const run = only(replay('turn').sent);
    expect(run.agent).toBe(AGENT);
    expect(run.sessionId).toBe('ses_v2_root_0001');
    expect(run.runId).toBe(runIdOf('ses_v2_root_0001', 'msg_v2_u_0001'));
    expect([run.start, run.end]).toEqual([at(0), at(8_100)]);
    expect(run.errorType).toBeUndefined();
    expect(run.cancelled).toBeUndefined();
  });

  it('has a model call per reply, a retried one once from its first request, and a tool call per tool', () => {
    const run = only(replay('turn').sent);
    expect(
      (run.inside ?? []).map((item) =>
        item.type === 'model_call'
          ? [item.model, item.provider, item.start, item.end, item.usage]
          : [(item as ToolCallRecord).name, item.start, item.end, item.errorType],
      ),
    ).toEqual([
      ['claude-sonnet-4-5', 'anthropic', at(100), at(2_200), { inputTokens: 4_700, outputTokens: 120, cacheReadInputTokens: 3_000, cacheWriteInputTokens: 500 }],
      ['read', at(2_100), at(2_500), undefined],
      ['claude-sonnet-4-5', 'anthropic', at(2_700), at(4_100), { inputTokens: 4_600, outputTokens: 60, cacheReadInputTokens: 4_200, cacheWriteInputTokens: 0 }],
      ['bash', at(4_050), at(6_000), 'ToolError'],
      ['claude-sonnet-4-5', 'anthropic', at(6_200), at(8_000), { inputTokens: 5_200, outputTokens: 150, cacheReadInputTokens: 4_900, cacheWriteInputTokens: 0 }],
    ]);
  });

  it('has the same run id, and the same record, every time it is read', () => {
    for (const name of ['turn', 'subagent', 'interrupted', 'shutdown', 'failed']) {
      expect(replay(name).sent).toEqual(replay(name).sent);
    }
  });

  it('goes on through OpenCode’s shutdown, the execution resumed at its next start carrying on the same turn', () => {
    const run = only(replay('shutdown').sent);
    expect(run.runId).toBe(runIdOf('ses_v2_root_0004', 'msg_v2_u_0401'));
    expect([run.start, run.end]).toEqual([at(0), at(62_200)]);
    expect((run.inside ?? []).map((item) => [(item as ModelCallRecord).provider, item.start, item.end])).toEqual([
      ['gcp.gemini', at(100), at(2_000)],
      ['gcp.gemini', at(60_100), at(62_000)],
    ]);
  });

  it('is recorded from where the plugin came in, where it was loaded while the turn ran, named by its first reply', () => {
    const run = only(replay([...reply('ses_late', 'msg_late_a', 5_000), event('session.execution.succeeded', 6_000, { sessionID: 'ses_late' })]).sent);
    expect(run.runId).toBe(runIdOf('ses_late', 'msg_late_a'));
    expect([run.start, run.end]).toEqual([at(5_000), at(6_000)]);
  });

  it('ends a reply asked again after its answer had begun at the retried answer’s end', () => {
    const run = only(
      replay([
        event('session.execution.started', 0, { sessionID: 'ses_rt' }),
        event('session.inbox.delivered', 10, { sessionID: 'ses_rt', inboxID: 'msg_rt_u' }),
        step('ses_rt', 'msg_rt_a', 100),
        event('session.step.streamed', 600, { sessionID: 'ses_rt', assistantMessageID: 'msg_rt_a' }),
        event('session.retry.scheduled', 700, { sessionID: 'ses_rt', assistantMessageID: 'msg_rt_a', attempt: 1, at: at(1_000), error: { type: 'provider.rate-limit', message: '…', status: 429 } }),
        step('ses_rt', 'msg_rt_a', 1_000),
        event('session.step.streamed', 2_000, { sessionID: 'ses_rt', assistantMessageID: 'msg_rt_a' }),
        event('session.step.ended', 2_010, { sessionID: 'ses_rt', assistantMessageID: 'msg_rt_a', finish: 'stop', cost: 0, tokens }),
        event('session.execution.succeeded', 2_100, { sessionID: 'ses_rt' }),
      ]).sent,
    );
    expect((run.inside ?? []).map((item) => [item.type, item.start, item.end])).toEqual([['model_call', at(100), at(2_000)]]);
  });

  it('counts a compaction that failed, which names no model, as a model call of `unknown` failed with its error’s kind', () => {
    const error = { type: 'provider.overloaded', message: '…' };
    const run = only(
      replay([
        event('session.execution.started', 0, { sessionID: 'ses_cf' }),
        event('session.inbox.delivered', 10, { sessionID: 'ses_cf', inboxID: 'msg_cf_in' }),
        ...reply('ses_cf', 'msg_cf_a', 50),
        event('session.compaction.started', 1_000, { sessionID: 'ses_cf', reason: 'auto', recent: '…' }),
        event('session.compaction.failed', 2_000, { sessionID: 'ses_cf', reason: 'auto', error, cost: 0, tokens }),
        event('session.execution.failed', 2_100, { sessionID: 'ses_cf', error }),
      ]).sent,
    );
    const compaction = (run.inside ?? []).find((item): item is ModelCallRecord => item.type === 'model_call' && item.model === 'unknown')!;
    expect([compaction.start, compaction.end, compaction.usage?.inputTokens]).toEqual([at(1_000), at(2_000), 10]);
    expect([compaction.errorType, run.errorType]).toEqual(['provider.overloaded', 'provider.overloaded']);
  });

  it('counts a compaction the person stopped as a model call cancelled', () => {
    const run = only(
      replay([
        event('session.execution.started', 0, { sessionID: 'ses_ca' }),
        event('session.inbox.delivered', 10, { sessionID: 'ses_ca', inboxID: 'msg_ca_in' }),
        ...reply('ses_ca', 'msg_ca_a', 50),
        event('session.compaction.started', 1_000, { sessionID: 'ses_ca', reason: 'auto', recent: '…' }),
        event('session.compaction.failed', 2_000, { sessionID: 'ses_ca', reason: 'auto', error: { type: 'aborted', message: '…' }, cost: 0, tokens }),
        event('session.execution.succeeded', 2_100, { sessionID: 'ses_ca' }),
      ]).sent,
    );
    const compaction = (run.inside ?? []).find((item): item is ModelCallRecord => item.type === 'model_call' && item.model === 'unknown')!;
    expect([compaction.start, compaction.end, compaction.cancelled, compaction.errorType]).toEqual([at(1_000), at(2_000), true, undefined]);
  });

  it('counts a compaction’s request to the model as a model call', () => {
    const run = only(
      replay([
        event('session.execution.started', 0, { sessionID: 'ses_cmp' }),
        event('session.inbox.delivered', 10, { sessionID: 'ses_cmp', inboxID: 'msg_cmp_in' }),
        event('session.compaction.started', 100, { sessionID: 'ses_cmp', reason: 'manual', recent: '…' }),
        event('session.compaction.ended', 3_000, {
          sessionID: 'ses_cmp',
          reason: 'manual',
          model: { id: 'claude-haiku-4-5', providerID: 'anthropic' },
          text: '…',
          recent: '…',
          cost: 0.001,
          tokens: { input: 5_000, output: 400, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        event('session.execution.succeeded', 3_100, { sessionID: 'ses_cmp' }),
      ]).sent,
    );
    expect(run.runId).toBe(runIdOf('ses_cmp', 'msg_cmp_in'));
    expect(run.inside).toEqual([
      {
        type: 'model_call',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        start: at(100),
        end: at(3_000),
        usage: { inputTokens: 5_000, outputTokens: 400, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      },
    ]);
  });
});

describe('a subagent in OpenCode 2', () => {
  it('seen at work before the call that started it names it, is that call’s step, and no run of its own', () => {
    const call = subagentCall('ses_root', 'call_sub', 'ses_child', 1_000, 4_000);
    const run = only(
      replay([
        event('session.execution.started', 0, { sessionID: 'ses_root' }),
        event('session.inbox.delivered', 10, { sessionID: 'ses_root', inboxID: 'msg_root_u' }),
        step('ses_root', 'msg_root_a', 100),
        call.open[0]!,
        call.open[1]!,
        // Its own execution, whose creation went unseen: no parent known yet.
        event('session.execution.started', 1_015, { sessionID: 'ses_child' }),
        ...reply('ses_child', 'msg_child_a', 1_100),
        call.open[2]!,
        event('session.execution.succeeded', 3_000, { sessionID: 'ses_child' }),
        call.close,
        event('session.step.streamed', 4_100, { sessionID: 'ses_root', assistantMessageID: 'msg_root_a' }),
        event('session.step.ended', 4_110, { sessionID: 'ses_root', assistantMessageID: 'msg_root_a', finish: 'stop', cost: 0, tokens }),
        event('session.execution.succeeded', 5_000, { sessionID: 'ses_root' }),
      ]).sent,
    );
    expect(run.runId).toBe(runIdOf('ses_root', 'msg_root_u'));
    const found = (run.inside ?? []).find((item): item is StepRecord => item.type === 'step')!;
    expect((found.calls ?? []).map((item) => [item.type, item.start, item.end])).toEqual([['model_call', at(1_100), at(1_600)]]);
  });

  it('is a step named by its agent holding its calls, and its own execution is no run of its own', () => {
    const run = only(replay('subagent').sent);
    expect(run.runId).toBe(runIdOf('ses_v2_root_0002', 'msg_v2_u_0101'));
    expect((run.inside ?? []).map((item) => (item.type === 'step' ? item.name : item.type))).toEqual([
      'model_call',
      'subagent explore',
      'model_call',
    ]);
    const found = (run.inside ?? []).find((item): item is StepRecord => item.type === 'step')!;
    expect([found.start, found.end]).toEqual([at(1_050), at(5_300)]);
    expect((found.calls ?? []).map((call) => [call.type === 'model_call' ? call.model : call.name, call.start, call.end])).toEqual([
      ['claude-haiku-4-5', at(1_300), at(2_100)],
      ['grep', at(2_050), at(3_000)],
      ['claude-haiku-4-5', at(3_200), at(5_000)],
    ]);
  });

  it('taken up again by a later call is each call’s step from that call to the next', () => {
    const first = subagentCall('ses_root', 'call_1', 'ses_kid', 1_000, 3_000);
    const second = subagentCall('ses_root', 'call_2', 'ses_kid', 4_000, 6_000);
    const run = only(
      replay([
        event('session.execution.started', 0, { sessionID: 'ses_root' }),
        step('ses_root', 'msg_root_a', 100),
        ...first.open,
        event('session.created', 1_030, { sessionID: 'ses_kid', parentID: 'ses_root', agent: 'explore', title: '…' }),
        ...reply('ses_kid', 'msg_kid_a1', 1_300),
        first.close,
        ...second.open,
        ...reply('ses_kid', 'msg_kid_a2', 4_300),
        second.close,
        event('session.step.ended', 6_100, { sessionID: 'ses_root', assistantMessageID: 'msg_root_a', finish: 'stop', cost: 0, tokens }),
        event('session.execution.succeeded', 6_200, { sessionID: 'ses_root' }),
      ]).sent,
    );
    const steps = (run.inside ?? []).filter((item): item is StepRecord => item.type === 'step');
    expect(steps.map((each) => (each.calls ?? []).map((call) => call.start))).toEqual([[at(1_300)], [at(4_300)]]);
  });

  it('still working when the turn that started it ends is recorded as far as it had got, and no further', () => {
    const call = subagentCall('ses_root', 'call_bg', 'ses_bg', 1_000, 1_100);
    const { sent } = replay([
      event('session.execution.started', 0, { sessionID: 'ses_root' }),
      event('session.inbox.delivered', 5, { sessionID: 'ses_root', inboxID: 'msg_root_u1' }),
      ...reply('ses_root', 'msg_root_a', 100),
      ...call.open,
      event('session.created', 1_030, { sessionID: 'ses_bg', parentID: 'ses_root', agent: 'explore', title: '…' }),
      call.close,
      step('ses_bg', 'msg_bg_a1', 1_300),
      event('session.execution.succeeded', 2_000, { sessionID: 'ses_root' }),
      event('session.step.streamed', 2_500, { sessionID: 'ses_bg', assistantMessageID: 'msg_bg_a1' }),
      ...reply('ses_bg', 'msg_bg_a2', 3_000),
      event('session.execution.started', 10_000, { sessionID: 'ses_root' }),
      event('session.inbox.delivered', 10_005, { sessionID: 'ses_root', inboxID: 'msg_root_u2' }),
      ...reply('ses_root', 'msg_root_b', 10_100),
      event('session.execution.succeeded', 11_000, { sessionID: 'ses_root' }),
    ]);
    expect(sent.map((run) => run.runId)).toEqual([runIdOf('ses_root', 'msg_root_u1'), runIdOf('ses_root', 'msg_root_u2')]);
    const background = (sent[0]!.inside ?? []).find((item): item is StepRecord => item.type === 'step')!;
    expect((background.calls ?? []).map((call) => [call.start, call.end, call.cancelled])).toEqual([[at(1_300), at(2_000), true]]);
    expect(sent[1]!.inside).toHaveLength(1);
  });

  it('working through a subagent of its own holds that subagent’s calls beside the call that started it', () => {
    const kid = subagentCall('ses_root', 'call_kid', 'ses_kid', 1_000, 9_000);
    const grandchild = subagentCall('ses_kid', 'call_grand', 'ses_grand', 3_000, 6_000);
    const run = only(
      replay([
        event('session.execution.started', 0, { sessionID: 'ses_root' }),
        step('ses_root', 'msg_root_a', 100),
        ...kid.open,
        event('session.created', 1_030, { sessionID: 'ses_kid', parentID: 'ses_root', agent: 'explore', title: '…' }),
        event('session.execution.started', 1_040, { sessionID: 'ses_kid' }),
        ...reply('ses_kid', 'msg_kid_a1', 1_300),
        ...grandchild.open,
        event('session.created', 3_030, { sessionID: 'ses_grand', parentID: 'ses_kid', agent: 'general', title: '…' }),
        event('session.execution.started', 3_040, { sessionID: 'ses_grand' }),
        ...reply('ses_grand', 'msg_grand_a1', 3_300),
        event('session.execution.succeeded', 5_900, { sessionID: 'ses_grand' }),
        grandchild.close,
        event('session.execution.succeeded', 8_900, { sessionID: 'ses_kid' }),
        kid.close,
        event('session.step.ended', 9_100, { sessionID: 'ses_root', assistantMessageID: 'msg_root_a', finish: 'stop', cost: 0, tokens }),
        event('session.execution.succeeded', 9_200, { sessionID: 'ses_root' }),
      ]).sent,
    );
    const found = (run.inside ?? []).find((item): item is StepRecord => item.type === 'step')!;
    expect(found.name).toBe('subagent explore');
    expect((found.calls ?? []).map((call) => [call.type === 'model_call' ? 'model' : call.name, call.start, call.end])).toEqual([
      ['model', at(1_300), at(1_800)],
      ['subagent', at(3_010), at(6_000)],
      ['model', at(3_300), at(3_800)],
    ]);
  });

  it('is followed four deep at most: a deeper subagent’s calls are not kept, and the call that started it stands as a call', () => {
    const events: V2Event[] = [
      event('session.execution.started', 0, { sessionID: 'ses_chain_0' }),
      event('session.inbox.delivered', 5, { sessionID: 'ses_chain_0', inboxID: 'msg_chain_0_u' }),
      step('ses_chain_0', 'msg_chain_0_a', 100),
    ];
    const closes: V2Event[] = [];
    for (let level = 1; level <= 6; level++) {
      const call = subagentCall(`ses_chain_${level - 1}`, `call_chain_${level}`, `ses_chain_${level}`, level * 1_000, 20_000 - level * 1_000);
      events.push(
        ...call.open,
        event('session.created', level * 1_000 + 30, { sessionID: `ses_chain_${level}`, parentID: `ses_chain_${level - 1}`, agent: 'general', title: '…' }),
        ...reply(`ses_chain_${level}`, `msg_chain_${level}_a`, level * 1_000 + 100),
      );
      closes.unshift(call.close);
    }
    events.push(
      ...closes,
      event('session.step.ended', 19_500, { sessionID: 'ses_chain_0', assistantMessageID: 'msg_chain_0_a', finish: 'stop', cost: 0, tokens }),
      event('session.execution.succeeded', 19_600, { sessionID: 'ses_chain_0' }),
    );
    const found = (only(replay(events).sent).inside ?? []).find((item): item is StepRecord => item.type === 'step')!;
    expect(found.name).toBe('subagent general');
    expect((found.calls ?? []).map((call) => [call.type === 'model_call' ? 'model' : call.name, call.start])).toEqual([
      ['model', at(1_100)],
      ['subagent', at(2_010)],
      ['model', at(2_100)],
      ['subagent', at(3_010)],
      ['model', at(3_100)],
      ['subagent', at(4_010)],
      ['model', at(4_100)],
      ['subagent', at(5_010)],
    ]);
  });
});

describe('an OpenCode 2 turn that did not end well', () => {
  it('is cancelled where the person interrupted it, its unsettled tools with it', () => {
    const run = only(replay('interrupted').sent);
    expect(run.cancelled).toBe(true);
    expect([run.start, run.end]).toEqual([at(0), at(9_020)]);
    expect(
      (run.inside ?? []).map((item) => [item.type === 'model_call' ? item.model : (item as ToolCallRecord).name, item.start, item.end, item.cancelled, item.errorType]),
    ).toEqual([
      ['claude-sonnet-4-5', at(100), at(1_200), true, undefined],
      ['bash', at(1_050), at(9_000), true, undefined],
      ['read', at(1_100), at(9_020), true, undefined],
    ]);
  });

  it('fails with the kind of the execution’s error, never its message, a retried call once', () => {
    const run = only(replay('failed').sent);
    expect(run.errorType).toBe('provider.rate-limit');
    expect(run.inside).toEqual([
      { type: 'model_call', model: 'gpt-5', provider: 'openai', start: at(100), end: at(5_000), errorType: 'provider.rate-limit' },
    ]);
  });
});

describe('what is no turn in OpenCode 2', () => {
  it('an execution with nothing of the model’s in it, and a stray event of a turn already ended', () => {
    const { sent } = replay([
      event('session.execution.started', 0, { sessionID: 'ses_idle' }),
      event('session.inbox.delivered', 10, { sessionID: 'ses_idle', inboxID: 'msg_idle_u' }),
      event('session.shell.started', 20, { sessionID: 'ses_idle', shell: { id: 'sh_1', command: '…' } }),
      event('session.shell.ended', 900, { sessionID: 'ses_idle', shell: { id: 'sh_1', command: '…' }, output: '…' }),
      event('session.execution.succeeded', 1_000, { sessionID: 'ses_idle' }),
      event('session.tool.success', 1_100, { sessionID: 'ses_idle', assistantMessageID: 'msg_x', id: 'call_x', content: [], executed: true }),
      event('session.execution.failed', 1_200, { sessionID: 'ses_idle', error: { type: 'unknown', message: '…' } }),
    ]);
    expect(sent).toEqual([]);
  });

  it('a malformed event, which is passed over', () => {
    const fixture = v2Fixture('turn');
    const noise: V2Event[] = [{}, { type: 'session.execution.started' }, { type: 'session.step.started', data: null }, { type: 'session.execution.started', data: { sessionID: '/work/…' } }];
    expect(replay([...noise, ...fixture.events]).sent).toEqual(replay(fixture).sent);
  });

  it('an event of a kind OpenCode adds later, or a field it adds, which changes nothing', () => {
    const fixture = v2Fixture('turn');
    const later = fixture.events.flatMap((each): V2Event[] => [
      { ...each, data: { ...(each.data as object), shape: { added: '…' }, rank: 3 } },
      { type: 'session.thought.weighed', created: each.created, data: { sessionID: 'ses_v2_root_0001', weight: '…' } },
    ]);
    expect(replay(later).sent).toEqual(replay(fixture).sent);
  });
});

describe('an OpenCode 2 tool call', () => {
  it('is matched by whatever id the provider gave it, which no record holds', () => {
    const events: V2Event[] = [
      event('session.execution.started', 0, { sessionID: 'ses_kimi' }),
      event('session.inbox.delivered', 5, { sessionID: 'ses_kimi', inboxID: 'msg_kimi_u' }),
      ...reply('ses_kimi', 'msg_kimi_a', 100),
      event('session.tool.input.started', 300, { sessionID: 'ses_kimi', assistantMessageID: 'msg_kimi_a', id: 'functions.read:0', name: 'read' }),
      event('session.tool.called', 320, { sessionID: 'ses_kimi', assistantMessageID: 'msg_kimi_a', id: 'functions.read:0', input: {}, executed: true }),
      event('session.tool.success', 900, { sessionID: 'ses_kimi', assistantMessageID: 'msg_kimi_a', id: 'functions.read:0', content: [], executed: true }),
      event('session.execution.succeeded', 1_000, { sessionID: 'ses_kimi' }),
    ];
    const run = only(replay(events).sent);
    expect((run.inside ?? []).filter((item) => item.type === 'tool_call')).toEqual([{ type: 'tool_call', name: 'read', start: at(320), end: at(900) }]);
    expect(JSON.stringify(run)).not.toContain('functions.read:0');
  });

  it('is told from a call of a later reply that its provider gave the same id', () => {
    const call = (assistantMessageID: string, ms: number, settled: string): V2Event[] => [
      event('session.tool.input.started', ms, { sessionID: 'ses_kimi', assistantMessageID, id: 'functions.read:0', name: 'read' }),
      event('session.tool.called', ms + 20, { sessionID: 'ses_kimi', assistantMessageID, id: 'functions.read:0', input: {}, executed: true }),
      event(settled, ms + 400, { sessionID: 'ses_kimi', assistantMessageID, id: 'functions.read:0', error: { type: 'tool.execution', message: '…' }, executed: true }),
    ];
    const events: V2Event[] = [
      event('session.execution.started', 0, { sessionID: 'ses_kimi' }),
      event('session.inbox.delivered', 5, { sessionID: 'ses_kimi', inboxID: 'msg_kimi_u' }),
      ...reply('ses_kimi', 'msg_kimi_a', 100),
      ...call('msg_kimi_a', 700, 'session.tool.success'),
      ...reply('ses_kimi', 'msg_kimi_b', 1_200),
      ...call('msg_kimi_b', 1_800, 'session.tool.failed'),
      event('session.execution.succeeded', 3_000, { sessionID: 'ses_kimi' }),
    ];
    const run = only(replay(events).sent);
    expect((run.inside ?? []).filter((item) => item.type === 'tool_call')).toEqual([
      { type: 'tool_call', name: 'read', start: at(720), end: at(1_100) },
      { type: 'tool_call', name: 'read', start: at(1_820), end: at(2_200), errorType: 'ToolError' },
    ]);
  });

  it('is named `unknown` where the model made up a name that reads like text', () => {
    const events: V2Event[] = [
      event('session.execution.started', 0, { sessionID: 'ses_odd' }),
      ...reply('ses_odd', 'msg_odd_a', 100),
      event('session.tool.input.started', 300, { sessionID: 'ses_odd', assistantMessageID: 'msg_odd_a', id: 'call_1', name: 'open /work/… and read it' }),
      event('session.tool.failed', 400, { sessionID: 'ses_odd', assistantMessageID: 'msg_odd_a', id: 'call_1', error: { type: 'tool.unknown', message: '…' }, executed: false }),
      event('session.execution.succeeded', 1_000, { sessionID: 'ses_odd' }),
    ];
    const run = only(replay(events).sent);
    expect((run.inside ?? []).find((item) => item.type === 'tool_call')).toMatchObject({ name: 'unknown', errorType: 'ToolError' });
    expect(JSON.stringify(run)).not.toContain('/');
  });
});

describe('an OpenCode 2 turn whose clock runs backwards', () => {
  it('never holds a span that ends before it starts, which the SDK would refuse whole', () => {
    // Every event of every fixture published in reverse time order, its payload's own times kept: the worst a clock stepping back can do.
    for (const name of ['turn', 'subagent', 'interrupted', 'shutdown', 'failed']) {
      const events = v2Fixture(name).events;
      const times = events.map((each) => each.created as number).reverse();
      const reversed = events.map((each, index) => ({ ...each, created: times[index] }));
      for (const run of replay(reversed).sent) {
        const spans = [run, ...(run.inside ?? []), ...(run.inside ?? []).flatMap((item) => (item.type === 'step' ? (item.calls ?? []) : []))];
        for (const span of spans) expect(Number(span.end)).toBeGreaterThanOrEqual(Number(span.start));
      }
    }
  });
});

describe('an OpenCode 2 record', () => {
  it('carries nothing of what was said: no text, no input or output, no title, no path, no error message', () => {
    const records = ['turn', 'subagent', 'interrupted', 'shutdown', 'failed'].flatMap((name) => replay(name).sent);
    const json = JSON.stringify(records);
    expect(json).not.toContain('…');
    expect(json).not.toContain('/');
    const keys = keysOf(records);
    expect(keys.every((key) => RECORD_KEYS.includes(key))).toBe(true);
  });
});
