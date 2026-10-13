/**
 * Sends each finished turn through the TypeScript SDK, one export each, from
 * a client of its own, whose warnings are then that turn's alone: a turn the
 * SDK could not deliver is kept, and sent again before the next one. The
 * same record sent again is the same bytes, which ingest answers once.
 *
 * Every send goes through one chain, so two turns ending together never send
 * at once, and nothing OpenCode waits on waits on it — but OpenCode's
 * shutdown, which waits for it a few seconds at most.
 */

import { Telmoni } from 'telmoni';
import type { RunRecord } from 'telmoni';

import { kindOf, log as writeLog } from './log.js';
import { settingsFrom } from './settings.js';

/** How long one turn's export may take, its retries included. */
const FLUSH_SECONDS = 45;

/** How many turns the platform has not taken are kept to send again: the newest. */
const KEEP = 200;

/**
 * The most OpenCode is held, as it shuts down, for the turns still to send:
 * a one-shot `opencode run` exits as its turn ends, and nothing interactive
 * waits on a shutdown.
 */
export const SHUTDOWN_WAIT_MS = 3_000;

export interface Destination {
  endpoint: string | undefined;
  apiKey: string;
}

/**
 * How the SDK words an export it gave up on after its own retries — a
 * connection that failed or timed out, a `429` or a `503` — the one failure
 * that sending the same bytes later may mend. Every other warning is an
 * answer: a refusal, or a span refused or a field dropped from an export
 * that was taken, which ingest gives again for the hour to the same bytes.
 */
const GAVE_UP = 'telmoni: export failed after ';

/** One turn's send, through a client made for it and shut down after. */
export class Sender {
  readonly #telmoni: Telmoni;
  readonly #warnings: string[] = [];
  readonly #log: (line: string) => void;

  constructor(destination: Destination, log: (line: string) => void) {
    this.#log = log;
    // The SDK's warnings name kinds and the platform's answers, never a
    // session's content, which a record never holds.
    this.#telmoni = new Telmoni(
      { endpoint: destination.endpoint, apiKey: destination.apiKey },
      { warn: (message) => void this.#warnings.push(message) },
    );
  }

  /**
   * Whether the turn is done with: false only where it is worth sending
   * again, its export unfinished in time or given up on by the SDK. A turn
   * the platform answered is done, taken or not: a refusal, whole or of a
   * span, would come back however often it was sent, and a turn kept for it
   * would hold back every turn after it. A record the SDK refuses is done
   * for the same reason.
   */
  async send(record: RunRecord): Promise<boolean> {
    try {
      this.#telmoni.recordRun(record);
    } catch (error) {
      this.#log(`turn refused by the SDK: ${kindOf(error)}`);
      return true;
    }
    const flushed = await this.#telmoni.flush(FLUSH_SECONDS);
    const warnings = this.#warnings.join('; ');
    if (!flushed) {
      this.#log('not sent in time; kept to send again');
      return false;
    }
    if (this.#warnings.some((warning) => warning.startsWith(GAVE_UP))) {
      this.#log(`not sent; kept to send again: ${warnings}`);
      return false;
    }
    if (this.#warnings.length > 0) this.#log(`Telmoni did not take all of the turn: ${warnings}`);
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
}

/** The first characters of a session's id: enough to tell its lines apart in the log. */
function tag(record: RunRecord): string {
  return (record.sessionId ?? record.runId).slice(0, 12);
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
      // Held, not unref'd: OpenCode waits on this as it shuts down, and must
      // be let go when the time is up whatever else holds the process.
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The turns waiting to be sent, oldest first, and the one chain they are
 * sent through. A turn that ends starts a round: every turn waiting is sent
 * in order, and a turn the SDK could not deliver ends the round, kept with
 * those after it for the next — a Telmoni that does not answer is asked once
 * a round, not once a turn.
 */
export class Outbox {
  readonly #deps: OutboxDeps;
  readonly #waiting: RunRecord[] = [];
  #chain: Promise<void> = Promise.resolve();
  /** Whether a round is already waiting its place in the chain, and will find whatever is added before it starts. */
  #due = false;

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
      });
    }
    return this.#chain;
  }

  /**
   * For OpenCode's shutdown alone: sends what is waiting, and what `before`
   * hands over as it settles, waiting for it all for `ms` at most.
   */
  drain(before: Promise<unknown> = Promise.resolve(), ms: number = SHUTDOWN_WAIT_MS): Promise<void> {
    return within(ms, Promise.all([this.flush(), before.catch(() => undefined)]).then(() => this.flush()));
  }

  async #round(): Promise<void> {
    for (;;) {
      const record = this.#waiting[0];
      if (record === undefined) return;
      if (!(await this.#once(record))) return;
      // Found by itself rather than by place: older turns may have been
      // dropped while it was being sent.
      const at = this.#waiting.indexOf(record);
      if (at !== -1) this.#waiting.splice(at, 1);
    }
  }

  async #once(record: RunRecord): Promise<boolean> {
    const log = (line: string): void => this.#deps.log(`${tag(record)}: ${line}`);
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

/**
 * What a loaded plugin sends with, or nothing, said once in the log, where it
 * has no key or the SDK refuses its endpoint. Read as OpenCode loads the
 * plugin: a key set later takes effect from OpenCode's next start.
 */
export function connect(major: 1 | 2, env: NodeJS.ProcessEnv = process.env): Connection | undefined {
  const settings = settingsFrom(env);
  const log = (line: string): void => writeLog(settings.dir, `opencode ${major}: ${line}`);
  if (settings.keyFileProblem !== undefined) log(`key file not used: ${settings.keyFileProblem}`);
  if (settings.apiKey === undefined) {
    log('no key: set TELMONI_API_KEY, or apiKey in telmoni.json beside your OpenCode configuration; nothing is sent until then');
    return undefined;
  }
  const destination: Destination = { endpoint: settings.endpoint, apiKey: settings.apiKey };
  try {
    // Asked once here, the SDK refuses an endpoint that would carry the key
    // in the clear, plain HTTP off this machine; the turns' own clients are
    // then never refused.
    void new Sender(destination, log).close().catch(() => undefined);
  } catch (error) {
    log(`endpoint refused by the SDK: ${kindOf(error)}; nothing is sent`);
    return undefined;
  }
  return { outbox: new Outbox({ sender: (turnLog) => new Sender(destination, turnLog), log }), log };
}
