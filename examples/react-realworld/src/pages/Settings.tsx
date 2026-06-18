/**
 * Settings — edit the current user's profile, or log out.
 */
import * as React from "react";
import { useAuth } from "../auth";
import { navigate } from "../router";

export const Settings = (): React.ReactElement => {
  const { currentUser, updateSettings, logout } = useAuth();
  const [image, setImage] = React.useState(currentUser?.image ?? "");
  const [username] = React.useState(currentUser?.username ?? "");
  const [bio, setBio] = React.useState(currentUser?.bio ?? "");
  const [email, setEmail] = React.useState(currentUser?.email ?? "");
  const [password, setPassword] = React.useState(currentUser?.password ?? "");

  React.useEffect(() => {
    if (currentUser === null) navigate({ name: "login" });
  }, [currentUser]);

  if (currentUser === null) return <div className="settings-page" />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await updateSettings({ username, email, password, bio, image });
    navigate({ name: "profile", username, favorites: false });
  };

  return (
    <div className="settings-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-6 offset-md-3 col-xs-12">
            <h1 className="text-xs-center">Your Settings</h1>
            <form onSubmit={submit}>
              <fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control"
                    placeholder="URL of profile picture"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input className="form-control form-control-lg" value={username} disabled />
                </fieldset>
                <fieldset className="form-group">
                  <textarea
                    className="form-control form-control-lg"
                    rows={8}
                    placeholder="Short bio about you"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control form-control-lg"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control form-control-lg"
                    type="password"
                    placeholder="New Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </fieldset>
                <button className="btn btn-lg btn-primary pull-xs-right" type="submit">
                  Update Settings
                </button>
              </fieldset>
            </form>
            <hr />
            <button
              className="btn btn-outline-danger"
              onClick={() => {
                logout();
                navigate({ name: "home" });
              }}
            >
              Or click here to logout.
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
