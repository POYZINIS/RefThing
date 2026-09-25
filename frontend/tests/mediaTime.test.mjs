import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPrecise, formatTime } from '../src/components/mediaTime.ts';

test('time formats', () => {
  assert.equal(formatTime(83.4), '1:23');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatPrecise(83.4567), '1:23.457');
  assert.equal(formatPrecise(0), '0:00.000');
  assert.equal(formatPrecise(Number.NaN), '0:00.000');
});
