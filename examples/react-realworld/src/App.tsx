/**
 * App shell — header nav, route switch, footer, and a sync status banner.
 *
 * The header reflects the live session (`useAuth`); the banner reflects the
 * live transport status (`useConnection`) and lets you toggle offline to watch
 * writes queue in the durable journal and flush on reconnect.
 */
import * as React from "react";
import { useAuth } from "./auth";
import { useConnection, useWorld } from "./world";
import { Link, useRoute } from "./router";
import { Home } from "./pages/Home";
import { Login, Register } from "./pages/Auth";
import { Settings } from "./pages/Settings";
import { Editor } from "./pages/Editor";
import { ArticlePage } from "./pages/Article";
import { Profile } from "./pages/Profile";

const Header = (): React.ReactElement => {
  const { currentUser, currentUsername } = useAuth();
  const route = useRoute();
  const active = (name: string) => (route.name === name ? "active" : "");
  return (
    <nav className="navbar navbar-light">
      <div className="container">
        <Link to={{ name: "home" }} className="navbar-brand">
          conduit
        </Link>
        <ul className="nav navbar-nav pull-xs-right">
          <li className="nav-item">
            <Link to={{ name: "home" }} className={`nav-link ${active("home")}`}>
              Home
            </Link>
          </li>
          {currentUsername ? (
            <>
              <li className="nav-item">
                <Link to={{ name: "editor" }} className={`nav-link ${active("editor")}`}>
                  <i className="ion-compose" />
                  &nbsp;New Article
                </Link>
              </li>
              <li className="nav-item">
                <Link to={{ name: "settings" }} className={`nav-link ${active("settings")}`}>
                  <i className="ion-gear-a" />
                  &nbsp;Settings
                </Link>
              </li>
              <li className="nav-item">
                <Link
                  to={{ name: "profile", username: currentUsername, favorites: false }}
                  className={`nav-link ${active("profile")}`}
                >
                  {currentUser?.image && (
                    <img src={currentUser.image} className="user-pic" alt={currentUsername} />
                  )}
                  {currentUsername}
                </Link>
              </li>
            </>
          ) : (
            <>
              <li className="nav-item">
                <Link to={{ name: "login" }} className={`nav-link ${active("login")}`}>
                  Sign in
                </Link>
              </li>
              <li className="nav-item">
                <Link to={{ name: "register" }} className={`nav-link ${active("register")}`}>
                  Sign up
                </Link>
              </li>
            </>
          )}
        </ul>
      </div>
    </nav>
  );
};

const SyncBanner = (): React.ReactElement => {
  const world = useWorld();
  const connection = useConnection();
  const offline = connection === "disconnected";
  return (
    <div
      style={{
        background: offline ? "#b85c00" : "#3c4048",
        color: "#fff",
        fontSize: 13,
        padding: "5px 0",
      }}
    >
      <div className="container" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>
          legation · in-page SyncServer + MemoryBackend ·{" "}
          {offline ? "offline — writes queue in the journal" : "online — optimistic + rebase"}
        </span>
        <button
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.5)",
            color: "#fff",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
            padding: "1px 8px",
          }}
          onClick={() => void world.setOnline(offline)}
        >
          {offline ? "Go online" : "Go offline"}
        </button>
      </div>
    </div>
  );
};

const CurrentPage = (): React.ReactElement => {
  const route = useRoute();
  switch (route.name) {
    case "home":
      return <Home />;
    case "login":
      return <Login />;
    case "register":
      return <Register />;
    case "settings":
      return <Settings />;
    case "editor":
      return <Editor slug={route.slug} />;
    case "article":
      return <ArticlePage slug={route.slug} />;
    case "profile":
      return <Profile username={route.username} favorites={route.favorites} />;
  }
};

const Footer = (): React.ReactElement => (
  <footer>
    <div className="container">
      <Link to={{ name: "home" }} className="logo-font">
        conduit
      </Link>
      <span className="attribution">
        RealWorld example driving the{" "}
        <a href="https://github.com/thomasfosterau/legation">legation</a> engine.
      </span>
    </div>
  </footer>
);

export const App = (): React.ReactElement => (
  <>
    <SyncBanner />
    <Header />
    <CurrentPage />
    <Footer />
  </>
);
