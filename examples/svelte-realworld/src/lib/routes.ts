/**
 * Route paths
 *
 * SvelteKit's file-based router owns *matching* (`src/routes/**`); this module
 * owns *building* — one place that knows a slug or username has to be
 * percent-encoded before it goes in a path. Links use these strings directly
 * (`<a href={paths.article(slug)}>`); imperative redirects pass them to `goto`.
 */
export const paths = {
  home: "/",
  login: "/login",
  register: "/register",
  settings: "/settings",
  newArticle: "/editor",
  editArticle: (slug: string): string => `/editor/${encodeURIComponent(slug)}`,
  article: (slug: string): string => `/article/${encodeURIComponent(slug)}`,
  profile: (username: string): string => `/profile/${encodeURIComponent(username)}`,
  profileFavorites: (username: string): string =>
    `/profile/${encodeURIComponent(username)}/favorites`,
} as const;
