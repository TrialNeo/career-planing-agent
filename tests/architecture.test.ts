import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
const root = resolve('apps/server/src');
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((f) =>
    f.isDirectory()
      ? files(resolve(path, f.name))
      : f.name.endsWith('.ts')
        ? [resolve(path, f.name)]
        : [],
  );
}
it('keeps platform business-free, modules isolated and all internal imports acyclic', () => {
  const graph = new Map<string, string[]>();
  const violations: string[] = [];
  for (const file of files(root)) {
    const from = relative(root, file).split(sep);
    const deps: string[] = [];
    for (const match of readFileSync(file, 'utf8').matchAll(
      /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g,
    )) {
      if (!match[1].startsWith('.')) continue;
      const target = resolve(dirname(file), match[1]).replace(/\.js$/, '.ts');
      deps.push(target);
      const to = relative(root, target).split(sep);
      if (from[0] === 'platform' && ['module', 'workflow', 'http'].includes(to[0]))
        violations.push(`${file} -> ${target}`);
      if (
        from[0] === 'module' &&
        (['workflow', 'http'].includes(to[0]) || (to[0] === 'module' && to[1] !== from[1]))
      )
        violations.push(`${file} -> ${target}`);
      if (from[0] === 'workflow' && to[0] === 'http')
        violations.push(`workflow depends on HTTP transport: ${file} -> ${target}`);
      if (
        ['workflow', 'http'].includes(from[0]) &&
        to[0] === 'module' &&
        to.slice(2).join('/') !== 'index.ts'
      )
        violations.push(`bypasses module entry: ${file} -> ${target}`);
    }
    graph.set(file, deps);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  function walk(file: string) {
    if (active.has(file)) {
      violations.push(`cycle: ${file}`);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    for (const dep of graph.get(file) ?? []) walk(dep);
    active.delete(file);
  }
  graph.forEach((_, file) => walk(file));
  expect(violations).toEqual([]);
});
