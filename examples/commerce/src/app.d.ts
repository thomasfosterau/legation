declare global {
  namespace App {
    interface Locals {
      /** The Better Auth session user, when signed in. */
      user: { id: string; name: string; email: string } | undefined;
    }
  }
}

export {};
