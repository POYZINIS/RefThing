import { registerHooks } from 'node:module';

// Node's native TypeScript runner resolves the extensionless imports used by Vite.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* Try normal resolution. */
      }
    }
    return nextResolve(specifier, context);
  },
});
