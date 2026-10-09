import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('README', () => {
  it('shows the version of package.json in its version badge', () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const badge = /!\[Version ([^\]]+)\]\(https:\/\/img\.shields\.io\/badge\/version-([^-]+)-/.exec(readFileSync('README.md', 'utf8'));
    expect(badge?.slice(1)).toEqual([version, version]);
  });
});
