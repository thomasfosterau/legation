/**
 * Shared UI components
 *
 * Article previews + paginated list, the favourite/follow buttons, and the
 * article meta line. All render the denormalised views from `data.ts` and write
 * through `useActions`; the live queries make every favourite/follow update
 * appear immediately and stay consistent after rebase.
 */
import * as React from "react";
import { useActions } from "./actions";
import { useAuth } from "./auth";
import { PAGE_SIZE } from "./data";
import { Link, navigate } from "./router";
import type { ArticlePage, ArticleView, ProfileView } from "./types";

const formatDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

export const FavoriteButton = (props: {
  readonly article: ArticleView;
  readonly compact?: boolean;
}): React.ReactElement => {
  const actions = useActions();
  const { article, author, favorited, favoritesCount } = props.article;
  const onClick = () => {
    if (actions === null) return navigate({ name: "login" });
    void actions.setFavorite(article.slug, !favorited);
  };
  void author;
  return (
    <button
      className={`btn btn-sm ${favorited ? "btn-primary" : "btn-outline-primary"}`}
      onClick={onClick}
    >
      <i className="ion-heart" />{" "}
      {props.compact ? (
        <span>{favoritesCount}</span>
      ) : (
        <>
          {favorited ? "Unfavorite" : "Favorite"} <span className="counter">({favoritesCount})</span>
        </>
      )}
    </button>
  );
};

export const FollowButton = (props: { readonly profile: ProfileView }): React.ReactElement | null => {
  const actions = useActions();
  const { currentUsername } = useAuth();
  if (currentUsername === props.profile.username) return null;
  const onClick = () => {
    if (actions === null) return navigate({ name: "login" });
    void actions.setFollow(props.profile.username, !props.profile.following);
  };
  return (
    <button
      className={`btn btn-sm ${props.profile.following ? "btn-secondary" : "btn-outline-secondary"}`}
      onClick={onClick}
    >
      <i className="ion-plus-round" /> {props.profile.following ? "Unfollow" : "Follow"}{" "}
      {props.profile.username}
    </button>
  );
};

export const ArticleMeta = (props: { readonly view: ArticleView }): React.ReactElement => {
  const { article, author } = props.view;
  return (
    <div className="article-meta">
      <Link to={{ name: "profile", username: author.username, favorites: false }}>
        <img src={author.image} alt={author.username} />
      </Link>
      <div className="info">
        <Link
          to={{ name: "profile", username: author.username, favorites: false }}
          className="author"
        >
          {author.username}
        </Link>
        <span className="date">{formatDate(article.createdAt)}</span>
      </div>
    </div>
  );
};

export const ArticlePreview = (props: { readonly view: ArticleView }): React.ReactElement => {
  const { article } = props.view;
  return (
    <div className="article-preview">
      <div className="article-meta">
        <ArticleMeta view={props.view} />
        <div className="pull-xs-right">
          <FavoriteButton article={props.view} compact />
        </div>
      </div>
      <a
        href={`#/article/${encodeURIComponent(article.slug)}`}
        className="preview-link"
      >
        <h1>{article.title}</h1>
        <p>{article.description}</p>
        <span>Read more...</span>
        <ul className="tag-list">
          {article.tagList.map((tag) => (
            <li key={tag} className="tag-default tag-pill tag-outline">
              {tag}
            </li>
          ))}
        </ul>
      </a>
    </div>
  );
};

export const Pagination = (props: {
  readonly total: number;
  readonly page: number;
  readonly onPage: (page: number) => void;
}): React.ReactElement | null => {
  const pages = Math.ceil(props.total / PAGE_SIZE);
  if (pages <= 1) return null;
  return (
    <nav>
      <ul className="pagination">
        {Array.from({ length: pages }, (_, i) => (
          <li key={i} className={`page-item ${i === props.page ? "active" : ""}`}>
            <button className="page-link" onClick={() => props.onPage(i)}>
              {i + 1}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};

export const ArticleList = (props: {
  readonly page: ArticlePage;
  readonly pageIndex: number;
  readonly onPage: (page: number) => void;
  readonly emptyText?: string;
}): React.ReactElement => {
  if (props.page.articles.length === 0)
    return <div className="article-preview">{props.emptyText ?? "No articles are here... yet."}</div>;
  return (
    <>
      {props.page.articles.map((view) => (
        <ArticlePreview key={view.article.slug} view={view} />
      ))}
      <Pagination total={props.page.total} page={props.pageIndex} onPage={props.onPage} />
    </>
  );
};
