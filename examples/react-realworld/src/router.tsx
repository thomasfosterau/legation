/**
 * Router
 *
 * A tiny hash router — no dependency, just `location.hash`. Conduit's routes map
 * to a small tagged union; `useRoute` re-renders on `hashchange`, `navigate`
 * sets the hash, and `Link` is an anchor that does the same.
 */
import * as React from "react";

export type Route =
  | { readonly name: "home" }
  | { readonly name: "login" }
  | { readonly name: "register" }
  | { readonly name: "settings" }
  | { readonly name: "editor"; readonly slug?: string }
  | { readonly name: "article"; readonly slug: string }
  | { readonly name: "profile"; readonly username: string; readonly favorites: boolean };

export const parseHash = (hash: string): Route => {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return { name: "home" };
  switch (parts[0]) {
    case "login":
      return { name: "login" };
    case "register":
      return { name: "register" };
    case "settings":
      return { name: "settings" };
    case "editor":
      return { name: "editor", slug: parts[1] ? decodeURIComponent(parts[1]) : undefined };
    case "article":
      return parts[1]
        ? { name: "article", slug: decodeURIComponent(parts[1]) }
        : { name: "home" };
    case "profile":
      return parts[1]
        ? {
            name: "profile",
            username: decodeURIComponent(parts[1]),
            favorites: parts[2] === "favorites",
          }
        : { name: "home" };
    default:
      return { name: "home" };
  }
};

export const hrefFor = (route: Route): string => {
  switch (route.name) {
    case "home":
      return "#/";
    case "login":
      return "#/login";
    case "register":
      return "#/register";
    case "settings":
      return "#/settings";
    case "editor":
      return route.slug ? `#/editor/${encodeURIComponent(route.slug)}` : "#/editor";
    case "article":
      return `#/article/${encodeURIComponent(route.slug)}`;
    case "profile":
      return `#/profile/${encodeURIComponent(route.username)}${route.favorites ? "/favorites" : ""}`;
  }
};

export const navigate = (route: Route): void => {
  window.location.hash = hrefFor(route);
};

export const useRoute = (): Route => {
  const [route, setRoute] = React.useState<Route>(() => parseHash(window.location.hash));
  React.useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
};

export const Link = (props: {
  readonly to: Route;
  readonly className?: string;
  readonly children: React.ReactNode;
  readonly onClick?: () => void;
}): React.ReactElement => (
  <a
    href={hrefFor(props.to)}
    className={props.className}
    onClick={() => props.onClick?.()}
  >
    {props.children}
  </a>
);
