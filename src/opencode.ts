/**
 * The little of OpenCode the plugin touches, defined here rather than taken
 * from OpenCode's packages: one package serves both majors, which publish
 * their types under different names, and nothing of either is needed at run
 * time. Every value OpenCode hands over is read through the guards below, so
 * a field that changes shape is passed over rather than trusted.
 */

/** A plain object, or nothing. */
export type Fields = Readonly<Record<string, unknown>>;

export function fieldsOf(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : undefined;
}

/** A string with something in it, or nothing. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A time in milliseconds since the epoch, or nothing: ingest reads zero as no time at all. */
export function timeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** An id OpenCode gave a session or message: plain, never a path. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && ID.test(value) ? value : undefined;
}

/**
 * The id a call is matched by, which OpenCode 2 takes from the provider
 * (`toolu_…`, `call_…`, Kimi's `functions.read:0`): only ever compared, never
 * recorded or logged, so any short string.
 */
export function keyOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= 256 ? value : undefined;
}

// OpenCode 1 (`opencode-ai`, `@opencode-ai/plugin`).

/** What the `event` hook is handed: the event's type, and its payload under `properties`. */
export interface V1Event {
  readonly type?: unknown;
  readonly properties?: unknown;
}

/** A call through OpenCode 1's client: `data` on success, `error` otherwise; a network failure rejects. */
export interface V1Result {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: { readonly status?: number; readonly headers?: { get(name: string): string | null } };
}

/** The two reads the plugin makes through the client OpenCode hands it. */
export interface V1Client {
  readonly session: {
    messages(options: {
      path: { id: string };
      query?: { limit?: number; before?: string };
    }): Promise<V1Result>;
    get(options: { path: { id: string } }): Promise<V1Result>;
  };
}

/** What OpenCode 1 hands a plugin; of it, the plugin reads the client alone. */
export interface V1Input {
  readonly client?: unknown;
}

export interface V1Hooks {
  event?: (input: { event: V1Event }) => Promise<void>;
  dispose?: () => Promise<void>;
}

/** A message as the client reads it: its info, and its parts. */
export interface V1Message {
  readonly info: Fields;
  readonly parts: readonly Fields[];
}

export function v1MessageOf(value: unknown): V1Message | undefined {
  const fields = fieldsOf(value);
  const info = fieldsOf(fields?.['info']);
  if (info === undefined || idOf(info['id']) === undefined) return undefined;
  const parts = Array.isArray(fields?.['parts']) ? (fields['parts'] as unknown[]) : [];
  return {
    info,
    parts: parts.flatMap((part): Fields[] => {
      const found = fieldsOf(part);
      return found === undefined ? [] : [found];
    }),
  };
}

// OpenCode 2 (`@opencode/cli`, `@opencode/plugin`).

/** An event as OpenCode 2's stream hands it over: its type, when it was published, and its payload under `data`. */
export interface V2Event {
  readonly type?: unknown;
  readonly created?: unknown;
  readonly data?: unknown;
}

/** The part of OpenCode 2's plugin context the plugin uses: the event stream. */
export interface V2Context {
  readonly event?: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event>;
  };
}

/** What `setup` may hand back: run when OpenCode unloads the plugin. */
export type V2Cleanup = () => Promise<void> | void;
