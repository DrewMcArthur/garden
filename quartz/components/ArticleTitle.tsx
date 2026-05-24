import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { joinSegments, simplifySlug } from "../util/path"
// @ts-ignore
import copyAtUriScript from "./scripts/copyAtUri.inline"

const ArticleTitle: QuartzComponent = ({ fileData, cfg, displayClass }: QuartzComponentProps) => {
  const title = fileData.frontmatter?.title
  const atprotoUri = fileData.atprotoUri
  const noteUrl =
    fileData.slug && cfg.baseUrl
      ? `https://${joinSegments(cfg.baseUrl, encodeURI(simplifySlug(fileData.slug)))}`
      : undefined

  if (title) {
    return (
      <div class={classNames(displayClass, "article-title-row")}>
        <h1 class="article-title">{title}</h1>
        {noteUrl && (
          // <button
          //   class="copy-title-link-btn"
          //   type="button"
          //   data-copy-note-url={noteUrl}
          //   title="copy direct note link"
          //   aria-label="copy direct note link"
          // >
          <a href={noteUrl} style="margin-bottom: .1rem;">
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </a>
        )}
        {atprotoUri && false && (
          // <button
          //   class="copy-title-link-btn copy-at-uri-btn"
          //   type="button"
          //   data-copy-at-uri={atprotoUri}
          //   title="copy at:// uri"
          //   aria-label="copy at:// uri"
          // >
          <a href={atprotoUri}>
            @
          </a>
        )
        }
      </div >
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
  align-items: end;
}

.article-title-row > .article-title {
  margin: 0;
}

.copy-title-link-btn {
  border: none;
  background: transparent;
  color: var(--gray);
  opacity: 0.46;
  padding: 0.12rem 0.2rem;
  font-size: 1.35rem;
  line-height: 1.1;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s ease, color 0.15s ease;
}

.copy-title-link-btn:hover {
  color: var(--dark);
  opacity: 0.95;
}

.copy-title-link-btn svg {
  display: block;
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
