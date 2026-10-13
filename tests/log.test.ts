import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { kindOf, log } from '../src/log';
import { tempDir } from './helpers';

let root: { path: string; remove: () => void };

beforeEach(() => {
  root = tempDir();
});

afterEach(() => {
  root.remove();
});

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('the plugin’s log', () => {
  it.skipIf(process.platform === 'win32')('is a file only its owner can read, in folders only its owner can open', () => {
    const dir = join(root.path, 'state', 'telmoni', 'opencode');
    log(dir, 'opencode 1: no key');
    for (const folder of [join(root.path, 'state'), join(root.path, 'state', 'telmoni'), dir]) expect(modeOf(folder)).toBe(0o700);
    expect(modeOf(join(dir, 'plugin.log'))).toBe(0o600);
    expect(readFileSync(join(dir, 'plugin.log'), 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z opencode 1: no key\n$/);
  });

  it.skipIf(process.platform === 'win32')('is moved aside past a megabyte, and begun again as shut as before', () => {
    const dir = join(root.path, 'telmoni');
    log(dir, 'first');
    writeFileSync(join(dir, 'plugin.log'), 'x'.repeat(1024 * 1024 + 1), { flag: 'a' });
    log(dir, 'second');
    expect(readFileSync(join(dir, 'plugin.log.1'), 'utf8').startsWith('20')).toBe(true);
    expect(readFileSync(join(dir, 'plugin.log'), 'utf8')).toMatch(/ second\n$/);
    expect(modeOf(join(dir, 'plugin.log'))).toBe(0o600);
    expect(modeOf(join(dir, 'plugin.log.1'))).toBe(0o600);
  });

  it('is never written where there is no folder for it, and never throws where it cannot be', () => {
    expect(() => log(undefined, 'line')).not.toThrow();
    const file = join(root.path, 'a-file');
    writeFileSync(file, '');
    expect(() => log(join(file, 'telmoni'), 'line')).not.toThrow();
    expect(existsSync(join(file, 'telmoni'))).toBe(false);
  });

  it('names an error by its class and code, never its message', () => {
    const error = Object.assign(new Error('/home/someone/.config/opencode/telmoni.json: telmoni_secret'), { code: 'EACCES' });
    expect(kindOf(error)).toBe('Error:EACCES');
    expect(kindOf(new TypeError('…'))).toBe('TypeError');
    expect(kindOf('telmoni_secret')).toBe('string');
  });
});
