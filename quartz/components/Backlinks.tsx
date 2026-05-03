import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/backlinks.scss"
import { resolveRelative, simplifySlug } from "../util/path"
import { i18n } from "../i18n"
import { classNames } from "../util/lang"
import OverflowListFactory from "./OverflowList"

interface BacklinksOptions {
  hideWhenEmpty: boolean
}

const defaultOptions: BacklinksOptions = {
  hideWhenEmpty: true,
}

export default ((opts?: Partial<BacklinksOptions>) => {
  const options: BacklinksOptions = { ...defaultOptions, ...opts }
  const { OverflowList, overflowListAfterDOMLoaded } = OverflowListFactory()
  const truncateExcerpt = (text?: string, maxLength = 70) => {
    if (!text) return null
    const normalized = text.trim().replace(/\s+/g, " ")
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, maxLength).trimEnd()}…`
  }

  const Backlinks: QuartzComponent = ({
    fileData,
    allFiles,
    displayClass,
    cfg,
  }: QuartzComponentProps) => {
    const slug = simplifySlug(fileData.slug!)
    const backlinkFiles = allFiles.filter((file) => file.links?.includes(slug))
    if (options.hideWhenEmpty && backlinkFiles.length == 0) {
      return null
    }
    return (
      <div class={classNames(displayClass, "backlinks")}>
        <h3>{i18n(cfg.locale).components.backlinks.title}</h3>
        <OverflowList>
          {backlinkFiles.length > 0 ? (
            backlinkFiles.map((f) => {
              const title = f.frontmatter?.title ?? i18n(cfg.locale).propertyDefaults.title
              const excerpt = truncateExcerpt(typeof f.description === "string" ? f.description : "")
              return (
                <li class="backlink-item">
                  <a href={resolveRelative(fileData.slug!, f.slug!)} class="backlink-card">
                    <span class="backlink-title">{title}</span>
                    {excerpt && <p class="backlink-excerpt">{excerpt}</p>}
                  </a>
                </li>
              )
            })
          ) : (
            <li>{i18n(cfg.locale).components.backlinks.noBacklinksFound}</li>
          )}
        </OverflowList>
      </div>
    )
  }

  Backlinks.css = style
  Backlinks.afterDOMLoaded = overflowListAfterDOMLoaded

  return Backlinks
}) satisfies QuartzComponentConstructor
