/**
 * Session
 *
 * Conduit's session, modelled on the sync engine. "Logging in" is two things:
 * remembering a username locally (persisted), and telling the *server* who this
 * client is via `world.setIdentity` — so the backend's ownership checks (which
 * read `context.identity`) accept this user's writes. Registration and settings
 * are ordinary optimistic mutations; the user row appears in the replica at
 * once.
 *
 * Read auth is public, so login here just verifies a username/password against
 * the synced `users` collection — enough to demo identity-scoped writes without
 * a real token exchange.
 *
 * `.svelte.ts` because the session owns `$state`: `username` is a rune, and
 * `user` is `$derived` from it and the live users read. The root layout owns
 * the one instance and shares it by context.
 */
import { getContext, setContext } from "svelte";
import type { User } from "./domain";
import type { World } from "./sync";

const STORAGE_KEY = "realworld/currentUser";

export interface Session {
  /** The signed-in username, or null. */
  readonly username: string | null;
  /** The signed-in user's row, once it has synced. */
  readonly user: User | null;
  readonly login: (username: string, password: string) => string | null;
  readonly register: (username: string, email: string, password: string) => Promise<string | null>;
  readonly updateSettings: (next: Omit<User, "id">) => Promise<void>;
  readonly logout: () => void;
}

/**
 * Build the session. `users` is a thunk over the live users read; `mutate`
 * writes through the Client; `world` is the demo side-channel for identity.
 */
export const createSession = (
  users: () => ReadonlyArray<User>,
  mutate: (mutation: string, args: unknown) => Promise<void>,
  world: World
): Session => {
  let username = $state<string | null>(localStorage.getItem(STORAGE_KEY));

  // The server identity and local persistence follow the session. `$effect`
  // runs after the value settles, so login/logout needs no manual plumbing.
  $effect(() => {
    world.setIdentity(username);
    if (username === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, username);
  });

  return {
    get username() {
      return username;
    },
    get user() {
      const current = username;
      return current === null ? null : (users().find((u) => u.username === current) ?? null);
    },
    login: (name, password) => {
      const user = users().find((candidate) => candidate.username === name);
      if (user === undefined) return "Unknown username";
      if (user.password !== password) return "Wrong password";
      username = name;
      return null;
    },
    register: async (name, email, password) => {
      if (users().some((u) => u.username === name)) return "Username is taken";
      // Set identity first so the authoritative register write is attributed.
      world.setIdentity(name);
      try {
        await mutate("user/register", { username: name, email, password });
      } catch {
        world.setIdentity(username);
        return "Could not register";
      }
      username = name;
      return null;
    },
    updateSettings: (next) => mutate("user/update", next),
    logout: () => {
      username = null;
    },
  };
};

const SESSION_KEY = Symbol("realworld/session");

export const setSession = (session: Session): void => {
  setContext(SESSION_KEY, session);
};

export const getSession = (): Session => {
  const session = getContext<Session | undefined>(SESSION_KEY);
  if (session === undefined)
    throw new Error("setSession(session) must be called higher in the tree");
  return session;
};
