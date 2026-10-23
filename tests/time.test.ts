import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, formatDateTime, HOUR, parseDateTime } from '../src/time.js';

test('Russian date/time is converted from Moscow to UTC and round-trips', () => {
  const value = parseDateTime('23.10.2026 12:30');
  assert.equal(value, Date.UTC(2026, 9, 23, 9, 30));
  assert.equal(formatDateTime(value), '23.10.2026 12:30');
  assert.equal(DAY, 24 * HOUR);
  assert.equal(formatDateTime(null), 'не указано');
});

test('strict parser rejects normalized calendar overflow and malformed input', () => {
  for (const input of ['31.02.2026 12:30', '29.02.2025 12:30', '31.04.2026 12:30',
    '00.10.2026 12:30', '01.13.2026 12:30', '23.10.2026 24:00', '23.10.2026 12:60',
    '3.10.2026 12:30', '23.10.2026', '2026-10-23 12:30', '01.01.0000 00:00']) {
    assert.equal(parseDateTime(input), null, input);
  }
  assert.notEqual(parseDateTime('29.02.2028 00:00'), null);
  assert.equal(parseDateTime('23.10.2026 12:30', 'not-a-timezone'), null);
});

test('timezone conversion rejects the nonexistent local time in a DST gap', () => {
  assert.equal(parseDateTime('29.03.2026 02:30', 'Europe/Berlin'), null);
  const valid = parseDateTime('29.03.2026 03:30', 'Europe/Berlin');
  assert.equal(valid, Date.UTC(2026, 2, 29, 1, 30));
  assert.equal(formatDateTime(valid, 'Europe/Berlin'), '29.03.2026 03:30');
});
