import path from "path"
import { QuartzEmitterPlugin } from "../types"
import { QuartzComponentProps } from "../../components/types"
import HeaderConstructor from "../../components/Header"
import BodyConstructor from "../../components/Body"
import { pageResources, renderPage } from "../../components/renderPage"
import { AtprotoBacklinksConfiguration, FullPageLayout } from "../../cfg"
import { FullSlug, pathToRoot, simplifySlug } from "../../util/path"
import { defaultContentPageLayout, sharedPageComponents } from "../../../quartz.layout"
import { Content } from "../../components"
import { styleText } from "util"
import { write } from "./helpers"
import { BuildCtx } from "../../util/ctx"
import { Node } from "unist"
import { StaticResources } from "../../util/resources"
import { QuartzPluginData } from "../vfile"

const CONSTELLATION_BASE = "https://constellation.microcosm.blue"
const HANDLE_RESOLVER_BASE = "https://public.api.bsky.app"
const APPVIEW_BASE = "https://public.api.bsky.app"
const PLC_DIRECTORY_BASE = "https://plc.directory"
const DEFAULT_REPO_COLLECTION = "site.standard.document"
const DEFAULT_SOURCE_COLLECTIONS = ["site.standard.document", "app.bsky.feed.post"] as const
const DEFAULT_BACKLINK_LIMIT = 12

type ConstellationRecord = {
  did: string
  collection: string
  rkey: string
}

type SourceCountsResponse = {
  links?: Record<string, Record<string, { records: number; distinct_dids: number }>>
}

type BacklinksResponse = {
  total?: number
  records?: ConstellationRecord[]
  cursor?: string | null
}

type BacklinkTargetKind = "at-uri" | "url"
type BacklinkTarget = {
  value: string
  kind: BacklinkTargetKind
}

export type AtprotoBacklink = ConstellationRecord & {
  source: string
  sourceCollection: string
  sourcePath: string
  uri: string
  href: string
  target: string
  targetKind: BacklinkTargetKind
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

const repoDidCache = new Map<string, string>()
const subjectBacklinksCache = new Map<string, Promise<AtprotoBacklink[]>>()
const didPdsCache = new Map<string, Promise<string | null>>()
const recordCache = new Map<string, Promise<Record<string, unknown> | null>>()

function getFrontmatterString(fileData: QuartzPluginData, key: string): string | undefined {
  const value = fileData.frontmatter?.[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeSourcePath(path: string): string {
  return path.startsWith(".") ? path.slice(1) : path
}

function sourceFromCollectionAndPath(collection: string, path: string): string {
  return `${collection}:${normalizeSourcePath(path)}`
}

function makeAtUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}

function hrefForRecord(record: ConstellationRecord): string {
  if (record.collection === "app.bsky.feed.post") {
    return `https://bsky.app/profile/${record.did}/post/${record.rkey}`
  }

  return makeAtUri(record.did, record.collection, record.rkey)
}

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/)
  if (!match) return null
  return { did: match[1], collection: match[2], rkey: match[3] }
}

function truncateText(text: string, maxLength = 180): string {
  const normalized = text.trim().replace(/\s+/g, " ")
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength).trimEnd()}...`
}

function extractDocumentSnippet(value: Record<string, unknown>): string | undefined {
  const maybeDescription = value.description
  if (typeof maybeDescription === "string" && maybeDescription.trim().length > 0) {
    return truncateText(maybeDescription)
  }

  const pages = (value.content as { pages?: unknown[] } | undefined)?.pages
  if (!Array.isArray(pages)) return undefined
  for (const page of pages) {
    const blocks = (page as { blocks?: unknown[] }).blocks
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      const text = (block as { block?: { plaintext?: unknown } }).block?.plaintext
      if (typeof text === "string" && text.trim().length > 0) {
        return truncateText(text)
      }
    }
  }

  return undefined
}

async function resolvePdsEndpointForDid(did: string): Promise<string | null> {
  const cached = didPdsCache.get(did)
  if (cached) {
    return cached
  }

  const pending = (async () => {
    try {
      const response = await fetch(`${PLC_DIRECTORY_BASE}/${did}`, {
        headers: { Accept: "application/json" },
      })
      if (!response.ok) return null
      const payload = (await response.json()) as {
        service?: Array<{ type?: string; serviceEndpoint?: string }>
      }
      const pdsService = payload.service?.find(
        (service) => service.type === "AtprotoPersonalDataServer",
      )
      return pdsService?.serviceEndpoint ?? null
    } catch {
      return null
    }
  })()

  didPdsCache.set(did, pending)
  return pending
}

async function fetchRepoRecord(
  did: string,
  collection: string,
  rkey: string,
): Promise<Record<string, unknown> | null> {
  const cacheKey = `${did}/${collection}/${rkey}`
  const cached = recordCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const pending = (async () => {
    const pdsEndpoint = await resolvePdsEndpointForDid(did)
    if (!pdsEndpoint) return null

    const endpoint = new URL("/xrpc/com.atproto.repo.getRecord", pdsEndpoint)
    endpoint.searchParams.set("repo", did)
    endpoint.searchParams.set("collection", collection)
    endpoint.searchParams.set("rkey", rkey)

    const response = await fetch(endpoint, { headers: { Accept: "application/json" } })
    if (!response.ok) return null
    const payload = (await response.json()) as { value?: Record<string, unknown> }
    return payload.value ?? null
  })()

  recordCache.set(cacheKey, pending)
  return pending
}

async function resolveRepoDid(repo: string): Promise<string> {
  if (repo.startsWith("did:")) return repo

  const cachedDid = repoDidCache.get(repo)
  if (cachedDid) return cachedDid

  const resolveUrl = new URL("/xrpc/com.atproto.identity.resolveHandle", HANDLE_RESOLVER_BASE)
  resolveUrl.searchParams.set("handle", repo)

  const response = await fetch(resolveUrl, { headers: { Accept: "application/json" } })
  if (!response.ok) {
    throw new Error(`resolveHandle failed for ${repo}: ${response.status}`)
  }

  const payload = (await response.json()) as { did?: string }
  if (!payload.did) {
    throw new Error(`resolveHandle returned no DID for ${repo}`)
  }

  repoDidCache.set(repo, payload.did)
  return payload.did
}

function parseSourceSpecs(payload: SourceCountsResponse): string[] {
  if (!payload.links) return []
  const specs: string[] = []
  for (const [collection, paths] of Object.entries(payload.links)) {
    for (const path of Object.keys(paths)) {
      specs.push(sourceFromCollectionAndPath(collection, path))
    }
  }

  return specs
}

function normalizeAtprotoBacklinksConfig(cfg?: AtprotoBacklinksConfiguration): Required<
  Pick<AtprotoBacklinksConfiguration, "repo" | "collection" | "sourceCollections" | "limit">
> & {
  enabled: boolean
} {
  return {
    enabled: cfg?.enabled ?? true,
    repo: cfg?.repo ?? process.env.QUARTZ_ATPROTO_REPO ?? process.env.ATPROTO_REPO ?? "drewmca.net",
    collection: cfg?.collection ?? process.env.QUARTZ_ATPROTO_COLLECTION ?? DEFAULT_REPO_COLLECTION,
    sourceCollections: cfg?.sourceCollections ?? [...DEFAULT_SOURCE_COLLECTIONS],
    limit: cfg?.limit ?? DEFAULT_BACKLINK_LIMIT,
  }
}

async function fetchBacklinksForSubject(
  target: BacklinkTarget,
  sourceCollections: readonly string[],
  limit: number,
): Promise<AtprotoBacklink[]> {
  const cacheKey = `${target.kind}:${target.value}|${sourceCollections.join(",")}|${limit}`
  const existing = subjectBacklinksCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const pending = (async () => {
    const sourceUrl = new URL("/links/all", CONSTELLATION_BASE)
    sourceUrl.searchParams.set("target", target.value)

    const sourceResp = await fetch(sourceUrl, { headers: { Accept: "application/json" } })
    if (!sourceResp.ok) {
      throw new Error(`links/all failed for ${target.value}: ${sourceResp.status}`)
    }

    const sourcePayload = (await sourceResp.json()) as SourceCountsResponse
    const sources = parseSourceSpecs(sourcePayload).filter((source) =>
      sourceCollections.some((collection) => source.startsWith(`${collection}:`)),
    )
    if (sources.length === 0) {
      return []
    }

    const backlinkGroups = await Promise.all(
      sources.map(async (source) => {
        const backlinksUrl = new URL("/xrpc/blue.microcosm.links.getBacklinks", CONSTELLATION_BASE)
        backlinksUrl.searchParams.set("subject", target.value)
        backlinksUrl.searchParams.set("source", source)
        backlinksUrl.searchParams.set("limit", `${limit}`)

        const backlinksResp = await fetch(backlinksUrl, { headers: { Accept: "application/json" } })
        if (!backlinksResp.ok) {
          return []
        }

        const payload = (await backlinksResp.json()) as BacklinksResponse
        const [sourceCollection, ...sourcePathParts] = source.split(":")
        const sourcePath = sourcePathParts.join(":")

        return (payload.records ?? []).map((record) => ({
          ...record,
          source,
          sourceCollection,
          sourcePath,
          uri: makeAtUri(record.did, record.collection, record.rkey),
          href: hrefForRecord(record),
          target: target.value,
          targetKind: target.kind,
        }))
      }),
    )

    const deduped = new Map<string, AtprotoBacklink>()
    for (const backlinks of backlinkGroups) {
      for (const backlink of backlinks) {
        const key = `${backlink.did}/${backlink.collection}/${backlink.rkey}`
        deduped.set(key, backlink)
      }
    }

    return [...deduped.values()]
  })()
    .catch((err) => {
      console.warn(
        styleText("yellow", `[ContentPage] failed to fetch ATProto backlinks for ${target.value}`),
      )
      console.warn(err)
      return []
    })
    .finally(() => {
      subjectBacklinksCache.delete(cacheKey)
    })

  subjectBacklinksCache.set(cacheKey, pending)
  return pending
}

async function enrichPublicationBacklink(backlink: AtprotoBacklink): Promise<AtprotoBacklink> {
  const value = await fetchRepoRecord(backlink.did, backlink.collection, backlink.rkey)
  if (!value) return backlink

  const enriched: AtprotoBacklink = { ...backlink }
  if (typeof value.title === "string" && value.title.trim().length > 0) {
    enriched.documentTitle = value.title
  }
  const snippet = extractDocumentSnippet(value)
  if (snippet) {
    enriched.documentDescription = snippet
  }

  const siteUri = typeof value.site === "string" ? value.site : undefined
  if (siteUri) {
    const siteRef = parseAtUri(siteUri)
    if (siteRef?.collection === "site.standard.publication") {
      const publication = await fetchRepoRecord(siteRef.did, siteRef.collection, siteRef.rkey)
      if (publication) {
        if (typeof publication.name === "string" && publication.name.trim().length > 0) {
          enriched.publicationName = publication.name
        }
        if (typeof publication.url === "string" && publication.url.trim().length > 0) {
          enriched.publicationUrl = publication.url
          const recordPath = typeof value.path === "string" ? value.path : undefined
          if (recordPath) {
            try {
              enriched.href = new URL(recordPath, publication.url).toString()
            } catch {
              // fall back to AT URI when URL composition fails
            }
          }
        }
      }
    }
  }

  return enriched
}

async function enrichBlueskyBacklinks(backlinks: AtprotoBacklink[]): Promise<AtprotoBacklink[]> {
  if (backlinks.length === 0) return backlinks

  const postUris = backlinks.map((backlink) => backlink.uri)
  const chunks: string[][] = []
  for (let i = 0; i < postUris.length; i += 25) {
    chunks.push(postUris.slice(i, i + 25))
  }

  const postMap = new Map<string, Record<string, unknown>>()
  await Promise.all(
    chunks.map(async (chunk) => {
      const url = new URL("/xrpc/app.bsky.feed.getPosts", APPVIEW_BASE)
      for (const uri of chunk) {
        url.searchParams.append("uris", uri)
      }

      const response = await fetch(url, { headers: { Accept: "application/json" } })
      if (!response.ok) return
      const payload = (await response.json()) as { posts?: Array<Record<string, unknown>> }
      for (const post of payload.posts ?? []) {
        const uri = post.uri
        if (typeof uri === "string") {
          postMap.set(uri, post)
        }
      }
    }),
  )

  return backlinks.map((backlink) => {
    const post = postMap.get(backlink.uri)
    if (!post) return backlink

    const author = (post.author as Record<string, unknown> | undefined) ?? {}
    const record = (post.record as Record<string, unknown> | undefined) ?? {}
    const embed = (post.embed as Record<string, unknown> | undefined) ?? {}
    const external = (embed.external as Record<string, unknown> | undefined) ?? {}

    return {
      ...backlink,
      actorHandle: typeof author.handle === "string" ? author.handle : undefined,
      actorDisplayName: typeof author.displayName === "string" ? author.displayName : undefined,
      postText: typeof record.text === "string" ? truncateText(record.text, 220) : undefined,
      postExternalTitle:
        typeof external.title === "string" ? truncateText(external.title, 120) : undefined,
      postExternalDescription:
        typeof external.description === "string"
          ? truncateText(external.description, 200)
          : undefined,
    }
  })
}

async function enrichAtprotoBacklinks(backlinks: AtprotoBacklink[]): Promise<AtprotoBacklink[]> {
  const publicationBacklinks = backlinks.filter(
    (backlink) => backlink.collection === "site.standard.document",
  )
  const blueskyBacklinks = backlinks.filter(
    (backlink) => backlink.collection === "app.bsky.feed.post",
  )
  const otherBacklinks = backlinks.filter(
    (backlink) =>
      backlink.collection !== "site.standard.document" &&
      backlink.collection !== "app.bsky.feed.post",
  )

  const enrichedPublications = await Promise.all(
    publicationBacklinks.map((backlink) => enrichPublicationBacklink(backlink)),
  )
  const enrichedBluesky = await enrichBlueskyBacklinks(blueskyBacklinks)

  return [...enrichedPublications, ...enrichedBluesky, ...otherBacklinks]
}

function stripOneTrailingSlash(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
      return parsed.origin
    }
  } catch (_) {}

  return url.endsWith("/") ? url.slice(0, -1) : url
}

function pageUrlCandidates(ctx: BuildCtx, fileData: QuartzPluginData): string[] {
  if (!ctx.cfg.configuration.baseUrl || fileData.slug === "404") {
    return []
  }

  const base = `https://${ctx.cfg.configuration.baseUrl}`
  const fullSlugUrl = `${base}/${fileData.slug!}`
  const simpleSlug = simplifySlug(fileData.slug! as FullSlug)
  const simpleSlugUrl = simpleSlug === "/" ? `${base}/` : `${base}${simpleSlug}`

  const candidates = new Set<string>()
  const addVariants = (url: string) => {
    candidates.add(url)
    candidates.add(stripOneTrailingSlash(url))
    if (!url.endsWith("/")) {
      candidates.add(`${url}/`)
    }
  }

  addVariants(fullSlugUrl)
  addVariants(simpleSlugUrl)

  return [...candidates]
}

async function hydrateAtprotoBacklinks(ctx: BuildCtx, fileData: QuartzPluginData) {
  try {
    const atprotoCfg = normalizeAtprotoBacklinksConfig(ctx.cfg.configuration.atprotoBacklinks)
    if (!atprotoCfg.enabled) {
      fileData.atprotoBacklinks = []
      fileData.atprotoUri = undefined
      return
    }

    const rkey = getFrontmatterString(fileData, "rkey")
    if (!rkey) {
      fileData.atprotoBacklinks = []
      fileData.atprotoUri = undefined
      return
    }

    const repoHint =
      getFrontmatterString(fileData, "repoDid") ??
      getFrontmatterString(fileData, "repo") ??
      getFrontmatterString(fileData, "did") ??
      atprotoCfg.repo
    const collection = getFrontmatterString(fileData, "repoCollection") ?? atprotoCfg.collection

    const repoDid = await resolveRepoDid(repoHint)
    const subject = rkey.startsWith("at://") ? rkey : makeAtUri(repoDid, collection, rkey)
    fileData.atprotoUri = subject

    const targets: BacklinkTarget[] = [{ value: subject, kind: "at-uri" }]
    for (const url of pageUrlCandidates(ctx, fileData)) {
      targets.push({ value: url, kind: "url" })
    }

    const backlinkGroups = await Promise.all(
      targets.map((target) =>
        fetchBacklinksForSubject(target, atprotoCfg.sourceCollections, atprotoCfg.limit),
      ),
    )
    const deduped = new Map<string, AtprotoBacklink>()
    for (const backlinks of backlinkGroups) {
      for (const backlink of backlinks) {
        const key = `${backlink.did}/${backlink.collection}/${backlink.rkey}`
        deduped.set(key, backlink)
      }
    }

    fileData.atprotoBacklinks = await enrichAtprotoBacklinks([...deduped.values()])
  } catch (err) {
    console.warn(styleText("yellow", `[ContentPage] failed to hydrate ATProto backlinks`))
    console.warn(err)
    fileData.atprotoBacklinks = []
    fileData.atprotoUri = undefined
  }
}

async function processContent(
  ctx: BuildCtx,
  tree: Node,
  fileData: QuartzPluginData,
  allFiles: QuartzPluginData[],
  opts: FullPageLayout,
  resources: StaticResources,
) {
  const slug = fileData.slug!
  const cfg = ctx.cfg.configuration
  const externalResources = pageResources(pathToRoot(slug), resources)
  const componentData: QuartzComponentProps = {
    ctx,
    fileData,
    externalResources,
    cfg,
    children: [],
    tree,
    allFiles,
  }

  const content = renderPage(cfg, slug, componentData, opts, externalResources)
  return write({
    ctx,
    content,
    slug,
    ext: ".html",
  })
}

export const ContentPage: QuartzEmitterPlugin<Partial<FullPageLayout>> = (userOpts) => {
  const opts: FullPageLayout = {
    ...sharedPageComponents,
    ...defaultContentPageLayout,
    pageBody: Content(),
    ...userOpts,
  }

  const { head: Head, header, beforeBody, pageBody, afterBody, left, right, footer: Footer } = opts
  const Header = HeaderConstructor()
  const Body = BodyConstructor()

  return {
    name: "ContentPage",
    getQuartzComponents() {
      return [
        Head,
        Header,
        Body,
        ...header,
        ...beforeBody,
        pageBody,
        ...afterBody,
        ...left,
        ...right,
        Footer,
      ]
    },
    async *emit(ctx, content, resources) {
      const allFiles = content.map((c) => c[1].data)
      let containsIndex = false

      for (const [tree, file] of content) {
        const slug = file.data.slug!
        await hydrateAtprotoBacklinks(ctx, file.data)
        if (slug === "index") {
          containsIndex = true
        }

        // only process home page, non-tag pages, and non-index pages
        if (slug.endsWith("/index") || slug.startsWith("tags/")) continue
        yield processContent(ctx, tree, file.data, allFiles, opts, resources)
      }

      if (!containsIndex) {
        console.log(
          styleText(
            "yellow",
            `\nWarning: you seem to be missing an \`index.md\` home page file at the root of your \`${ctx.argv.directory}\` folder (\`${path.join(ctx.argv.directory, "index.md")} does not exist\`). This may cause errors when deploying.`,
          ),
        )
      }
    },
    async *partialEmit(ctx, content, resources, changeEvents) {
      const allFiles = content.map((c) => c[1].data)

      // find all slugs that changed or were added
      const changedSlugs = new Set<string>()
      for (const changeEvent of changeEvents) {
        if (!changeEvent.file) continue
        if (changeEvent.type === "add" || changeEvent.type === "change") {
          changedSlugs.add(changeEvent.file.data.slug!)
        }
      }

      for (const [tree, file] of content) {
        const slug = file.data.slug!
        if (!changedSlugs.has(slug)) continue
        if (slug.endsWith("/index") || slug.startsWith("tags/")) continue
        await hydrateAtprotoBacklinks(ctx, file.data)

        yield processContent(ctx, tree, file.data, allFiles, opts, resources)
      }
    },
  }
}

declare module "vfile" {
  interface DataMap {
    atprotoBacklinks: AtprotoBacklink[]
    atprotoUri?: string
  }
}
