/**
 * Auth pages — Sign in / Sign up.
 */
import * as React from "react";
import { useAuth } from "../auth";
import { Link, navigate } from "../router";

export const Login = (): React.ReactElement => {
  const { login } = useAuth();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const err = login(username.trim(), password);
    if (err) setError(err);
    else navigate({ name: "home" });
  };

  return (
    <div className="auth-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-6 offset-md-3 col-xs-12">
            <h1 className="text-xs-center">Sign in</h1>
            <p className="text-xs-center">
              <Link to={{ name: "register" }}>Need an account?</Link>
            </p>
            <p className="text-xs-center text-muted">Try emma / demo or liang / demo.</p>
            {error && (
              <ul className="error-messages">
                <li>{error}</li>
              </ul>
            )}
            <form onSubmit={submit}>
              <fieldset className="form-group">
                <input
                  className="form-control form-control-lg"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </fieldset>
              <fieldset className="form-group">
                <input
                  className="form-control form-control-lg"
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </fieldset>
              <button className="btn btn-lg btn-primary pull-xs-right" type="submit">
                Sign in
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export const Register = (): React.ReactElement => {
  const { register } = useAuth();
  const [username, setUsername] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const err = await register(username.trim(), email.trim(), password);
    if (err) setError(err);
    else navigate({ name: "home" });
  };

  return (
    <div className="auth-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-6 offset-md-3 col-xs-12">
            <h1 className="text-xs-center">Sign up</h1>
            <p className="text-xs-center">
              <Link to={{ name: "login" }}>Have an account?</Link>
            </p>
            {error && (
              <ul className="error-messages">
                <li>{error}</li>
              </ul>
            )}
            <form onSubmit={submit}>
              <fieldset className="form-group">
                <input
                  className="form-control form-control-lg"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
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
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </fieldset>
              <button className="btn btn-lg btn-primary pull-xs-right" type="submit">
                Sign up
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
