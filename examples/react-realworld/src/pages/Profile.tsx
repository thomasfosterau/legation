/**
 * Profile — a user's info, follow button, and their articles / favourites.
 */
import * as React from "react";
import { useAuth } from "../auth";
import { useArticles, useProfile } from "../data";
import { ArticleList, FollowButton } from "../components";
import { Link } from "../router";
import type { Feed } from "../types";

export const Profile = (props: {
  readonly username: string;
  readonly favorites: boolean;
}): React.ReactElement => {
  const { currentUsername } = useAuth();
  const profile = useProfile(props.username, currentUsername);
  const [page, setPage] = React.useState(0);
  const isSelf = currentUsername === props.username;

  React.useEffect(() => setPage(0), [props.username, props.favorites]);

  const feed: Feed = props.favorites
    ? { kind: "favorited", username: props.username }
    : { kind: "author", username: props.username };
  const articles = useArticles(feed, page, currentUsername);

  return (
    <div className="profile-page">
      <div className="user-info">
        <div className="container">
          <div className="row">
            <div className="col-xs-12 col-md-10 offset-md-1">
              <img src={profile.image} className="user-img" alt={profile.username} />
              <h4>{profile.username}</h4>
              <p>{profile.bio}</p>
              {isSelf ? (
                <Link
                  to={{ name: "settings" }}
                  className="btn btn-sm btn-outline-secondary action-btn"
                >
                  <i className="ion-gear-a" /> Edit Profile Settings
                </Link>
              ) : (
                <span className="action-btn">
                  <FollowButton profile={profile} />
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="container">
        <div className="row">
          <div className="col-xs-12 col-md-10 offset-md-1">
            <div className="articles-toggle">
              <ul className="nav nav-pills outline-active">
                <li className="nav-item">
                  <a
                    className={`nav-link ${!props.favorites ? "active" : ""}`}
                    href={`#/profile/${encodeURIComponent(props.username)}`}
                  >
                    My Articles
                  </a>
                </li>
                <li className="nav-item">
                  <a
                    className={`nav-link ${props.favorites ? "active" : ""}`}
                    href={`#/profile/${encodeURIComponent(props.username)}/favorites`}
                  >
                    Favorited Articles
                  </a>
                </li>
              </ul>
            </div>
            <ArticleList page={articles} pageIndex={page} onPage={setPage} />
          </div>
        </div>
      </div>
    </div>
  );
};
