/**
 * OpenCode 1: a plugin is a function OpenCode calls with its client, and its
 * `event` hook sees every event of the folder it was loaded for. A turn runs
 * from a session's `busy` to its `idle`; the replies OpenCode writes in
 * between are noted by id as they appear, and at `idle` the session's
 * messages are read through the client and the turn recorded from them.
 *
 * Of a reply the plugin reads its ids, times, model, provider, agent, token
 * counts and the kind of its error; of a part its type and times, and of a
 * tool part its name, status, and two fields of its metadata: whether it was
 * interrupted, and the subagent session it started. Never a part's text, a
 * tool's input, output or title, a path, or an error's message.
 */

import type { CallRecord, ModelCallRecord, RunRecord, StepRecord, Usage } from 'telmoni';

import { kindOf } from './log.js';
import {
  type Fields,
  type V1Client,
  type V1Event,
  type V1Hooks,
  type V1Input,
  type V1Message,
  type V1Result,
  fieldsOf,
  idOf,
  stringOf,
  timeOf,
  v1MessageOf,
} from './opencode.js';
import {
  MAX_DEPTH,
  SUBAGENT_TOOLS,
  type Span,
  addUsage,
  agentOf,
  errorTypeOf,
  modelCall,
  runOf,
  subagentStep,
  toolCall,
  usageOf,
} from './record.js';
import { connect } from './send.js';

/** How many messages one read asks for; a longer turn is read a page further back. */
const PAGE_SIZE = 50;

/** The most pages one read goes back; past them, a turn is recorded from what was read. */
const MAX_PAGES = 40;

/**
 * A reply made this long before its session went busy was not made by this
 * turn, whatever brought it up again; the margin is the clock's.
 */
const SLACK_MS = 1_000;

/** OpenCode 1's name for the error of a reply the person interrupted. */
const ABORTED = 'MessageAbortedError';

/** A read OpenCode answered with an error: its status is all the log keeps. */
class ReadError extends Error {
  override readonly name = 'ReadError';
  readonly code: string;

  constructor(result: V1Result | undefined) {
    super('OpenCode did not answer the read');
    const status = result?.response?.status;
    this.code = typeof status === 'number' ? String(status) : 'malformed';
  }
}

function createdOf(message: V1Message): number | undefined {
  return timeOf(fieldsOf(message.info['time'])?.['created']);
}

function completedOf(message: V1Message): number | undefined {
  return timeOf(fieldsOf(message.info['time'])?.['completed']);
}

function isReply(message: V1Message): boolean {
  return message.info['role'] === 'assistant' && createdOf(message) !== undefined;
}

/** In the order OpenCode made them; their ids rise with time too. */
function byCreation(a: V1Message, b: V1Message): number {
  return (createdOf(a) ?? 0) - (createdOf(b) ?? 0) || String(a.info['id']).localeCompare(String(b.info['id']));
}

/**
 * Whether a reply was the model's: a step of it began or finished, or it
 * failed. A command the person ran in the shell is written as a reply too,
 * holding the command as a tool, with no step at all.
 */
function isModelReply(reply: V1Message): boolean {
  return (
    reply.parts.some((part) => part['type'] === 'step-start' || part['type'] === 'step-finish') ||
    fieldsOf(reply.info['error']) !== undefined
  );
}

function outcomeOf(reply: V1Message): Pick<Span, 'errorType' | 'cancelled'> {
  const error = fieldsOf(reply.info['error']);
  if (error === undefined) return {};
  return error['name'] === ABORTED ? { cancelled: true } : { errorType: errorTypeOf(error['name'], 'Error') };
}

/** When the model's answer ended: its last text or thought, or the last tool it asked for. */
function answeredAt(reply: V1Message, created: number): number | undefined {
  let last: number | undefined;
  for (const part of reply.parts) {
    const time =
      part['type'] === 'tool'
        ? timeOf(fieldsOf(fieldsOf(part['state'])?.['time'])?.['start'])
        : part['type'] === 'text' || part['type'] === 'reasoning'
          ? timeOf(fieldsOf(part['time'])?.['end'])
          : undefined;
    if (time !== undefined && time >= created && (last === undefined || time > last)) last = time;
  }
  return last;
}

/**
 * A reply of the model as a model call, from the request to the end of its
 * answer: a reply's own completion waits on the tools it asked for, which
 * are calls of their own.
 */
function modelCallOf(reply: V1Message): ModelCallRecord | undefined {
  const model = stringOf(reply.info['modelID']);
  const created = createdOf(reply);
  if (model === undefined || created === undefined) return undefined;
  const completed = completedOf(reply);
  const answered = answeredAt(reply, created);
  const end = answered === undefined ? (completed ?? created) : Math.min(answered, completed ?? answered);
  // Each step's tokens are written apart, and a reply's own count holds only
  // its last step's; with no step finished, it is the reply's own or none.
  let usage: Usage | undefined;
  let finished = false;
  for (const part of reply.parts) {
    if (part['type'] !== 'step-finish') continue;
    usage = addUsage(usage, usageOf(part['tokens']));
    finished = true;
  }
  if (!finished) {
    const own = usageOf(reply.info['tokens']);
    if (own !== undefined && (own.inputTokens ?? 0) + (own.outputTokens ?? 0) > 0) usage = own;
  }
  return modelCall(model, stringOf(reply.info['providerID']), { start: created, end, ...outcomeOf(reply) }, usage);
}

function toolSpanOf(part: Fields, replyEnd: number): Span {
  const state = fieldsOf(part['state']);
  const time = fieldsOf(state?.['time']);
  const start = timeOf(time?.['start']) ?? replyEnd;
  const end = timeOf(time?.['end']) ?? start;
  switch (state?.['status']) {
    case 'completed':
      return { start, end };
    case 'error':
      // OpenCode marks a tool the person interrupted as an error, with this
      // flag in its metadata; nothing else of the metadata is read.
      return fieldsOf(state['metadata'])?.['interrupted'] === true
        ? { start, end, cancelled: true }
        : { start, end, errorType: 'ToolError' };
    default:
      // Never answered: the turn was interrupted first.
      return { start, end: Math.max(start, replyEnd), cancelled: true };
  }
}

/** The subagent session a `task` call started, as OpenCode keeps it in the call's metadata. */
function childOf(part: Fields): string | undefined {
  const metadata = fieldsOf(fieldsOf(part['state'])?.['metadata']);
  return idOf(metadata?.['sessionId']) ?? idOf(metadata?.['sessionID']);
}

/** When each subagent session was started or taken up again by a call among `replies`, earliest first. */
function subagentRuns(replies: readonly V1Message[]): Map<string, number[]> {
  const runs = new Map<string, number[]>();
  for (const reply of replies) {
    for (const part of reply.parts) {
      if (part['type'] !== 'tool' || !SUBAGENT_TOOLS.has(String(part['tool']))) continue;
      const child = childOf(part);
      const start = timeOf(fieldsOf(fieldsOf(part['state'])?.['time'])?.['start']);
      if (child !== undefined && start !== undefined) runs.set(child, [...(runs.get(child) ?? []), start]);
    }
  }
  for (const starts of runs.values()) starts.sort((a, b) => a - b);
  return runs;
}

/**
 * A subagent session's messages, oldest first, back to `from` at least, or
 * nothing where it could not be read.
 */
type ReadSession = (sessionId: string, from: number) => Promise<readonly V1Message[] | undefined>;

function isCall(item: CallRecord | StepRecord): item is CallRecord {
  return item.type !== 'step';
}

/**
 * The calls among `replies`. A subagent's call, its session read, is at the
 * top (`depth` 0) a step of the subagent's own calls, and below it the
 * subagent's calls beside the call that started it. A subagent session taken
 * up again by a later call is read from each call to the next.
 */
async function callsIn(
  replies: readonly V1Message[],
  depth: number,
  until: number,
  readSession: ReadSession,
): Promise<Array<CallRecord | StepRecord>> {
  const items: Array<CallRecord | StepRecord> = [];
  const runs = subagentRuns(replies);
  for (const reply of replies) {
    const call = modelCallOf(reply);
    if (call === undefined) continue;
    items.push(call);
    const replyEnd = completedOf(reply) ?? until;
    for (const part of reply.parts) {
      const name = part['type'] === 'tool' ? stringOf(part['tool']) : undefined;
      if (name === undefined) continue;
      const span = toolSpanOf(part, replyEnd);
      const child = depth < MAX_DEPTH && SUBAGENT_TOOLS.has(name) ? childOf(part) : undefined;
      const starts = child === undefined ? undefined : runs.get(child);
      const read = child === undefined ? undefined : await readSession(child, starts?.[0] ?? span.start);
      if (child === undefined || read === undefined) {
        items.push(toolCall(name, span));
        continue;
      }
      const to = starts?.find((start) => start > span.start) ?? Number.POSITIVE_INFINITY;
      const within = read.filter((message) => {
        const created = createdOf(message);
        return created !== undefined && created >= span.start && created < to;
      });
      const theirs = within.filter(isReply).filter(isModelReply).sort(byCreation);
      const inner = (await callsIn(theirs, depth + 1, until, readSession)).filter(isCall);
      if (depth === 0) {
        const agent = within.map((message) => agentOf(message.info['agent'])).find((found) => found !== undefined);
        items.push(subagentStep(agent, span, inner));
      } else {
        items.push(toolCall(name, span), ...inner);
      }
    }
  }
  return items;
}

/**
 * The turn whose replies are `replies` as a run, or nothing where none of
 * them was the model's. It is named by the prompt it answers; a turn taking
 * up a prompt an earlier turn already answered is named by its first reply
 * instead, so two turns never share a run id.
 */
async function turnOf(
  sessionId: string,
  messages: readonly V1Message[],
  replies: ReadonlySet<string>,
  readSession: ReadSession,
): Promise<RunRecord | undefined> {
  const turn = messages.filter((message) => isReply(message) && replies.has(String(message.info['id']))).sort(byCreation);
  const answered = turn.filter(isModelReply);
  const first = answered[0];
  const last = answered.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const firstCreated = createdOf(first)!;
  const prompt = idOf(first.info['parentID']);
  const taken = messages.some(
    (message) =>
      isReply(message) &&
      !replies.has(String(message.info['id'])) &&
      message.info['parentID'] === prompt &&
      createdOf(message)! < firstCreated,
  );
  const anchor = prompt !== undefined && !taken ? prompt : String(first.info['id']);
  const user = messages.find((message) => message.info['id'] === prompt && message.info['role'] === 'user');
  const opened = user === undefined ? undefined : createdOf(user);
  const until = Math.max(...turn.map((message) => completedOf(message) ?? createdOf(message)!));
  const items = await callsIn(answered, 0, until, readSession);
  return runOf(
    sessionId,
    anchor,
    { start: Math.min(opened ?? firstCreated, firstCreated), end: until, ...outcomeOf(last) },
    items,
  );
}

/** Whether `messages` hold every reply of the turn, and the prompt its first reply answers. */
function covers(messages: readonly V1Message[], replies: ReadonlySet<string>): boolean {
  const ids = new Set(messages.map((message) => message.info['id']));
  for (const id of replies) if (!ids.has(id)) return false;
  const first = messages.filter((message) => isReply(message) && replies.has(String(message.info['id']))).sort(byCreation)[0];
  const prompt = idOf(first?.info['parentID']);
  return prompt === undefined || ids.has(prompt);
}

/** The first characters of a session's id: enough to tell its lines apart in the log. */
function tag(sessionId: string): string {
  return sessionId.slice(0, 12);
}

interface Open {
  /** When the session went busy, as the plugin saw it. */
  since: number;
  /** The replies OpenCode made while it was. */
  replies: Set<string>;
}

export interface V1Deps {
  client: V1Client;
  send: (record: RunRecord) => void;
  log: (line: string) => void;
  /** How many messages one read asks for. */
  pageSize?: number;
  /** The clock a session's going busy is read from. */
  now?: () => number;
}

/** The turns of every session in the folder, each recorded once it has ended. */
export class V1Turns {
  readonly #deps: V1Deps;
  readonly #open = new Map<string, Open>();
  /** Each session's parent where OpenCode named one, null where it has none. */
  readonly #parents = new Map<string, string | null>();
  readonly #pending = new Set<Promise<void>>();

  constructor(deps: V1Deps) {
    this.#deps = deps;
  }

  /**
   * One event. OpenCode calls the hook from inside its own publishing, so
   * this only notes what it needs and returns; reading a turn that has
   * ended goes on after.
   */
  handle(event: V1Event): void {
    const properties = fieldsOf(event.properties);
    if (properties === undefined) return;
    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        const info = fieldsOf(properties['info']);
        const id = idOf(info?.['id']);
        if (info !== undefined && id !== undefined) this.#parents.set(id, idOf(info['parentID']) ?? null);
        return;
      }
      case 'session.deleted': {
        const id = idOf(properties['sessionID']) ?? idOf(fieldsOf(properties['info'])?.['id']);
        if (id !== undefined) {
          this.#open.delete(id);
          this.#parents.delete(id);
        }
        return;
      }
      case 'session.status': {
        const id = idOf(properties['sessionID']);
        const status = fieldsOf(properties['status'])?.['type'];
        if (id === undefined) return;
        if (status === 'busy' || status === 'retry') {
          if (!this.#open.has(id)) this.#open.set(id, { since: (this.#deps.now ?? Date.now)(), replies: new Set() });
        } else if (status === 'idle') {
          this.#close(id);
        }
        return;
      }
      case 'session.idle': {
        // Deprecated, and sent just after `session.status` turns idle:
        // whichever comes first ends the turn, so a release without either
        // still ends it.
        const id = idOf(properties['sessionID']);
        if (id !== undefined) this.#close(id);
        return;
      }
      case 'message.updated': {
        const info = fieldsOf(properties['info']);
        if (info?.['role'] !== 'assistant') return;
        const open = this.#open.get(idOf(info['sessionID']) ?? idOf(properties['sessionID']) ?? '');
        const id = idOf(info['id']);
        const created = timeOf(fieldsOf(info['time'])?.['created']);
        // A fork copies its history through this same event, outside any
        // busy turn of its own: only what is made while a session is busy
        // is its turn's.
        if (open !== undefined && id !== undefined && created !== undefined && created >= open.since - SLACK_MS) {
          open.replies.add(id);
        }
        return;
      }
      case 'message.removed': {
        // Taken back while its turn ran: a reply the read would otherwise
        // look for back to the session's start, and never find.
        const id = idOf(properties['messageID']);
        if (id !== undefined) this.#open.get(idOf(properties['sessionID']) ?? '')?.replies.delete(id);
        return;
      }
      default:
        return;
    }
  }

  /** Settles once every turn being read has been handed on. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  #close(sessionId: string): void {
    const open = this.#open.get(sessionId);
    if (open === undefined) return;
    this.#open.delete(sessionId);
    if (open.replies.size === 0) return;
    const work = this.#record(sessionId, open.replies).catch((error: unknown) =>
      this.#deps.log(`${tag(sessionId)}: turn not read: ${kindOf(error)}`),
    );
    this.#pending.add(work);
    void work.finally(() => this.#pending.delete(work));
  }

  async #record(sessionId: string, replies: ReadonlySet<string>): Promise<void> {
    // A subagent's session: its work is a step of its parent's turn, read from there.
    if ((await this.#parentOf(sessionId)) !== null) return;
    const messages = await this.#read(sessionId, (read) => covers(read, replies));
    // Each subagent session is read once a turn, back to the first call that ran it.
    const children = new Map<string, Promise<readonly V1Message[] | undefined>>();
    const readSession: ReadSession = (child, from) => {
      let read = children.get(child);
      if (read === undefined) {
        const reachesBack = (read: readonly V1Message[]): boolean => {
          const oldest = read[0] === undefined ? undefined : createdOf(read[0]);
          return oldest !== undefined && oldest < from;
        };
        read = this.#read(child, reachesBack).catch((error: unknown) => {
          // The subagent's call stands as a call, without the subagent's own.
          this.#deps.log(`${tag(sessionId)}: subagent not read: ${kindOf(error)}`);
          return undefined;
        });
        children.set(child, read);
      }
      return read;
    };
    const record = await turnOf(sessionId, messages, replies, readSession);
    if (record !== undefined) this.#deps.send(record);
  }

  async #parentOf(sessionId: string): Promise<string | null> {
    const known = this.#parents.get(sessionId);
    if (known !== undefined) return known;
    const result = await this.#deps.client.session.get({ path: { id: sessionId } });
    const info = fieldsOf(result?.data);
    if (info === undefined) throw new ReadError(result);
    const parent = idOf(info['parentID']) ?? null;
    this.#parents.set(sessionId, parent);
    return parent;
  }

  /**
   * The session's messages, oldest first: its newest page, then a page
   * further back each time until `enough` holds or there is nothing older.
   */
  async #read(sessionId: string, enough: (messages: readonly V1Message[]) => boolean): Promise<V1Message[]> {
    const limit = this.#deps.pageSize ?? PAGE_SIZE;
    const pages: V1Message[][] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.#deps.client.session.messages({
        path: { id: sessionId },
        query: before === undefined ? { limit } : { limit, before },
      });
      if (!Array.isArray(result?.data)) throw new ReadError(result);
      pages.unshift((result.data as unknown[]).flatMap((value) => v1MessageOf(value) ?? []));
      const read = pages.flat();
      if (enough(read)) return read;
      const next = result.response?.headers?.get('X-Next-Cursor');
      if (typeof next !== 'string' || next === '') return read;
      before = next;
    }
    return pages.flat();
  }
}

function clientOf(value: unknown): V1Client | undefined {
  const session = fieldsOf(fieldsOf(value)?.['session']);
  return typeof session?.['messages'] === 'function' && typeof session['get'] === 'function'
    ? (value as V1Client)
    : undefined;
}

/**
 * OpenCode 1's entry: called once for each folder OpenCode opens, with that
 * folder's client. The hooks never throw into OpenCode, and the event hook
 * never waits on the network: a turn is read after the event that ended it
 * and sent in the background. `dispose` alone waits, a few seconds at most:
 * OpenCode runs it as it closes the folder, a one-shot `opencode run` before
 * it exits.
 */
export async function server(input: V1Input): Promise<V1Hooks> {
  let connection: ReturnType<typeof connect>;
  try {
    connection = connect(1);
  } catch {
    // No folder known to say so in: a plugin that does nothing, rather than one OpenCode sees fail.
    return {};
  }
  if (connection === undefined) return {};
  const client = clientOf(input?.client);
  if (client === undefined) {
    connection.log("OpenCode's client not understood; nothing is sent");
    return {};
  }
  const { outbox, log } = connection;
  const turns = new V1Turns({ client, send: (record) => outbox.send(record), log });
  return {
    event: async (hook) => {
      try {
        turns.handle(hook?.event ?? {});
      } catch (error) {
        log(`event not read: ${kindOf(error)}`);
      }
    },
    // The turns still being read, then everything waiting to be sent.
    dispose: () => outbox.drain(turns.settled()),
  };
}
