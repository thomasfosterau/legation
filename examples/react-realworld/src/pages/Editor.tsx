/**
 * Editor — create or edit an article.
 */
import * as React from "react";
import { useActions } from "../actions";
import { useAuth } from "../auth";
import { useArticle } from "../data";
import { navigate } from "../router";

export const Editor = (props: { readonly slug?: string }): React.ReactElement => {
  const actions = useActions();
  const { currentUsername } = useAuth();
  const existing = useArticle(props.slug ?? "", currentUsername);

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [body, setBody] = React.useState("");
  const [tagsText, setTagsText] = React.useState("");
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    if (currentUsername === null) navigate({ name: "login" });
  }, [currentUsername]);

  // Hydrate the form once the article to edit has loaded.
  React.useEffect(() => {
    if (props.slug && existing && !hydrated) {
      setTitle(existing.article.title);
      setDescription(existing.article.description);
      setBody(existing.article.body);
      setTagsText(existing.article.tagList.join(" "));
      setHydrated(true);
    }
  }, [props.slug, existing, hydrated]);

  if (actions === null) return <div className="editor-page" />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const tagList = tagsText.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0);
    if (props.slug && existing) {
      await actions.updateArticle(props.slug, {
        title,
        description,
        body,
        tagList,
        createdAt: existing.article.createdAt,
      });
      navigate({ name: "article", slug: props.slug });
    } else {
      const slug = await actions.createArticle({ title, description, body, tagList });
      navigate({ name: "article", slug });
    }
  };

  return (
    <div className="editor-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-10 offset-md-1 col-xs-12">
            <form onSubmit={submit}>
              <fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control form-control-lg"
                    placeholder="Article Title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control"
                    placeholder="What's this article about?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <textarea
                    className="form-control"
                    rows={8}
                    placeholder="Write your article (in markdown)"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control"
                    placeholder="Enter tags (space separated)"
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                  />
                </fieldset>
                <button className="btn btn-lg pull-xs-right btn-primary" type="submit">
                  Publish Article
                </button>
              </fieldset>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
