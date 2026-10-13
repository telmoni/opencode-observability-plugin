import { describe, expect, it } from 'vitest';

import { fieldsOf, idOf, stringOf, timeOf, v1MessageOf } from '../src/opencode';

describe('what OpenCode hands over', () => {
  it('is an object only where it is a plain one', () => {
    expect(fieldsOf({ a: 1 })).toEqual({ a: 1 });
    for (const other of [null, undefined, [], 'x', 3]) expect(fieldsOf(other)).toBeUndefined();
  });

  it('is a time only where it is milliseconds after the epoch', () => {
    expect(timeOf(1_791_795_600_000)).toBe(1_791_795_600_000);
    // Ingest reads a time of zero as none, and would refuse the span.
    for (const other of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1791795600000', undefined]) expect(timeOf(other)).toBeUndefined();
  });

  it('is an id only where it is a plain one, never a path', () => {
    expect(idOf('ses_ecd7186e0ffeAMirtb5MmWpDTy')).toBe('ses_ecd7186e0ffeAMirtb5MmWpDTy');
    for (const other of ['../..', '/work/…', 'a b', '', 'x'.repeat(129), 7]) expect(idOf(other)).toBeUndefined();
    expect(stringOf('')).toBeUndefined();
  });

  it('is a message of OpenCode 1’s only where its info has an id, its parts the plain objects among them', () => {
    expect(v1MessageOf({ info: { id: 'msg_1' }, parts: [{ type: 'text' }, null, 'x'] })).toEqual({ info: { id: 'msg_1' }, parts: [{ type: 'text' }] });
    expect(v1MessageOf({ info: { id: 'msg_1' } })?.parts).toEqual([]);
    for (const other of [{ info: {} }, { info: { id: '../x' } }, { parts: [] }, null]) expect(v1MessageOf(other)).toBeUndefined();
  });
});
