import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
// @ts-ignore
import copyAtUriScript from "./scripts/copyAtUri.inline"

const ArticleTitle: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const title = fileData.frontmatter?.title
  const atprotoUri = fileData.atprotoUri
  if (title) {
    return (
      <div class={classNames(displayClass, "article-title-row")}>
        <h1 class="article-title">{title}</h1>
        {atprotoUri && (
          <button
            class="copy-at-uri-btn"
            type="button"
            data-copy-at-uri={atprotoUri}
            title="copy at:// uri"
            aria-label="copy at:// uri"
          >
            @
          </button>
        )}
      </div>
    )
  } else {
    return null
  }
}

ArticleTitle.css = `
.article-title-row {
  margin: 2rem 0 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem 0.8rem;
  align-items: center;
}

.article-title-row > .article-title {
  margin: 0;
}

.copy-at-uri-btn {
  border: none;
  background: transparent;
  color: var(--gray);
  opacity: 0.46;
  padding: 0.12rem 0.2rem;
  font-size: 1.5rem;
  line-height: 1.1;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s ease, color 0.15s ease;
}

.copy-at-uri-btn:hover {
  color: var(--dark);
  opacity: 0.95;
}

@media all and (max-width: 800px) {
  .article-title-row {
    align-items: flex-start;
  }
}

.article-title {
  margin: 2rem 0 0 0;
}
`

ArticleTitle.afterDOMLoaded = copyAtUriScript

export default (() => ArticleTitle) satisfies QuartzComponentConstructor
