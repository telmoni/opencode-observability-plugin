import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KEY_FILE, configDirs, settingsFrom } from '../src/settings';
import { tempDir } from './helpers';

let home: { path: string; remove: () => void };

beforeEach(() => {
  home = tempDir();
});

afterEach(() => {
  home.remove();
});

/** A key file in `dir`, with `mode` whatever the umask would have made of it. */
function keyFile(dir: string, content: unknown, mode = 0o600): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, KEY_FILE);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  chmodSync(path, mode);
}

const opencodeConfig = (): string => join(home.path, '.config', 'opencode');

describe('the key and the endpoint', () => {
  it('come from the SDKs’ own variables first, and then the key file is not read at all', () => {
    keyFile(opencodeConfig(), 'not json');
    const settings = settingsFrom({ TELMONI_API_KEY: ' telmoni_env ', TELMONI_ENDPOINT: 'https://ingest.example' }, home.path);
    expect(settings).toMatchObject({ apiKey: 'telmoni_env', endpoint: 'https://ingest.example', keyFileProblem: undefined });
  });

  it('come from telmoni.json in OpenCode’s configuration folder where a variable is unset, each on its own', () => {
    keyFile(opencodeConfig(), { apiKey: ' telmoni_file ', endpoint: 'https://file.example' });
    expect(settingsFrom({}, home.path)).toMatchObject({ apiKey: 'telmoni_file', endpoint: 'https://file.example', keyFileProblem: undefined });
    expect(settingsFrom({ TELMONI_ENDPOINT: 'https://env.example', TELMONI_API_KEY: '  ' }, home.path)).toMatchObject({
      apiKey: 'telmoni_file',
      endpoint: 'https://env.example',
    });
  });

  it('are nothing where neither is set', () => {
    expect(settingsFrom({}, home.path)).toMatchObject({ apiKey: undefined, endpoint: undefined, keyFileProblem: undefined });
  });

  it('are looked for in the home of the environment the plugin was handed', () => {
    keyFile(opencodeConfig(), { apiKey: 'telmoni_file' });
    expect(settingsFrom({ HOME: home.path })).toMatchObject({
      apiKey: 'telmoni_file',
      dir: join(home.path, '.local', 'state', 'telmoni', 'opencode'),
    });
  });
});

describe('the key file', () => {
  it.skipIf(process.platform === 'win32')('is read only where it is shut to everyone but its owner, as ssh reads a key', () => {
    for (const mode of [0o644, 0o640, 0o604, 0o620]) {
      keyFile(opencodeConfig(), { apiKey: 'telmoni_file', endpoint: 'https://elsewhere.example' }, mode);
      expect(settingsFrom({}, home.path)).toMatchObject({
        apiKey: undefined,
        endpoint: undefined,
        keyFileProblem: 'open to other users; chmod 600 it',
      });
    }
    keyFile(opencodeConfig(), { apiKey: 'telmoni_file' }, 0o400);
    expect(settingsFrom({}, home.path).apiKey).toBe('telmoni_file');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('is passed over where another user owns it, which no chmod of the person’s mends', () => {
    mkdirSync(opencodeConfig(), { recursive: true });
    // Root's, and open to everyone: the owner is what is named.
    symlinkSync('/etc/passwd', join(opencodeConfig(), KEY_FILE));
    expect(settingsFrom({}, home.path)).toMatchObject({ apiKey: undefined, keyFileProblem: 'owned by another user' });
  });

  it.skipIf(process.platform === 'win32')('is never waited on where it is a FIFO nothing writes to', () => {
    mkdirSync(opencodeConfig(), { recursive: true });
    execFileSync('mkfifo', [join(opencodeConfig(), KEY_FILE)]);
    expect(settingsFrom({}, home.path).keyFileProblem).toBe('not a file');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says it cannot read one it may not open, by kind', () => {
    keyFile(opencodeConfig(), { apiKey: 'telmoni_file' }, 0o000);
    expect(settingsFrom({}, home.path)).toMatchObject({ apiKey: undefined, keyFileProblem: 'unreadable (Error:EACCES)' });
  });

  it('is passed over where a field is there but empty or no string, rather than send the key to the default endpoint', () => {
    for (const endpoint of ['', '   ', null, 443, ['https://self.example']]) {
      keyFile(opencodeConfig(), { apiKey: 'telmoni_file', endpoint });
      expect(settingsFrom({}, home.path)).toMatchObject({ apiKey: undefined, endpoint: undefined, keyFileProblem: 'endpoint empty or not a string' });
    }
    keyFile(opencodeConfig(), { apiKey: '', endpoint: 'https://self.example' });
    expect(settingsFrom({ TELMONI_API_KEY: 'telmoni_env' }, home.path)).toMatchObject({ endpoint: undefined, keyFileProblem: 'apiKey empty or not a string' });
  });

  it('says what is wrong with one that is not a key file, by kind', () => {
    keyFile(opencodeConfig(), '{"apiKey": ');
    expect(settingsFrom({}, home.path).keyFileProblem).toBe('not JSON');
    keyFile(opencodeConfig(), '["telmoni_file"]');
    expect(settingsFrom({}, home.path).keyFileProblem).toBe('not a JSON object');
    keyFile(opencodeConfig(), 'x'.repeat(70_000));
    expect(settingsFrom({}, home.path).keyFileProblem).toBe('too large');
    const elsewhere = join(home.path, 'elsewhere');
    mkdirSync(join(elsewhere, KEY_FILE), { recursive: true });
    expect(settingsFrom({ OPENCODE_CONFIG_DIR: elsewhere }, home.path).keyFileProblem).toBe('not a file');
  });

  it('is looked for in OPENCODE_CONFIG_DIR first, then in XDG_CONFIG_HOME’s opencode folder, never in a relative one', () => {
    expect(configDirs({ OPENCODE_CONFIG_DIR: '/custom', XDG_CONFIG_HOME: '/xdg' }, '/home/someone')).toEqual(['/custom', '/xdg/opencode']);
    expect(configDirs({ OPENCODE_CONFIG_DIR: 'custom', XDG_CONFIG_HOME: 'xdg' }, '/home/someone')).toEqual(['/home/someone/.config/opencode']);
    expect(configDirs({}, '')).toEqual([]);
  });

  it('is the first one found, even where it is refused and a later one would do', () => {
    const custom = join(home.path, 'custom');
    keyFile(custom, '{');
    keyFile(opencodeConfig(), { apiKey: 'telmoni_file' });
    expect(settingsFrom({ OPENCODE_CONFIG_DIR: custom }, home.path)).toMatchObject({ apiKey: undefined, keyFileProblem: 'not JSON' });
    keyFile(custom, { apiKey: 'telmoni_custom' });
    expect(settingsFrom({ OPENCODE_CONFIG_DIR: custom }, home.path).apiKey).toBe('telmoni_custom');
  });
});

describe('the plugin’s folder', () => {
  it('is in the person’s state folder, never beside OpenCode’s configuration', () => {
    expect(settingsFrom({}, home.path).dir).toBe(join(home.path, '.local', 'state', 'telmoni', 'opencode'));
    expect(settingsFrom({ XDG_STATE_HOME: '/state' }, home.path).dir).toBe('/state/telmoni/opencode');
    expect(settingsFrom({ XDG_STATE_HOME: 'state' }, home.path).dir).toBe(join(home.path, '.local', 'state', 'telmoni', 'opencode'));
    expect(settingsFrom({ XDG_CONFIG_HOME: join(home.path, 'config') }, home.path).dir).not.toContain('config');
  });

  it('is nothing where there is no home to put it in', () => {
    expect(settingsFrom({}, '').dir).toBeUndefined();
  });
});
