import { registerHooks } from 'node:module';

const srcRoot = new URL('../src/', import.meta.url);

// Node's native TypeScript runner resolves the extensionless imports used by
// Vite, and Vite's `@/` alias (= src/).
registerHooks({
  resolve(specifier, context, nextResolve) {
    const aliased = specifier.startsWith('@/')
      ? new URL(specifier.slice(2), srcRoot).href
      : specifier;
    const relative = aliased !== specifier || specifier.startsWith('.');
    if (relative && !/\.[cm]?[jt]sx?$/.test(aliased)) {
      try {
        return nextResolve(`${aliased}.ts`, context);
      } catch {
        /* Try normal resolution. */
      }
    }
    return nextResolve(aliased, context);
  },
});
