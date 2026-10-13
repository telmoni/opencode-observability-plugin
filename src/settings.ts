/**
 * Where the plugin sends, and where it keeps its log: the SDKs' own
 * variables first, then `telmoni.json` in OpenCode's configuration folder,
 * which the plugin reads and never writes. Its log lives in the person's
 * state folder, never beside OpenCode's configuration: OpenCode 2 watches
 * that folder and reloads its configuration on every write there.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { kindOf } from './log.js';
import { fieldsOf } from './opencode.js';

export interface Settings {
  apiKey: string | undefined;
  /** Unset, the SDK's own default, Telmoni's machine host. */
  endpoint: string | undefined;
  /** The plugin's folder, for `plugin.log`; unset where there is no home to put it in. */
  dir: string | undefined;
  /** Why a key file was passed over, as a kind for the log. */
  keyFileProblem: string | undefined;
}

export const KEY_FILE = 'telmoni.json';

/** A key file is a few lines; anything this large is not one. */
const MAX_KEY_FILE_BYTES = 64 * 1024;

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const found = env[name]?.trim();
  return found ? found : undefined;
}

/**
 * An absolute folder from `env`, or nothing: the XDG specification has a
 * relative one ignored, and a folder relative to wherever OpenCode was
 * started would be the project's, which the person may not trust.
 */
function absolute(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const found = env[name]?.trim();
  return found && isAbsolute(found) ? found : undefined;
}

/**
 * Where a person keeps the key file: OpenCode's own configuration folders,
 * `OPENCODE_CONFIG_DIR` first where it is set, then `XDG_CONFIG_HOME`'s.
 * Both OpenCode 1 and 2 keep their configuration under XDG on macOS too.
 */
export function configDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const dirs: string[] = [];
  const custom = absolute(env, 'OPENCODE_CONFIG_DIR');
  if (custom !== undefined) dirs.push(custom);
  const config = absolute(env, 'XDG_CONFIG_HOME') ?? (isAbsolute(home) ? join(home, '.config') : undefined);
  if (config !== undefined) dirs.push(join(config, 'opencode'));
  return dirs;
}

interface KeyFile {
  apiKey?: string;
  endpoint?: string;
  problem?: string;
}

/**
 * The key file at `path`, or nothing where there is none. It is read only if
 * it is the person's own and shut to everyone else, as `ssh` reads a key: one
 * others could write could name an endpoint of theirs, and the key would be
 * sent to it.
 */
function readKeyFile(path: string): KeyFile | undefined {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    return { problem: `unreadable (${kindOf(error)})` };
  }
  if (!stat.isFile()) return { problem: 'not a file' };
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) return { problem: 'open to other users; chmod 600 it' };
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return { problem: 'owned by another user' };
  }
  if (stat.size > MAX_KEY_FILE_BYTES) return { problem: 'too large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { problem: error instanceof SyntaxError ? 'not JSON' : `unreadable (${kindOf(error)})` };
  }
  const fields = fieldsOf(parsed);
  if (fields === undefined) return { problem: 'not a JSON object' };
  const file: KeyFile = {};
  const apiKey = typeof fields['apiKey'] === 'string' ? fields['apiKey'].trim() : '';
  const endpoint = typeof fields['endpoint'] === 'string' ? fields['endpoint'].trim() : '';
  if (apiKey !== '') file.apiKey = apiKey;
  if (endpoint !== '') file.endpoint = endpoint;
  return file;
}

/** The person's home, as the environment the plugin was handed gives it. */
function homeOf(env: NodeJS.ProcessEnv): string {
  return absolute(env, 'HOME') ?? homedir();
}

export function settingsFrom(env: NodeJS.ProcessEnv, home: string = homeOf(env)): Settings {
  const state = absolute(env, 'XDG_STATE_HOME') ?? (isAbsolute(home) ? join(home, '.local', 'state') : undefined);
  const settings: Settings = {
    apiKey: value(env, 'TELMONI_API_KEY'),
    endpoint: value(env, 'TELMONI_ENDPOINT'),
    dir: state === undefined ? undefined : join(state, 'telmoni', 'opencode'),
    keyFileProblem: undefined,
  };
  if (settings.apiKey !== undefined && settings.endpoint !== undefined) return settings;
  // The first key file found is the one: a second, further down, is not a
  // fallback for one that was refused.
  for (const dir of configDirs(env, home)) {
    const file = readKeyFile(join(dir, KEY_FILE));
    if (file === undefined) continue;
    if (file.problem !== undefined) {
      settings.keyFileProblem = file.problem;
    } else {
      settings.apiKey ??= file.apiKey;
      settings.endpoint ??= file.endpoint;
    }
    break;
  }
  return settings;
}
