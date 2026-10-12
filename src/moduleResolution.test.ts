import { expect, it } from 'vitest';

it('relative extensionless imports resolve to one module on case-insensitive filesystems', () => {
  const sources = import.meta.glob<string>(['./*.ts', './*.tsx', '../e2e/*.ts'],
    { query: '?raw', import: 'default', eager: true });
  const filenames = Object.keys(sources);
  const errors: string[] = [];
  for (const [filename, source] of Object.entries(sources).filter(([name]) => name.startsWith('./'))) {
    const imports = source.matchAll(/\b(?:import|export)\s+(?:[^;'"`]*\s+from\s*)?['"](\.[^'"]+)['"]/g);
    for (const [, specifier] of imports) {
      if (/\.[^/]+$/.test(specifier)) continue;
      const target = new URL(specifier, new URL(filename, import.meta.url)).pathname.toLowerCase();
      const modules = filenames.filter(name =>
        new URL(name.replace(/\.tsx?$/, ''), import.meta.url).pathname.toLowerCase() === target);
      if (modules.length !== 1) errors.push(`${filename}: ${specifier} resolves to ${modules.join(', ')}`);
    }
  }
  expect(errors).toEqual([]);
});
