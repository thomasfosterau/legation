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
 */
import * as React from "react";
import { useMutation } from "@legation/react";
import { useUsers } from "./data";
import { useWorld } from "./world";
import type { User } from "./domain";

const STORAGE_KEY = "react-realworld/currentUser";

export interface AuthApi {
  readonly currentUsername: string | null;
  readonly currentUser: User | null;
  readonly login: (username: string, password: string) => string | null;
  readonly register: (username: string, email: string, password: string) => Promise<string | null>;
  readonly updateSettings: (next: User) => Promise<void>;
  readonly logout: () => void;
}

const AuthContext = React.createContext<AuthApi | null>(null);

export const AuthProvider = (props: { readonly children: React.ReactNode }): React.ReactElement => {
  const world = useWorld();
  const mutate = useMutation();
  const users = useUsers();
  const [currentUsername, setCurrentUsername] = React.useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY)
  );

  // Keep the server identity and local persistence in lock-step with the session.
  React.useEffect(() => {
    world.setIdentity(currentUsername);
    if (currentUsername === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, currentUsername);
  }, [world, currentUsername]);

  const currentUser = React.useMemo(
    () => users.find((u) => u.username === currentUsername) ?? null,
    [users, currentUsername]
  );

  const api = React.useMemo<AuthApi>(
    () => ({
      currentUsername,
      currentUser,
      login: (username, password) => {
        const user = users.find((u) => u.username === username);
        if (user === undefined) return "Unknown username";
        if (user.password !== password) return "Wrong password";
        setCurrentUsername(username);
        return null;
      },
      register: async (username, email, password) => {
        if (users.some((u) => u.username === username)) return "Username is taken";
        // Set identity first so the authoritative register write is attributed.
        world.setIdentity(username);
        try {
          await mutate("user/register", { username, email, password });
        } catch {
          world.setIdentity(currentUsername);
          return "Could not register";
        }
        setCurrentUsername(username);
        return null;
      },
      updateSettings: (next) => mutate("user/update", next),
      logout: () => setCurrentUsername(null),
    }),
    [users, currentUser, currentUsername, mutate, world]
  );

  return React.createElement(AuthContext.Provider, { value: api }, props.children);
};

export const useAuth = (): AuthApi => {
  const api = React.useContext(AuthContext);
  if (api === null) throw new Error("useAuth must be used within <AuthProvider>");
  return api;
};
