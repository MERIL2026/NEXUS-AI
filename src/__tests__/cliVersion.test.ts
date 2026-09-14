import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getCliVersion, formatCliVersion } from '../cli/version.js';

describe('CLI Version Dynamic Resolution', () => {
  it('getCliVersion returns exact version from root package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    const version = getCliVersion();
    expect(version).toBe(pkg.version);
  });

  it('formatCliVersion returns formatted string matching package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    const formatted = formatCliVersion();
    expect(formatted).toBe(`NEXUS AI v${pkg.version}`);
  });

  it('validates semantic version format (x.y.z)', () => {
    const version = getCliVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });
});
