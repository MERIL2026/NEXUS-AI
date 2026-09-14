/**
 * NEXUS AI — CLI Dynamic Version Resolution
 *
 * Resolves the active NEXUS AI CLI package version dynamically from package.json
 * across development, local build, and installed npm package environments.
 * Prevents version drift when bumping package.json versions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Traverses parent directories starting from `startDir` to locate a valid package.json.
 */
function findPackageJson(startDir: string): { version?: string; name?: string } | null {
  let currentDir = startDir;
  for (let i = 0; i < 6; i++) {
    const pkgPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.version === 'string') {
          return parsed;
        }
      } catch {
        // Ignore read/parse errors and continue traversal
      }
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return null;
}

/**
 * Returns the current NEXUS CLI semantic version string (e.g. "0.1.4").
 */
export function getCliVersion(): string {
  try {
    // 1. Resolve relative to this module (handles src/cli/ or dist/cli/ or node_modules/...)
    if (typeof import.meta.url === 'string') {
      const moduleDir = path.dirname(fileURLToPath(import.meta.url));
      const pkg = findPackageJson(moduleDir);
      if (pkg?.version) {
        return pkg.version;
      }
    }
  } catch {
    // Continue to fallback
  }

  try {
    // 2. Fallback: Search from process.cwd()
    const cwdPkg = findPackageJson(process.cwd());
    if (cwdPkg?.version) {
      return cwdPkg.version;
    }
  } catch {
    // Continue to fallback
  }

  // 3. Last-resort fallback from environment or fallback placeholder
  return process.env['npm_package_version'] || '0.0.0';
}

/**
 * Returns the formatted CLI version string (e.g. "NEXUS AI v0.1.4").
 */
export function formatCliVersion(): string {
  return `NEXUS AI v${getCliVersion()}`;
}
