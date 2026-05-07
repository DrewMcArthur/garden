import { styleText } from "util"
import { AtprotoBacklinksConfiguration } from "../cfg"
import { BuildCtx } from "../util/ctx"
import { FilePath, FullSlug, SimpleSlug, resolveRelative, simplifySlug } from "../util/path"
import { Root, ElementContent } from "hast"
import { ProcessedContent, QuartzPluginData } from "./vfile"

const CONSTELLATION_BASE = "https://constellation.microcosm.blue"
const HANDLE_RESOLVER_BASE = "https://public.api.bsky.app"
const APPVIEW_BASE = "https://public.api.bsky.app"
const PLC_DIRECTORY_BASE = "https://plc.directory"
const DEFAULT_REPO_COLLECTION = "site.standard.document"
const DEFAULT_SOURCE_COLLECTIONS = ["site.standard.document", "app.bsky.feed.post"] as const
const DEFAULT_BACKLINK_LIMIT = 12
const GENERATED_COLLECTIONS = new Set(["site.standard.document", "app.bsky.feed.post"])

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

type AtprotoGeneratedRecord = {
  collection: string
  did: string
  rkey: string
  uri: string
  href: string
  sourceKind: BacklinkTargetKind
}

type AtprotoBreadcrumb = {
  displayName: string
  slug?: FullSlug
}

export type AtprotoBacklink = ConstellationRecord & {
  source: string
  sourceCollection: string
  sourcePath: string
  uri: string
  href: string
  target: string
  targetKind: BacklinkTargetKind
  internalSlug?: FullSlug
  publicationName?: string
  publicationUrl?: string
  documentTitle?: string
  documentDescription?: string
  actorHandle?: string
  actorDisplayName?: string
  postText?: string
  postExternalTitle?: string
  postExternalDescription?: string
  documentRecord?: Record<string, unknown>
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

export function getAtUri(fileData: QuartzPluginData): string | undefined {
  const atUri = fileData.atprotoUri ?? fileData.atUri
  if (typeof atUri !== "string") return undefined

  const trimmed = atUri.trim()
  return trimmed.length > 0 ? trimmed : undefined
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
  if (cached) return cached

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
  if (cached) return cached

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

export function normalizeAtprotoBacklinksConfig(cfg?: AtprotoBacklinksConfiguration): Required<
  Pick<
    AtprotoBacklinksConfiguration,
    "repo" | "collection" | "sourceCollections" | "limit" | "emitHttpHeader"
  >
> & {
  enabled: boolean
} {
  return {
    enabled: cfg?.enabled ?? true,
    repo: cfg?.repo ?? process.env.QUARTZ_ATPROTO_REPO ?? process.env.ATPROTO_REPO ?? "drewmca.net",
    collection: cfg?.collection ?? process.env.QUARTZ_ATPROTO_COLLECTION ?? DEFAULT_REPO_COLLECTION,
    sourceCollections: cfg?.sourceCollections ?? [...DEFAULT_SOURCE_COLLECTIONS],
    limit: cfg?.limit ?? DEFAULT_BACKLINK_LIMIT,
    emitHttpHeader: cfg?.emitHttpHeader ?? false,
  }
}

async function fetchBacklinksForSubject(
  target: BacklinkTarget,
  sourceCollections: readonly string[],
  limit: number,
): Promise<AtprotoBacklink[]> {
  const cacheKey = `${target.kind}:${target.value}|${sourceCollections.join(",")}|${limit}`
  const existing = subjectBacklinksCache.get(cacheKey)
  if (existing) return existing

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
    if (sources.length === 0) return []

    const backlinkGroups = await Promise.all(
      sources.map(async (source) => {
        const backlinksUrl = new URL("/xrpc/blue.microcosm.links.getBacklinks", CONSTELLATION_BASE)
        backlinksUrl.searchParams.set("subject", target.value)
        backlinksUrl.searchParams.set("source", source)
        backlinksUrl.searchParams.set("limit", `${limit}`)

        const backlinksResp = await fetch(backlinksUrl, { headers: { Accept: "application/json" } })
        if (!backlinksResp.ok) return []

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
      console.warn(styleText("yellow", `[ATProto] failed to fetch backlinks for ${target.value}`))
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
  enriched.documentRecord = value
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
  if (!ctx.cfg.configuration.baseUrl || fileData.slug === "404") return []

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

    const rkey = getFrontmatterString(fileData, "rkey")
    if (!rkey) {
      fileData.atprotoBacklinks = []
      fileData.atprotoUri = undefined
      fileData.atUri = undefined
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
    fileData.atUri = subject

    if (!atprotoCfg.enabled) {
      fileData.atprotoBacklinks = []
      return
    }

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
    console.warn(styleText("yellow", `[ATProto] failed to hydrate backlinks`))
    console.warn(err)
    fileData.atprotoBacklinks = []
    if (!getAtUri(fileData)) {
      fileData.atprotoUri = undefined
      fileData.atUri = undefined
    }
  }
}

function slugForBacklink(backlink: AtprotoBacklink): FullSlug {
  return `atproto/${backlink.collection}/${backlink.did}/${backlink.rkey}` as FullSlug
}

function backlinkTitle(backlink: AtprotoBacklink): string {
  if (backlink.collection === "app.bsky.feed.post") {
    return `@${backlink.actorHandle ?? backlink.did} on Bluesky`
  }

  if (backlink.collection === "site.standard.document") {
    return backlink.documentTitle ?? backlink.publicationName ?? "Untitled document"
  }

  return `${backlink.collection} by ${backlink.did}`
}

function backlinkDescription(backlink: AtprotoBacklink): string {
  return (
    backlink.postText ??
    backlink.documentDescription ??
    backlink.postExternalTitle ??
    backlink.postExternalDescription ??
    backlink.publicationName ??
    backlink.uri
  )
}

function textNode(value: string): ElementContent {
  return { type: "text", value }
}

function paragraph(children: ElementContent[], className?: string): ElementContent {
  return {
    type: "element",
    tagName: "p",
    properties: className ? { className: [className] } : {},
    children,
  }
}

function link(href: string, label: string, internal = false): ElementContent {
  return {
    type: "element",
    tagName: "a",
    properties: internal
      ? { href, className: ["internal"] }
      : { href, target: "_blank", rel: ["noopener", "noreferrer"] },
    children: [textNode(label)],
  }
}

function element(
  tagName: string,
  properties: Record<string, string | number | boolean | (string | number)[] | null | undefined>,
  children: ElementContent[],
): ElementContent {
  return {
    type: "element",
    tagName,
    properties,
    children,
  }
}

function byteIndexToStringIndex(text: string, byteIndex: number): number {
  let bytes = 0
  let stringIndex = 0
  const encoder = new TextEncoder()
  for (const char of text) {
    if (bytes >= byteIndex) break
    bytes += encoder.encode(char).length
    stringIndex += char.length
  }

  return stringIndex
}

function leafletFacetHref(features: Array<Record<string, unknown>>): string | undefined {
  for (const feature of features) {
    if (typeof feature.uri === "string") return feature.uri
    if (typeof feature.did === "string") return `at://${feature.did}`
  }

  return undefined
}

function leafletFacetHasCode(features: Array<Record<string, unknown>>): boolean {
  return features.some((feature) => feature.$type === "pub.leaflet.richtext.facet#code")
}

function renderLeafletText(plaintext: string, facets: unknown): ElementContent[] {
  if (!Array.isArray(facets) || facets.length === 0) {
    return [textNode(plaintext)]
  }

  const sortedFacets = facets
    .map(
      (facet) =>
        facet as { index?: { byteStart?: unknown; byteEnd?: unknown }; features?: unknown },
    )
    .filter(
      (facet) =>
        typeof facet.index?.byteStart === "number" &&
        typeof facet.index?.byteEnd === "number" &&
        Array.isArray(facet.features),
    )
    .sort((a, b) => (a.index!.byteStart as number) - (b.index!.byteStart as number))

  const children: ElementContent[] = []
  let cursor = 0
  for (const facet of sortedFacets) {
    const start = byteIndexToStringIndex(plaintext, facet.index!.byteStart as number)
    const end = byteIndexToStringIndex(plaintext, facet.index!.byteEnd as number)
    if (start < cursor || end <= start) continue

    if (start > cursor) {
      children.push(textNode(plaintext.slice(cursor, start)))
    }

    const features = facet.features as Array<Record<string, unknown>>
    const segment = plaintext.slice(start, end)
    let segmentNode: ElementContent = textNode(segment)
    if (leafletFacetHasCode(features)) {
      segmentNode = element("code", {}, [segmentNode])
    }

    const href = leafletFacetHref(features)
    if (href) {
      segmentNode = element("a", { href, target: "_blank", rel: ["noopener", "noreferrer"] }, [
        segmentNode,
      ])
    }

    children.push(segmentNode)
    cursor = end
  }

  if (cursor < plaintext.length) {
    children.push(textNode(plaintext.slice(cursor)))
  }

  return children
}

function leafletPlaintext(backlink: AtprotoBacklink): string | undefined {
  const pages = (backlink.documentRecord?.content as { pages?: unknown[] } | undefined)?.pages
  if (!Array.isArray(pages)) return undefined

  const blocks: string[] = []
  for (const page of pages) {
    const pageBlocks = (page as { blocks?: unknown[] }).blocks
    if (!Array.isArray(pageBlocks)) continue

    for (const blockWrapper of pageBlocks) {
      const block = (blockWrapper as { block?: Record<string, unknown> }).block
      const plaintext = block?.plaintext
      if (block?.$type === "pub.leaflet.blocks.text" && typeof plaintext === "string") {
        blocks.push(plaintext)
      }
    }
  }

  return blocks.length > 0 ? blocks.join("\n\n") : undefined
}

function renderLeafletContent(backlink: AtprotoBacklink): ElementContent[] | undefined {
  const content = backlink.documentRecord?.content as
    | { $type?: unknown; pages?: unknown[] }
    | undefined
  if (content?.$type !== "pub.leaflet.content" || !Array.isArray(content.pages)) {
    return undefined
  }

  const children: ElementContent[] = []
  for (const page of content.pages) {
    const blocks = (page as { blocks?: unknown[] }).blocks
    if (!Array.isArray(blocks)) continue

    for (const blockWrapper of blocks) {
      const block = (blockWrapper as { block?: Record<string, unknown> }).block
      const plaintext = block?.plaintext
      if (block?.$type === "pub.leaflet.blocks.text" && typeof plaintext === "string") {
        children.push(paragraph(renderLeafletText(plaintext, block.facets)))
      }
    }
  }

  return children.length > 0 ? children : undefined
}

function generatedBreadcrumbs(title: string, linkedNotes: QuartzPluginData[]): AtprotoBreadcrumb[] {
  const root: AtprotoBreadcrumb = { displayName: "Home", slug: "index" as FullSlug }
  if (linkedNotes.length === 1) {
    const note = linkedNotes[0]
    return [
      root,
      {
        displayName: note.frontmatter?.title ?? note.slug!,
        slug: note.slug!,
      },
      { displayName: title },
    ]
  }

  return [root, { displayName: title }]
}

function buildRecordTree(backlink: AtprotoBacklink, linkedNotes: QuartzPluginData[]): Root {
  const description = backlinkDescription(backlink)
  const sourceLabel = backlink.targetKind === "url" ? "Linked via URL" : "Linked via at:// URI"
  const sourceParts = [
    backlink.collection,
    backlink.publicationName ?? backlink.actorDisplayName ?? backlink.actorHandle ?? backlink.did,
    sourceLabel,
  ].filter(Boolean)
  const renderedContent = renderLeafletContent(backlink)
  const children: ElementContent[] = renderedContent ?? [
    paragraph([textNode(description)], "atproto-record-text"),
  ]

  children.push(paragraph([textNode(sourceParts.join(" · "))], "atproto-record-meta"))

  if (linkedNotes.length > 0) {
    children.push({
      type: "element",
      tagName: "h2",
      properties: {},
      children: [textNode("Linked notes")],
    })
    children.push({
      type: "element",
      tagName: "ul",
      properties: {},
      children: linkedNotes.map((note) => ({
        type: "element",
        tagName: "li",
        properties: {},
        children: [
          link(
            resolveRelative(slugForBacklink(backlink), note.slug!),
            note.frontmatter?.title ?? note.slug!,
            true,
          ),
        ],
      })),
    })
  }

  children.push(paragraph([link(backlink.href, "Open original")], "atproto-record-source"))

  return { type: "root", children }
}

function newestDateForNotes(linkedNotes: QuartzPluginData[]): QuartzPluginData["dates"] {
  const datedNotes = linkedNotes.filter((note) => note.dates)
  if (datedNotes.length === 0) {
    const now = new Date()
    return { created: now, modified: now, published: now }
  }

  return datedNotes
    .map((note) => note.dates!)
    .reduce((newest, dates) => ({
      created: dates.created > newest.created ? dates.created : newest.created,
      modified: dates.modified > newest.modified ? dates.modified : newest.modified,
      published: dates.published > newest.published ? dates.published : newest.published,
    }))
}

function buildGeneratedContent(
  backlink: AtprotoBacklink,
  linkedNotes: QuartzPluginData[],
): ProcessedContent {
  const slug = slugForBacklink(backlink)
  const linkedSlugs = linkedNotes.map((note) => simplifySlug(note.slug! as FullSlug))
  const description = backlinkDescription(backlink)
  const title = backlinkTitle(backlink)
  const contentText = leafletPlaintext(backlink) ?? description
  const filePath = `${slug}.md` as FilePath
  const data: QuartzPluginData = {
    slug,
    filePath,
    relativePath: filePath,
    frontmatter: {
      title,
      tags: [],
    },
    dates: newestDateForNotes(linkedNotes),
    description,
    text: [title, contentText].join("\n\n"),
    links: linkedSlugs as SimpleSlug[],
    atUri: backlink.uri,
    atprotoUri: backlink.uri,
    atprotoBacklinks: [],
    atprotoBreadcrumbs: generatedBreadcrumbs(title, linkedNotes),
    atprotoGeneratedRecord: {
      collection: backlink.collection,
      did: backlink.did,
      rkey: backlink.rkey,
      uri: backlink.uri,
      href: backlink.href,
      sourceKind: backlink.targetKind,
    },
  }

  return [buildRecordTree(backlink, linkedNotes), { data } as ProcessedContent[1]]
}

export async function prepareAtprotoBacklinkContent(
  ctx: BuildCtx,
  content: ProcessedContent[],
): Promise<ProcessedContent[]> {
  await Promise.all(content.map(([, file]) => hydrateAtprotoBacklinks(ctx, file.data)))

  const localFiles = content.map(([, file]) => file.data)
  const localRecordKeys = new Set<string>()
  for (const file of localFiles) {
    const atUri = getAtUri(file)
    if (!atUri) continue

    const record = parseAtUri(atUri)
    if (record) {
      localRecordKeys.add(`${record.did}/${record.collection}/${record.rkey}`)
    }
  }

  const generatedByKey = new Map<
    string,
    { backlink: AtprotoBacklink; linkedNotes: Map<FullSlug, QuartzPluginData> }
  >()

  for (const [, file] of content) {
    const noteSlug = file.data.slug
    if (!noteSlug) continue

    for (const backlink of (file.data.atprotoBacklinks ?? []) as AtprotoBacklink[]) {
      if (!GENERATED_COLLECTIONS.has(backlink.collection)) continue

      const key = `${backlink.did}/${backlink.collection}/${backlink.rkey}`
      if (localRecordKeys.has(key)) continue

      const internalSlug = slugForBacklink(backlink)
      backlink.internalSlug = internalSlug

      const generated = generatedByKey.get(key)
      if (generated) {
        generated.linkedNotes.set(noteSlug, file.data)
      } else {
        generatedByKey.set(key, {
          backlink,
          linkedNotes: new Map([[noteSlug, file.data]]),
        })
      }
    }
  }

  const generatedContent = [...generatedByKey.values()].map(({ backlink, linkedNotes }) =>
    buildGeneratedContent(
      backlink,
      [...linkedNotes.values()].sort((a, b) =>
        (a.frontmatter?.title ?? a.slug ?? "").localeCompare(b.frontmatter?.title ?? b.slug ?? ""),
      ),
    ),
  )

  if (generatedContent.length === 0) return content

  const generatedSlugs = new Set(generatedContent.map(([, file]) => file.data.slug))
  const sourceContent = content.filter(([, file]) => !generatedSlugs.has(file.data.slug))
  const prepared = [...sourceContent, ...generatedContent]

  // Preserve generated pages in shared build context for consumers that inspect all files.
  ctx.allFiles = [
    ...ctx.allFiles.filter((file) => !file.startsWith("atproto/")),
    ...generatedContent.map(([, file]) => file.data.relativePath!),
  ]
  ctx.allSlugs = [
    ...ctx.allSlugs.filter((slug) => !slug.startsWith("atproto/")),
    ...generatedContent.map(([, file]) => file.data.slug!),
  ]

  localFiles.forEach((file) => {
    file.atprotoBacklinks = file.atprotoBacklinks ?? []
  })

  return prepared
}

declare module "vfile" {
  interface DataMap {
    atprotoBacklinks: AtprotoBacklink[]
    atUri?: string
    atprotoUri?: string
    atprotoBreadcrumbs?: AtprotoBreadcrumb[]
    atprotoGeneratedRecord?: AtprotoGeneratedRecord
  }
}
