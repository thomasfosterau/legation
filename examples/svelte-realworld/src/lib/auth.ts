/**
 * Auth
 *
 * Conduit's session, modelled on the sync engine. "Logging in" is two things:
 * remembering a username locally (persisted), and telling the *server* who this
 * client is via `world.setIdentity` — so the backend's ownership checks (which
 * read `context.identity`) accept this user's writes. Registration and settings
 * are ordinary optimistic mutators; the user row appears in the mirror at once.
 *
 * Read auth is public, so login here just verifies a username/password against
 * the synced `users` collection — enough to demo identity-scoped writes without
 * a real token exchange.
 *
 * The session is built in the root (which holds the live users store, the
 * mutate helper, and the world) and shared via context. `currentUsername` is a
 * `writable`; the root subscribes to it to keep the server identity and
 * localStorage in lock-step, and derives `currentUser` from the users store.
 */
import { derived, get, writable, type Readable, type Writable } from "svelte/store";
import { getContext, setContext } from "svelte";
import type { User } from "./domain";
import type { World } from "./sync";

const STORAGE_KEY = "svelte-realworld/currentUser";

export interface Auth {
  readonly currentUsername: Readable<string | null>;
  readonly currentUser: Readable<User | null>;
  readonly login: (username: string, password: string) => string | null;
  readonly register: (username: string, email: string, password: string) => Promise<string | null>;
  readonly updateSettings: (next: User) => Promise<void>;
  readonly logout: () => void;
}

/**
 * Build the session. `users` is the live users store; `mutate` writes through
 * the engine; `world` is the demo side-channel for identity. Returns the Auth
 * API plus the raw `currentUsername` writable so the root can keep the server
 * identity + localStorage in lock-step.
 */
export const createAuth = (
  users: Readable<ReadonlyArray<User>>,
  mutate: (mutator: string, args: unknown) => Promise<void>,
  world: World
): { readonly auth: Auth; readonly currentUsername: Writable<string | null> } => {
  const currentUsername = writable<string | null>(localStorage.getItem(STORAGE_KEY));

  const currentUser = derived(
    [users, currentUsername],
    ([list, username]) => list.find((u) => u.username === username) ?? null
  );

  const auth: Auth = {
    currentUsername,
    currentUser,
    login: (username, password) => {
      const user = get(users).find((u) => u.username === username);
      if (user === undefined) return "Unknown username";
      if (user.password !== password) return "Wrong password";
      currentUsername.set(username);
      return null;
    },
    register: async (username, email, password) => {
      if (get(users).some((u) => u.username === username)) return "Username is taken";
      // Set identity first so the authoritative register write is attributed.
      world.setIdentity(username);
      try {
        await mutate("user/register", { username, email, password });
      } catch {
        world.setIdentity(get(currentUsername));
        return "Could not register";
      }
      currentUsername.set(username);
      return null;
    },
    updateSettings: (next) => mutate("user/update", next),
    logout: () => currentUsername.set(null),
  };

  return { auth, currentUsername };
};

/**
 * Keep the server identity and local persistence in lock-step with the session.
 * Returns an unsubscribe; call from the root (e.g. inside an `$effect`).
 */
export const bindIdentity = (
  currentUsername: Readable<string | null>,
  world: World
): (() => void) =>
  currentUsername.subscribe((username) => {
    world.setIdentity(username);
    if (username === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, username);
  });

const AUTH_KEY = Symbol("svelte-realworld/auth");

export const setAuth = (auth: Auth): void => {
  setContext(AUTH_KEY, auth);
};

export const getAuth = (): Auth => {
  const auth = getContext<Auth | undefined>(AUTH_KEY);
  if (auth === undefined) throw new Error("setAuth(auth) must be called higher in the tree");
  return auth;
};
