import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Settings } from '../apps/server/src/module/settings/index.js';

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  vi.unstubAllEnvs();
});
it('does not load a second model configuration from environment variables', () => {
  vi.stubEnv('CAREER_MODEL_API_KEY', 'environment-secret');
  vi.stubEnv('CAREER_MODEL', 'environment-model');
  const settings = new Settings();
  expect(settings.configured()).toBe(false);
  expect(settings.credentials().apiKey).toBeUndefined();
});
it('validates server configuration without disclosing values in errors', () => {
  directory = mkdtempSync(join(tmpdir(), 'career-config-'));
  const path = join(directory, 'model.json');
  for (const contents of [
    '{"apiKey":"do-not-disclose-secret",broken}',
    JSON.stringify({
      baseUrl: 'https://user:do-not-disclose-secret@example.com',
      model: 'test',
      apiKey: 'do-not-disclose-secret',
    }),
  ]) {
    writeFileSync(path, contents);
    let failure: Error | undefined;
    try {
      new Settings(path);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).not.toContain('do-not-disclose-secret');
    expect(failure?.message).toContain('model.json');
  }
});
