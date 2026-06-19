/**
 * Article — full article, author actions, follow/favourite, and comments.
 */
import * as React from "react";
import { useActions } from "../actions";
import { useAuth } from "../auth";
import { useArticle, useComments } from "../data";
import { ArticleMeta, FavoriteButton, FollowButton } from "../components";
import { Link, navigate } from "../router";

const formatDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

export const ArticlePage = (props: { readonly slug: string }): React.ReactElement => {
  const { currentUsername } = useAuth();
  const actions = useActions();
  const view = useArticle(props.slug, currentUsername);
  const comments = useComments(props.slug, currentUsername);
  const [draft, setDraft] = React.useState("");

  if (view === undefined)
    return (
      <div className="article-page">
        <div className="container page">Loading article…</div>
      </div>
    );

  const isAuthor = currentUsername === view.author.username;

  const authorActions = isAuthor ? (
    <span>
      <Link
        to={{ name: "editor", slug: view.article.slug }}
        className="btn btn-sm btn-outline-secondary"
      >
        <i className="ion-edit" /> Edit Article
      </Link>{" "}
      <button
        className="btn btn-sm btn-outline-danger"
        onClick={() => {
          void actions?.deleteArticle(view.article.slug);
          navigate({ name: "home" });
        }}
      >
        <i className="ion-trash-a" /> Delete Article
      </button>
    </span>
  ) : (
    <span>
      <FollowButton profile={view.author} /> <FavoriteButton article={view} />
    </span>
  );

  const submitComment = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0 || actions === null) return;
    void actions.addComment(view.article.slug, body);
    setDraft("");
  };

  return (
    <div className="article-page">
      <div className="banner">
        <div className="container">
          <h1>{view.article.title}</h1>
          <div className="article-meta">
            <ArticleMeta view={view} />
            {authorActions}
          </div>
        </div>
      </div>

      <div className="container page">
        <div className="row article-content">
          <div className="col-md-12">
            <p style={{ whiteSpace: "pre-wrap" }}>{view.article.body}</p>
            <ul className="tag-list">
              {view.article.tagList.map((tag) => (
                <li key={tag} className="tag-default tag-pill tag-outline">
                  {tag}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <hr />

        <div className="article-actions">
          <div className="article-meta">
            <ArticleMeta view={view} />
            {authorActions}
          </div>
        </div>

        <div className="row">
          <div className="col-xs-12 col-md-8 offset-md-2">
            {currentUsername ? (
              <form className="card comment-form" onSubmit={submitComment}>
                <div className="card-block">
                  <textarea
                    className="form-control"
                    placeholder="Write a comment..."
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                </div>
                <div className="card-footer">
                  <button className="btn btn-sm btn-primary" type="submit">
                    Post Comment
                  </button>
                </div>
              </form>
            ) : (
              <p>
                <Link to={{ name: "login" }}>Sign in</Link> or{" "}
                <Link to={{ name: "register" }}>sign up</Link> to add comments.
              </p>
            )}

            {comments.map(({ comment, author }) => (
              <div key={comment.id} className="card">
                <div className="card-block">
                  <p className="card-text">{comment.body}</p>
                </div>
                <div className="card-footer">
                  <Link
                    to={{ name: "profile", username: author.username, favorites: false }}
                    className="comment-author"
                  >
                    <img src={author.image} className="comment-author-img" alt={author.username} />
                  </Link>{" "}
                  <Link
                    to={{ name: "profile", username: author.username, favorites: false }}
                    className="comment-author"
                  >
                    {author.username}
                  </Link>
                  <span className="date-posted">{formatDate(comment.createdAt)}</span>
                  {currentUsername === author.username && (
                    <span className="mod-options">
                      <i
                        className="ion-trash-a"
                        onClick={() => void actions?.deleteComment(comment.id)}
                      />
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
