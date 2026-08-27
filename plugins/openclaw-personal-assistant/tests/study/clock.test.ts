import { describe, expect, it } from 'vitest';

import { isStudyWindow, studyDayKey } from '../../src/study/clock.js';
import { DEFAULT_STUDY_SETTINGS } from '../../src/study/types.js';

describe('Seoul study clock', () => {
  it.each([
    ['2026-08-27T08:00:00+09:00', '2026-08-27'],
    ['2026-08-28T01:59:59+09:00', '2026-08-27'],
    ['2026-08-28T02:00:00+09:00', '2026-08-28'],
  ])('maps %s to study day %s', (instant, expected) => {
    expect(studyDayKey(new Date(instant))).toBe(expected);
  });

  it.each([
    ['2026-08-27T07:59:59+09:00', false],
    ['2026-08-27T08:00:00+09:00', true],
    ['2026-08-27T22:00:00+09:00', true],
    ['2026-08-28T01:59:59+09:00', true],
    ['2026-08-28T02:00:00+09:00', false],
  ])('classifies %s study availability as %s', (instant, expected) => {
    expect(isStudyWindow(new Date(instant), DEFAULT_STUDY_SETTINGS)).toBe(expected);
  });
});
