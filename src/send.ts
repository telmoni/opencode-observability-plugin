/**
 * Sends each finished turn through the TypeScript SDK from a client of its own, whose warnings are that turn's alone; a
 * turn not delivered is kept and sent again, the same bytes, through one chain OpenCode waits on only as it shuts down.
 */

import { Telmoni } from 'telmoni';
import type { RunRecord } from 'telmoni';

import { kindOf, log as writeLog, tag } from './log.js';
import { settingsFrom } from './settings.js';

/** How many turns the platform has not taken are kept to send again: the newest. */
const KEEP = 200;

/** The SDK's batch, unexported like the limits below: 512 spans an export, one export at a time. */
const SDK_BATCH_SPANS = 512;

/** The SDK's attempts at an export. */
const SDK_ATTEMPTS = 3;

/** The SDK's timeout on an attempt. */
const SDK_ATTEMPT_SECONDS = 10;

/** The SDK's longest wait between two attempts, the cap on a `Retry-After`. */
const SDK_RETRY_WAIT_SECONDS = 60;

/** The SDK's worst case for an export, 150 seconds: every attempt timed out, each wait its longest. */
const EXPORT_SECONDS = SDK_ATTEMPTS * SDK_ATTEMPT_SECONDS + (SDK_ATTEMPTS - 1) * SDK_RETRY_WAIT_SECONDS;

/** Past the exports' worst case, so a flush ends on the platform's answer, never before it. */
const FLUSH_SLACK_SECONDS = 30;

/**
 * How long a turn's flush may take: past the SDK's worst case for its exports, or a turn
 * the platform took late is kept, and stored twice if sent again past ingest's hour.
 */
export function flushSecondsOf(record: RunRecord): number {
  // The SDK makes a span of the run, of its start, of each item and of each step's calls.
  let spans = 2;
  for (const item of record.inside ?? []) spans += 1 + (item.type === 'step' ? (item.calls?.length ?? 0) : 0);
  return FLUSH_SLACK_SECONDS + EXPORT_SECONDS * Math.ceil(spans / SDK_BATCH_SPANS);
}

/** How long OpenCode's shutdown waits on the turns still to send: `opencode run` exits as its one turn ends. */
export const SHUTDOWN_WAIT_MS = 3_000;

/**
 * How long after a round a turn still waiting is tried again, where no turn's end has started one: well inside ingest's
 * hour, so a turn delivered in part is finished while ingest still answers the part it took, rather than storing it twice.
 */
export const RETRY_MS = 5 * 60_000;

export interface Destination {
  endpoint: string | undefined;
  apiKey: string;
}

/**
 * The SDK's warnings of spans it could not deliver, which a later round may yet get through: Telmoni out of reach or busy
 * past its retries, or an answer that may change. Every other warning is of bytes delivered, or refused for good.
 */
const UNDELIVERED = /^telmoni: (?:export failed after |an export failed \(|the export queue was full|export refused with (?!400 |401 |402 |403 |413 |500 ))/;
/** Ingest's `500` for a fault of its database, which a later round may find mended, as it would none of its other `500`s. */
const DATABASE_FAILED = /^telmoni: export refused with 500 \/errors\/internal\/database;/;
/**
 * An export refused for good: for what it holds (`400`, `413`), a fault of ingest's own (any other `500`), an organization
 * paused (`402`), or its key (`401`, `403`), which the plugin reads once a load, so every round would be refused alike.
 */
const REFUSED = /^telmoni: export refused with (?:400|401|402|403|413|500) /;

/** One turn's send, through a client made for it and shut down after. */
export class Sender {
  readonly #telmoni: Telmoni;
  readonly #warnings: string[] = [];
  readonly #log: (line: string) => void;

  constructor(destination: Destination, log: (line: string) => void) {
    this.#log = log;
    // The SDK's warnings name kinds and the platform's answers, never a session's content, which a record never holds.
    this.#telmoni = new Telmoni(
      { endpoint: destination.endpoint, apiKey: destination.apiKey },
      {
        warn: (message) => void this.#warnings.push(message),
        // The client is the turn's alone, so its queue takes the turn whole: past 2,048 spans the SDK would refuse it.
        processor: { maxQueueSize: Number.POSITIVE_INFINITY },
      },
    );
  }

  /**
   * Whether the turn is done with: taken, whole or in part, or refused for good, which every round would get again, and
   * kept would hold back every turn after it. The SDK's warnings never carry anything of the session.
   */
  async send(record: RunRecord): Promise<boolean> {
    try {
      this.#telmoni.recordRun(record);
    } catch (error) {
      this.#log(`turn refused by the SDK: ${kindOf(error)}`);
      return true;
    }
    const flushed = await this.#telmoni.flush(flushSecondsOf(record));
    const warnings = this.#warnings.join('; ');
    if (!flushed) {
      this.#log('not sent in time; kept to send again');
      return false;
    }
    if (this.#warnings.some((warning) => UNDELIVERED.test(warning) || DATABASE_FAILED.test(warning))) {
      this.#log(`not sent; kept to send again: ${warnings}`);
      return false;
    }
    if (this.#warnings.some((warning) => REFUSED.test(warning))) this.#log(`refused, not sent again: ${warnings}`);
    else if (this.#warnings.length > 0) this.#log(`taken in part: ${warnings}`);
    return true;
  }

  close(): Promise<void> {
    return this.#telmoni.shutdown();
  }
}

export interface OutboxDeps {
  /** A sender for one turn, logging through `log`. */
  sender: (log: (line: string) => void) => { send(record: RunRecord): Promise<boolean>; close(): Promise<void> };
  log: (line: string) => void;
  /** How many turns not taken are kept. */
  keep?: number;
  /** How long after a round a turn still waiting is tried again. */
  retryMs?: number;
}

/** `work`, or `ms` passing, whichever comes first; never rejects. */
async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      // Held, not unref'd: OpenCode waits on this as it shuts down, and must be let go when the time is up whatever else holds the process.
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The turns waiting to be sent, oldest first, and the one chain they go through: each turn's end starts a round sending
 * them in order, ended by the first not delivered, so a Telmoni that does not answer is asked once a round; while any
 * wait, a round comes on its own too, until OpenCode shuts the plugin down.
 */
export class Outbox {
  readonly #deps: OutboxDeps;
  readonly #waiting: RunRecord[] = [];
  #chain: Promise<void> = Promise.resolve();
  /** Whether a round is already waiting its place in the chain, and will find whatever is added before it starts. */
  #due = false;
  /** The round to come on its own for the turns still waiting. */
  #retry: ReturnType<typeof setTimeout> | undefined;
  /** Set as OpenCode shuts the plugin down, after which no round comes on its own. */
  #draining = false;

  constructor(deps: OutboxDeps) {
    this.#deps = deps;
  }

  /** How many turns are waiting to be sent. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** A turn that has ended: kept behind those still waiting, and a round started. Never waited on. */
  send(record: RunRecord): void {
    this.#waiting.push(record);
    const keep = this.#deps.keep ?? KEEP;
    const over = this.#waiting.length - keep;
    if (over > 0) {
      this.#waiting.splice(0, over);
      this.#deps.log(`dropped ${over} turn${over === 1 ? '' : 's'} Telmoni had not taken, the oldest; the newest ${keep} wait to be sent again`);
    }
    void this.flush();
  }

  /** Starts a round, and settles once it has, the rounds before it with it; never rejects. */
  flush(): Promise<void> {
    if (!this.#due) {
      this.#due = true;
      this.#chain = this.#chain.then(async () => {
        this.#due = false;
        try {
          await this.#round();
        } catch (error) {
          this.#deps.log(`not sent: ${kindOf(error)}`);
        }
        this.#again();
      });
    }
    return this.#chain;
  }

  /**
   * For OpenCode's shutdown alone: sends what is waiting, and what `before`
   * hands over as it settles, waiting for it all for `ms` at most.
   */
  drain(before: Promise<unknown> = Promise.resolve(), ms: number = SHUTDOWN_WAIT_MS): Promise<void> {
    this.#draining = true;
    return within(ms, Promise.all([this.flush(), before.catch(() => undefined)]).then(() => this.flush()));
  }

  /** A round in a while for what still waits; unref'd, so it never holds OpenCode open. */
  #again(): void {
    clearTimeout(this.#retry);
    this.#retry = undefined;
    if (this.#draining || this.#waiting.length === 0) return;
    this.#retry = setTimeout(() => void this.flush(), this.#deps.retryMs ?? RETRY_MS);
    this.#retry.unref();
  }

  async #round(): Promise<void> {
    for (;;) {
      const record = this.#waiting[0];
      if (record === undefined) return;
      if (!(await this.#once(record))) return;
      // Found by itself rather than by place: older turns may have been dropped while it was being sent.
      const at = this.#waiting.indexOf(record);
      if (at !== -1) this.#waiting.splice(at, 1);
    }
  }

  async #once(record: RunRecord): Promise<boolean> {
    const log = (line: string): void => this.#deps.log(`${tag(record.sessionId ?? record.runId)}: ${line}`);
    let sender: ReturnType<OutboxDeps['sender']> | undefined;
    try {
      sender = this.#deps.sender(log);
      return await sender.send(record);
    } catch (error) {
      log(`not sent: ${kindOf(error)}`);
      return false;
    } finally {
      await sender?.close().catch(() => undefined);
    }
  }
}

export interface Connection {
  outbox: Outbox;
  log: (line: string) => void;
}

/** `connect`, or nothing where not even the settings can be read: with nowhere to say so, the plugin does nothing. */
export function connectQuietly(major: 1 | 2): Connection | undefined {
  try {
    return connect(major);
  } catch {
    return undefined;
  }
}

/**
 * What a loaded plugin sends with, or nothing, said once in the log, where it has no key, its key file was passed over
 * or the SDK refuses its endpoint. Read as OpenCode loads the plugin: a key set later takes effect from its next start.
 */
export function connect(major: 1 | 2, env: NodeJS.ProcessEnv = process.env): Connection | undefined {
  const settings = settingsFrom(env);
  const log = (line: string): void => writeLog(settings.dir, `opencode ${major}: ${line}`);
  // The file passed over may have named the endpoint: the key never goes to the default in its place.
  if (settings.keyFileProblem !== undefined) {
    log(`key file not used: ${settings.keyFileProblem}; fix it, or set both TELMONI_API_KEY and TELMONI_ENDPOINT; nothing is sent until then`);
    return undefined;
  }
  if (settings.apiKey === undefined) {
    log('no key: set TELMONI_API_KEY, or apiKey in telmoni.json beside your OpenCode configuration; nothing is sent until then');
    return undefined;
  }
  const destination: Destination = { endpoint: settings.endpoint, apiKey: settings.apiKey };
  try {
    // Asked once, as the plugin loads, so the turns' own clients are never refused.
    void new Sender(destination, log).close().catch(() => undefined);
  } catch (error) {
    // The SDK's reason names at most the endpoint's host, never its path, a key or a password.
    log(`endpoint refused by the SDK; nothing is sent: ${error instanceof TypeError ? error.message : kindOf(error)}`);
    return undefined;
  }
  return { outbox: new Outbox({ sender: (turnLog) => new Sender(destination, turnLog), log }), log };
}
