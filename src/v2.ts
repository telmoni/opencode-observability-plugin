/**
 * OpenCode 2: a plugin is a definition whose `setup` OpenCode calls with a
 * context, and the plugin follows the context's event stream. A turn is an
 * execution of a session, from `session.execution.started` to its success,
 * failure or interruption — an interruption by OpenCode's own shutdown aside,
 * since the execution resumed at its next start carries on the same turn.
 * Each event a record needs carries what it needs of it, so a turn's calls
 * are gathered as they come and nothing is read back.
 *
 * Of an event the plugin reads its type and time, and of its payload the
 * ids, the agent, the model and provider, token counts, a tool's name, the
 * kind of an error, and the subagent session a call started. Never a text, a
 * thought, a tool's input or output, a path, a title or an error's message.
 */

import type { CallRecord, ModelCallRecord, RunRecord, StepRecord, Usage } from 'telmoni';

import { kindOf } from './log.js';
import { type Fields, type V2Cleanup, type V2Context, type V2Event, fieldsOf, idOf, stringOf, timeOf } from './opencode.js';
import {
  MAX_DEPTH,
  SUBAGENT_TOOLS,
  type Span,
  agentOf,
  errorTypeOf,
  modelCall,
  runOf,
  subagentStep,
  toolCall,
  usageOf,
} from './record.js';
import { connect } from './send.js';

/** OpenCode 2's kind for the error of something the person, or OpenCode, stopped. */
const ABORTED = 'aborted';

/** A reply of the model: one model call, however many times it was tried. */
interface Reply {
  model: string | undefined;
  provider: string | undefined;
  start: number;
  /** When the model's answer ended; the reply settles only after the tools it asked for. */
  streamed?: number;
  end?: number;
  usage?: Usage;
  errorType?: string;
  cancelled?: boolean;
}

interface Tool {
  name: string;
  /** When the model began to write the call. */
  asked: number;
  /** When the tool began to run. */
  called?: number;
  end?: number;
  errorType?: string;
  cancelled?: boolean;
  /** The subagent session the call started or took up again. */
  child?: string;
}

/** A compaction's own request to the model. */
interface Compaction {
  model?: string;
  provider?: string;
  start: number;
  end?: number;
  usage?: Usage;
}

/** What a session has done that a record may hold. */
interface Work {
  replies: Map<string, Reply>;
  tools: Map<string, Tool>;
  compactions: Compaction[];
}

interface Turn extends Work {
  start: number;
  /** The first input delivered to the turn: the person's prompt, whose message takes its id. */
  anchor?: string;
  /** The turn's first reply, which names a turn picked up with no input of its own. */
  firstReply?: string;
}

interface Session {
  /** The session that started this one as its subagent. */
  parent?: string;
  agent?: string;
  /** A session of its own: the turn running now. */
  turn?: Turn;
  /** A subagent's: what it has done during the turn that started it. */
  work?: Work;
}

function newWork(): Work {
  return { replies: new Map(), tools: new Map(), compactions: [] };
}

function settledAs(error: unknown): Pick<Span, 'errorType' | 'cancelled'> {
  const kind = fieldsOf(error)?.['type'];
  return kind === ABORTED ? { cancelled: true } : { errorType: errorTypeOf(kind, 'Error') };
}

/** The model calls among `work`, each from its request to the end of its answer. */
function modelCallsOf(work: Work, until: number): ModelCallRecord[] {
  const calls: ModelCallRecord[] = [];
  for (const reply of work.replies.values()) {
    if (reply.model === undefined) continue;
    const end = reply.streamed ?? reply.end;
    calls.push(
      modelCall(
        reply.model,
        reply.provider,
        end === undefined
          ? // Never answered: the turn ended first.
            { start: reply.start, end: until, cancelled: true }
          : { start: reply.start, end, errorType: reply.errorType, cancelled: reply.cancelled },
        reply.usage,
      ),
    );
  }
  for (const compaction of work.compactions) {
    // A compaction that failed names no model, and a model call needs one.
    if (compaction.model === undefined || compaction.end === undefined) continue;
    calls.push(modelCall(compaction.model, compaction.provider, { start: compaction.start, end: compaction.end }, compaction.usage));
  }
  return calls;
}

function toolSpanOf(tool: Tool, until: number): Span {
  const start = tool.called ?? tool.asked;
  // Never settled: the turn ended first.
  if (tool.end === undefined) return { start, end: until, cancelled: true };
  return { start, end: tool.end, errorType: tool.errorType, cancelled: tool.cancelled };
}

/** When each subagent session was started or taken up again by a call in `work`, earliest first. */
function subagentRuns(work: Work): Map<string, number[]> {
  const runs = new Map<string, number[]>();
  for (const tool of work.tools.values()) {
    if (tool.child === undefined || !SUBAGENT_TOOLS.has(tool.name)) continue;
    runs.set(tool.child, [...(runs.get(tool.child) ?? []), tool.called ?? tool.asked]);
  }
  for (const starts of runs.values()) starts.sort((a, b) => a - b);
  return runs;
}

export interface V2Deps {
  send: (record: RunRecord) => void;
  log: (line: string) => void;
}

/** The turns of every session OpenCode runs where the plugin was loaded, each recorded once it has ended. */
export class V2Turns {
  readonly #deps: V2Deps;
  readonly #sessions = new Map<string, Session>();

  constructor(deps: V2Deps) {
    this.#deps = deps;
  }

  /** One event, handled at once and in full: a turn that ends is handed to the sender before this returns. */
  handle(event: V2Event): void {
    const data = fieldsOf(event.data);
    const sessionId = idOf(data?.['sessionID']);
    if (data === undefined || sessionId === undefined) return;
    const at = timeOf(event.created) ?? Date.now();
    switch (event.type) {
      case 'session.created': {
        const session = this.#session(sessionId);
        const parent = idOf(data['parentID']);
        const agent = agentOf(data['agent']);
        if (parent !== undefined && parent !== sessionId) session.parent ??= parent;
        if (agent !== undefined) session.agent ??= agent;
        return;
      }
      case 'session.deleted':
        this.#sessions.delete(sessionId);
        return;
      case 'session.execution.started': {
        const session = this.#session(sessionId);
        // Started again after OpenCode's shutdown stopped it, it carries on the turn still open.
        if (session.parent === undefined) session.turn ??= { ...newWork(), start: at };
        return;
      }
      case 'session.inbox.delivered': {
        const turn = this.#sessions.get(sessionId)?.turn;
        const id = idOf(data['inboxID']);
        if (turn !== undefined && id !== undefined) turn.anchor ??= id;
        return;
      }
      case 'session.step.started': {
        const id = idOf(data['assistantMessageID']);
        const work = id === undefined ? undefined : this.#workOf(sessionId, at, true);
        if (id === undefined || work === undefined || work.replies.has(id)) return;
        const model = fieldsOf(data['model']);
        work.replies.set(id, {
          model: stringOf(model?.['id']),
          provider: stringOf(model?.['providerID']),
          start: timeOf(data['started']) ?? at,
        });
        const session = this.#session(sessionId);
        if (session.turn !== undefined) session.turn.firstReply ??= id;
        const agent = agentOf(data['agent']);
        if (agent !== undefined) session.agent ??= agent;
        return;
      }
      case 'session.step.streamed': {
        const reply = this.#replyOf(sessionId, data);
        if (reply !== undefined) reply.streamed ??= at;
        return;
      }
      case 'session.step.ended': {
        const reply = this.#replyOf(sessionId, data);
        if (reply === undefined) return;
        reply.end = at;
        const usage = usageOf(data['tokens']);
        if (usage !== undefined) reply.usage = usage;
        return;
      }
      case 'session.step.failed': {
        const reply = this.#replyOf(sessionId, data);
        if (reply === undefined) return;
        reply.end = at;
        const usage = usageOf(data['tokens']);
        if (usage !== undefined) reply.usage = usage;
        Object.assign(reply, settledAs(data['error']));
        return;
      }
      case 'session.tool.input.started': {
        const id = idOf(data['id']);
        const name = stringOf(data['name']);
        const work = id === undefined || name === undefined ? undefined : this.#workOf(sessionId, at, false);
        if (work !== undefined && id !== undefined && name !== undefined && !work.tools.has(id)) {
          work.tools.set(id, { name, asked: at });
        }
        return;
      }
      case 'session.tool.called': {
        const tool = this.#toolOf(sessionId, data);
        if (tool !== undefined) tool.called ??= at;
        return;
      }
      case 'session.tool.progress':
        this.#link(sessionId, data);
        return;
      case 'session.tool.success': {
        const tool = this.#link(sessionId, data);
        if (tool !== undefined) tool.end = at;
        return;
      }
      case 'session.tool.failed': {
        const tool = this.#link(sessionId, data);
        if (tool === undefined) return;
        tool.end = at;
        if (fieldsOf(data['error'])?.['type'] === ABORTED) tool.cancelled = true;
        else tool.errorType = 'ToolError';
        return;
      }
      case 'session.compaction.started':
        this.#workOf(sessionId, at, true)?.compactions.push({ start: at });
        return;
      case 'session.compaction.ended':
      case 'session.compaction.failed': {
        const compaction = this.#work(sessionId)?.compactions.findLast((each) => each.end === undefined);
        if (compaction === undefined) return;
        compaction.end = at;
        const model = fieldsOf(data['model']);
        const id = stringOf(model?.['id']);
        const provider = stringOf(model?.['providerID']);
        const usage = usageOf(data['tokens']);
        if (id !== undefined) compaction.model = id;
        if (provider !== undefined) compaction.provider = provider;
        if (usage !== undefined) compaction.usage = usage;
        return;
      }
      case 'session.execution.succeeded':
        this.#close(sessionId, at, {});
        return;
      case 'session.execution.failed':
        this.#close(sessionId, at, { errorType: errorTypeOf(fieldsOf(data['error'])?.['type'], 'Error') });
        return;
      case 'session.execution.interrupted':
        // OpenCode's own shutdown: the turn goes on when the execution resumes.
        if (data['reason'] !== 'shutdown') this.#close(sessionId, at, { cancelled: true });
        return;
      default:
        return;
    }
  }

  #session(sessionId: string): Session {
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      session = {};
      this.#sessions.set(sessionId, session);
    }
    return session;
  }

  /** The session the subagent `sessionId` works for, at the top of its line; nothing where the line runs too deep. */
  #rootOf(sessionId: string): string | undefined {
    let id = sessionId;
    for (let hop = 0; hop <= MAX_DEPTH; hop++) {
      const parent = this.#sessions.get(id)?.parent;
      if (parent === undefined) return id;
      id = parent;
    }
    return undefined;
  }

  /** Where the session's work goes now, if anywhere. */
  #work(sessionId: string): Work | undefined {
    const session = this.#sessions.get(sessionId);
    return session?.parent === undefined ? session?.turn : session.work;
  }

  /**
   * Where the session's work goes, opening a turn for a model call in a
   * session of its own where none is open: one already running when the
   * plugin was loaded is recorded from there on. A subagent's work is kept
   * only while the turn that started it runs; after it, nothing would hold it.
   */
  #workOf(sessionId: string, at: number, opening: boolean): Work | undefined {
    const session = this.#session(sessionId);
    if (session.parent === undefined) {
      if (session.turn === undefined && opening) session.turn = { ...newWork(), start: at };
      return session.turn;
    }
    const root = this.#rootOf(sessionId);
    if (root === undefined || this.#sessions.get(root)?.turn === undefined) return undefined;
    return (session.work ??= newWork());
  }

  #replyOf(sessionId: string, data: Fields): Reply | undefined {
    const id = idOf(data['assistantMessageID']);
    return id === undefined ? undefined : this.#work(sessionId)?.replies.get(id);
  }

  #toolOf(sessionId: string, data: Fields): Tool | undefined {
    const id = idOf(data['id']);
    return id === undefined ? undefined : this.#work(sessionId)?.tools.get(id);
  }

  /**
   * The call `data` names. A subagent's call names the session it started
   * in its metadata, the one field of the metadata read; that session is
   * then known to work for this one, even where its creation went unseen.
   */
  #link(sessionId: string, data: Fields): Tool | undefined {
    const tool = this.#toolOf(sessionId, data);
    if (tool === undefined || !SUBAGENT_TOOLS.has(tool.name)) return tool;
    const metadata = fieldsOf(data['metadata']);
    const child = idOf(metadata?.['sessionID']) ?? idOf(metadata?.['sessionId']);
    if (child !== undefined && child !== sessionId) {
      tool.child ??= child;
      this.#session(child).parent ??= sessionId;
    }
    return tool;
  }

  #close(sessionId: string, at: number, outcome: Pick<Span, 'errorType' | 'cancelled'>): void {
    const session = this.#sessions.get(sessionId);
    const turn = session?.turn;
    if (session === undefined || turn === undefined) return;
    delete session.turn;
    const record = this.#recordOf(sessionId, turn, at, outcome);
    // What the turn's subagents did is now the turn's, or no one's.
    for (const [id, other] of this.#sessions) {
      if (other.work !== undefined && id !== sessionId && this.#rootOf(id) === sessionId) delete other.work;
    }
    if (record !== undefined) this.#deps.send(record);
  }

  #recordOf(
    sessionId: string,
    turn: Turn,
    at: number,
    outcome: Pick<Span, 'errorType' | 'cancelled'>,
  ): RunRecord | undefined {
    const calls = modelCallsOf(turn, at);
    const anchor = turn.anchor ?? turn.firstReply;
    // Nothing of the model's: no run.
    if (calls.length === 0 || anchor === undefined) return undefined;
    const items: Array<CallRecord | StepRecord> = [...calls];
    const runs = subagentRuns(turn);
    for (const tool of turn.tools.values()) {
      const span = toolSpanOf(tool, at);
      if (tool.child === undefined || !SUBAGENT_TOOLS.has(tool.name)) {
        items.push(toolCall(tool.name, span));
        continue;
      }
      const to = runs.get(tool.child)?.find((start) => start > span.start) ?? Number.POSITIVE_INFINITY;
      const inner = this.#subagentCalls(tool.child, span.start, to, at, 1);
      items.push(subagentStep(this.#sessions.get(tool.child)?.agent, span, inner));
    }
    return runOf(sessionId, anchor, { start: turn.start, end: at, ...outcome }, items);
  }

  /**
   * A subagent's calls made from `from` until `to`, with its own subagents'
   * beside the calls that started them: a step holds calls, not steps.
   */
  #subagentCalls(child: string, from: number, to: number, until: number, depth: number): CallRecord[] {
    const work = this.#sessions.get(child)?.work;
    if (work === undefined) return [];
    const within = (start: number): boolean => start >= from && start < to;
    const calls: CallRecord[] = modelCallsOf(work, until).filter((call) => within(Number(call.start)));
    const runs = subagentRuns(work);
    for (const tool of work.tools.values()) {
      const span = toolSpanOf(tool, until);
      if (!within(span.start)) continue;
      calls.push(toolCall(tool.name, span));
      if (tool.child !== undefined && depth < MAX_DEPTH && SUBAGENT_TOOLS.has(tool.name)) {
        const next = runs.get(tool.child)?.find((start) => start > span.start) ?? Number.POSITIVE_INFINITY;
        calls.push(...this.#subagentCalls(tool.child, span.start, next, until, depth + 1));
      }
    }
    return calls;
  }
}

/** Follows the stream until OpenCode unloads the plugin; an event the plugin cannot read is passed over. */
async function follow(
  events: NonNullable<V2Context['event']>,
  signal: AbortSignal,
  turns: V2Turns,
  log: (line: string) => void,
): Promise<void> {
  try {
    for await (const event of events.subscribe({ signal })) {
      try {
        turns.handle(event ?? {});
      } catch (error) {
        log(`event not read: ${kindOf(error)}`);
      }
    }
  } catch (error) {
    if (!signal.aborted) log(`event stream ended: ${kindOf(error)}`);
  }
}

/**
 * OpenCode 2's entry: called once where OpenCode loads the plugin. It
 * returns at once, the stream followed in the background. The cleanup it
 * returns alone waits, a few seconds at most: OpenCode runs it as it unloads
 * the plugin, and as its server shuts down.
 */
export async function setup(context: V2Context): Promise<V2Cleanup | undefined> {
  let connection: ReturnType<typeof connect>;
  try {
    connection = connect(2);
  } catch {
    // No folder known to say so in: a plugin that does nothing, rather than one OpenCode sees fail.
    return undefined;
  }
  if (connection === undefined) return undefined;
  const events = context?.event;
  if (typeof events?.subscribe !== 'function') {
    connection.log("OpenCode's event stream not found; nothing is sent");
    return undefined;
  }
  const { outbox, log } = connection;
  const turns = new V2Turns({ send: (record) => outbox.send(record), log });
  const stop = new AbortController();
  void follow(events, stop.signal, turns, log);
  return () => {
    stop.abort();
    return outbox.drain();
  };
}
