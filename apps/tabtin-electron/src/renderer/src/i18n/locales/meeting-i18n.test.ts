import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const localesDir = dirname(fileURLToPath(import.meta.url));
const meetingComponentsDir = join(
  localesDir,
  '..',
  '..',
  'components',
  'meeting',
);
const locales = [
  'zh-CN',
  'zh-TW',
  'en-US',
  'ja-JP',
  'ko-KR',
  'de-DE',
  'fr-FR',
  'es-ES',
] as const;

function flatten(
  value: Record<string, unknown>,
  prefix = '',
  output: Record<string, string> = {},
): Record<string, string> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child as Record<string, unknown>, path, output);
    } else if (typeof child === 'string') {
      output[path] = child;
    }
  }
  return output;
}

function readMeetingLocale(locale: (typeof locales)[number]): Record<string, string> {
  return flatten(
    JSON.parse(
      readFileSync(join(localesDir, locale, 'meeting.json'), 'utf8'),
    ) as Record<string, unknown>,
  );
}

describe('meeting locale contract', () => {
  it('八种语言拥有相同且非空的会议文案键', () => {
    const expectedKeys = Object.keys(readMeetingLocale('en-US')).sort();
    expect(expectedKeys.length).toBeGreaterThan(100);

    for (const locale of locales) {
      const values = readMeetingLocale(locale);
      expect(Object.keys(values).sort()).toEqual(expectedKeys);
      expect(Object.values(values).every((value) => value.trim().length > 0)).toBe(true);
    }
  });

  it('会议组件不重新硬编码中文正文', () => {
    const sourceFiles = readdirSync(meetingComponentsDir)
      .filter((name) => /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.tsx'));

    for (const name of sourceFiles) {
      const source = readFileSync(join(meetingComponentsDir, name), 'utf8');
      expect(source, name).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });
});
