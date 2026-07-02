/**
 * Home — banner, feed tabs (Your Feed / Global / #tag), popular tags sidebar.
 */
import * as React from "react";
import { useAuth } from "../auth";
import { useArticles, useTags } from "../data";
import { ArticleList } from "../components";
import type { Feed } from "../types";

export const Home = (): React.ReactElement => {
  const { currentUsername } = useAuth();
  const tags = useTags();
  const [tab, setTab] = React.useState<"your" | "global" | "tag">(
    currentUsername ? "your" : "global"
  );
  const [tag, setTag] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(0);

  const feed: Feed =
    tab === "tag" && tag !== null
      ? { kind: "tag", tag }
      : tab === "your"
        ? { kind: "your" }
        : { kind: "global" };
  const articles = useArticles(feed, page, currentUsername);

  const select = (next: "your" | "global" | "tag", nextTag?: string) => {
    setTab(next);
    setTag(nextTag ?? null);
    setPage(0);
  };

  return (
    <div className="home-page">
      <div className="banner">
        <div className="container">
          <h1 className="logo-font">conduit</h1>
          <p>A place to share your knowledge. Synced with legation.</p>
        </div>
      </div>

      <div className="container page">
        <div className="row">
          <div className="col-md-9">
            <div className="feed-toggle">
              <ul className="nav nav-pills outline-active">
                {currentUsername && (
                  <li className="nav-item">
                    <button
                      className={`nav-link ${tab === "your" ? "active" : ""}`}
                      onClick={() => select("your")}
                    >
                      Your Feed
                    </button>
                  </li>
                )}
                <li className="nav-item">
                  <button
                    className={`nav-link ${tab === "global" ? "active" : ""}`}
                    onClick={() => select("global")}
                  >
                    Global Feed
                  </button>
                </li>
                {tab === "tag" && tag && (
                  <li className="nav-item">
                    <button className="nav-link active">
                      <i className="ion-pound" /> {tag}
                    </button>
                  </li>
                )}
              </ul>
            </div>

            <ArticleList page={articles} pageIndex={page} onPage={setPage} />
          </div>

          <div className="col-md-3">
            <div className="sidebar">
              <p>Popular Tags</p>
              <div className="tag-list">
                {tags.length === 0 && <span className="tag-default tag-pill">no tags yet</span>}
                {tags.map((t) => (
                  <button
                    key={t}
                    className="tag-pill tag-default"
                    onClick={() => select("tag", t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
