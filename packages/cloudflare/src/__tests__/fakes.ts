/**
 * Test-only helpers for standing in for Workers runtime bindings.
 */

/**
 * Type a partial Workers-runtime fake as the binding it stands in for. A fake
 * implements only the members the code under test calls; the binding types
 * `@cloudflare/workers-types` declares carry many more, so no fake satisfies
 * them structurally.
 */
export const fakeBinding = <T>(fake: unknown): T => fake as T;
