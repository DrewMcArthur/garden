import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/backlinks.scss"
import { resolveRelative, simplifySlug } from "../util/path"
import { i18n } from "../i18n"
import { classNames } from "../util/lang"
import OverflowListFactory from "./OverflowList"

type AtprotoBacklink = {
  did: string
  collection: string
  rkey: string
  uri: string
  targetKind: "at-uri" | "url"
  href: string
  publicationName?: string
  publicationUrl?: string
  documentTitle?: string
  documentDescription?: string
  actorHandle?: string
  actorDisplayName?: string
  postText?: string
  postExternalTitle?: string
  postExternalDescription?: string
}

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
    const internalBacklinkRkeys = new Set(
      backlinkFiles
        .map((file) => file.frontmatter?.rkey)
        .filter((rkey): rkey is string => typeof rkey === "string" && rkey.trim().length > 0),
    )

    const rawExternalBacklinks = (fileData.atprotoBacklinks ?? []) as AtprotoBacklink[]
    const dedupedExternalByUri = new Map<string, AtprotoBacklink>()
    for (const backlink of rawExternalBacklinks) {
      dedupedExternalByUri.set(backlink.uri, backlink)
    }

    const externalBacklinks = [...dedupedExternalByUri.values()].filter((backlink) => {
      if (backlink.collection !== "site.standard.document") return true
      return !internalBacklinkRkeys.has(backlink.rkey)
    })

    const hasInternalBacklinks = backlinkFiles.length > 0
    const publicationBacklinks = externalBacklinks.filter(
      (backlink) => backlink.collection === "site.standard.document",
    )
    const blueskyBacklinks = externalBacklinks.filter(
      (backlink) => backlink.collection === "app.bsky.feed.post",
    )
    const otherBacklinks = externalBacklinks.filter(
      (backlink) =>
        backlink.collection !== "site.standard.document" &&
        backlink.collection !== "app.bsky.feed.post",
    )
    const hasExternalBacklinks =
      publicationBacklinks.length > 0 || blueskyBacklinks.length > 0 || otherBacklinks.length > 0
    if (options.hideWhenEmpty && !hasInternalBacklinks && !hasExternalBacklinks) {
      return null
    }

    const getExternalLabel = (backlink: AtprotoBacklink) =>
      `${backlink.collection} by ${backlink.did}`
    const sourceKindLabel = (backlink: AtprotoBacklink) =>
      backlink.targetKind === "url" ? "linked via URL" : "linked via at:// URI"

    return (
      <div class={classNames(displayClass, "backlinks")}>
        <h3>{i18n(cfg.locale).components.backlinks.title}</h3>
        {hasInternalBacklinks ? (
          <OverflowList>
            {backlinkFiles.map((f) => {
              const title = f.frontmatter?.title ?? i18n(cfg.locale).propertyDefaults.title
              const excerpt = truncateExcerpt(
                typeof f.description === "string" ? f.description : "",
              )
              return (
                <li class="backlink-item">
                  <a href={resolveRelative(fileData.slug!, f.slug!)} class="backlink-card">
                    <span class="backlink-title">{title}</span>
                    {excerpt && <p class="backlink-excerpt">{excerpt}</p>}
                  </a>
                </li>
              )
            })}
          </OverflowList>
        ) : (
          <p class="backlinks-empty">{i18n(cfg.locale).components.backlinks.noBacklinksFound}</p>
        )}

        {publicationBacklinks.length > 0 && (
          <>
            <h4 class="backlinks-external-heading">External publications</h4>
            <OverflowList>
              {publicationBacklinks.map((backlink) => (
                <li class="backlink-item">
                  <a
                    href={backlink.href}
                    class="backlink-card external-backlink"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span class="backlink-title">
                      {backlink.documentTitle ?? backlink.publicationName ?? "Untitled document"}
                    </span>
                    {(backlink.documentDescription || backlink.postExternalDescription) && (
                      <p class="backlink-excerpt">
                        {backlink.documentDescription ?? backlink.postExternalDescription}
                      </p>
                    )}
                    <p class="backlink-meta">
                      {backlink.publicationName ? backlink.publicationName : backlink.did}
                    </p>
                    <p class="backlink-source-kind">{sourceKindLabel(backlink)}</p>
                  </a>
                </li>
              ))}
            </OverflowList>
          </>
        )}

        {blueskyBacklinks.length > 0 && (
          <>
            <h4 class="backlinks-external-heading">Bluesky posts</h4>
            <OverflowList>
              {blueskyBacklinks.map((backlink) => (
                <li class="backlink-item">
                  <a
                    href={backlink.href}
                    class="backlink-card external-backlink"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span class="backlink-title">
                      @{backlink.actorHandle ?? backlink.did} on bsky
                    </span>
                    <p class="backlink-excerpt">
                      {backlink.postText ??
                        backlink.postExternalTitle ??
                        backlink.postExternalDescription ??
                        "Linked post"}
                    </p>
                    <p class="backlink-source-kind">{sourceKindLabel(backlink)}</p>
                  </a>
                </li>
              ))}
            </OverflowList>
          </>
        )}

        {otherBacklinks.length > 0 && (
          <>
            <h4 class="backlinks-external-heading">Other ATProto backlinks</h4>
            <OverflowList>
              {otherBacklinks.map((backlink) => (
                <li class="backlink-item">
                  <a
                    href={backlink.href}
                    class="backlink-card external-backlink"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span class="backlink-title">{getExternalLabel(backlink)}</span>
                    <p class="backlink-source-kind">{sourceKindLabel(backlink)}</p>
                  </a>
                </li>
              ))}
            </OverflowList>
          </>
        )}
      </div>
    )
  }

  Backlinks.css = style
  Backlinks.afterDOMLoaded = overflowListAfterDOMLoaded

  return Backlinks
}) satisfies QuartzComponentConstructor
