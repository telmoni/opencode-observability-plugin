/**
 * The plugin's log, `plugin.log` in its folder: a line per thing that went wrong, naming its kind and never anything
 * from a session — no text, no path, no key — since the plugin runs inside OpenCode, whose screen is the person's.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Past this, the log is moved aside to `plugin.log.1` and begun again. */
const MAX_BYTES = 1024 * 1024;

/** Writes `line` to the log in `dir`; with no folder to write in, it is dropped. */
export function log(dir: string | undefined, line: string): void {
  if (dir === undefined) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'plugin.log');
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No log yet.
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // Nowhere left to say so; OpenCode must never see the plugin fail.
  }
}

/** The first characters of a session's id: enough to tell its lines apart in the log. */
export function tag(sessionId: string): string {
  return sessionId.slice(0, 12);
}

/** An error's class, which is all of it the log keeps. */
export function kindOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name}:${code}` : error.name;
  }
  return typeof error;
}
