import { styleText } from "util"
import path from "path"
import { mkdir, readFile, writeFile } from "fs/promises"
import { AtprotoBacklinksConfiguration } from "../cfg"
import { BuildCtx } from "../util/ctx"
import { FilePath, FullSlug, SimpleSlug, resolveRelative, simplifySlug } from "../util/path"
import { Root, Element, ElementContent } from "hast"
import { ProcessedContent, QuartzPluginData } from "./vfile"
import { visit } from "unist-util-visit"

const CONSTELLATION_BASE = "https://constellation.microcosm.blue"
const HANDLE_RESOLVER_BASE = "https://public.api.bsky.app"
const APPVIEW_BASE = "https://public.api.bsky.app"
const PLC_DIRECTORY_BASE = "https://plc.directory"
const DEFAULT_REPO_COLLECTION = "site.standard.document"
const DEFAULT_SOURCE_COLLECTIONS = [
  "site.standard.document",
  "app.bsky.feed.post",
  "pub.leaflet.comment",
] as const
const DEFAULT_BACKLINK_LIMIT = 12
const GENERATED_COLLECTIONS = new Set([
  "site.standard.document",
  "app.bsky.feed.post",
  "pub.leaflet.comment",
])
const ALLOWED_DIDS_FILE = "atproto.allowedDids.json"
const DISCOVERED_DIDS_REPORT_FILE = path.join(".quartz-cache", "atproto-discovered-dids.json")

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
  sourceUrl?: string
  sourceKind: BacklinkTargetKind
}

type AtprotoBreadcrumb = {
  displayName: string
  slug?: FullSlug
}

type AtprotoLinkTarget = {
  slug: FullSlug
  title: string
  kind: "note" | "record"
  dates?: QuartzPluginData["dates"]
}

type AtprotoRenderOptions = {
  internalHosts: Set<string>
}

type DiscoveredDidReason = "did-not-allowed" | "unsupported-collection"

type DiscoveredDidRecord = {
  uri: string
  collection: string
  rkey: string
  title?: string
  sourcePage?: FullSlug
  sourceUrl?: string
  reason: DiscoveredDidReason
}

type DiscoveredDidsReport = {
  generatedAt: string
  allowlistPath: string
  dids: Record<
    string,
    {
      allowed: boolean
      records: DiscoveredDidRecord[]
    }
  >
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
  commentText?: string
  commentCreatedAt?: string
  commentSubject?: string
  commentParent?: string
  commentRecord?: Record<string, unknown>
  documentRecord?: Record<string, unknown>
  sourceUrl?: string
}

const repoDidCache = new Map<string, string>()
const subjectBacklinksCache = new Map<string, Promise<AtprotoBacklink[]>>()
const didPdsCache = new Map<string, Promise<string | null>>()
const didHandleCache = new Map<string, Promise<string | null>>()
const recordCache = new Map<string, Promise<Record<string, unknown> | null>>()
const externalUrlAtUriCache = new Map<string, Promise<string | null>>()

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

function recordKey(record: ConstellationRecord): string {
  return `${record.did}/${record.collection}/${record.rkey}`
}

function allowlistPath(): string {
  return path.resolve(process.cwd(), ALLOWED_DIDS_FILE)
}

function discoveredDidsReportPath(): string {
  return path.resolve(process.cwd(), DISCOVERED_DIDS_REPORT_FILE)
}

async function readAllowedDids(): Promise<Record<string, boolean>> {
  try {
    const raw = await readFile(allowlistPath(), "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => {
        const [did, allowed] = entry
        return did.startsWith("did:") && typeof allowed === "boolean"
      }),
    )
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      console.warn(styleText("yellow", `[ATProto] failed to read ${ALLOWED_DIDS_FILE}`))
      console.warn(err)
    }

    return {}
  }
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

function normalizeExternalUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function extractAtUriFromHtml(html: string): string | null {
  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)
  const head = headMatch?.[1] ?? html.slice(0, 20000)
  const linkRegex = /<link\b[^>]*>/gi

  for (const [linkTag] of head.matchAll(linkRegex)) {
    const rel = linkTag.match(/\brel=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const href = linkTag.match(/\bhref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const relValue = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? "").toLowerCase()
    const hrefValue = href?.[1] ?? href?.[2] ?? href?.[3]
    if (!hrefValue?.startsWith("at://")) continue

    const relTokens = relValue.split(/\s+/)
    if (relTokens.includes("site.standard.document") || relTokens.includes("alternate")) {
      return hrefValue
    }
  }

  return null
}

async function resolveAtUriForExternalUrl(rawUrl: string): Promise<string | null> {
  const normalizedUrl = normalizeExternalUrl(rawUrl)
  if (!normalizedUrl) return null

  const cached = externalUrlAtUriCache.get(normalizedUrl)
  if (cached) return cached

  const pending = (async () => {
    try {
      const response = await fetch(normalizedUrl, { headers: { Accept: "text/html" } })
      if (!response.ok) return null
      const html = await response.text()
      return extractAtUriFromHtml(html)
    } catch {
      return null
    }
  })()

  externalUrlAtUriCache.set(normalizedUrl, pending)
  return pending
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

async function resolveHandleForDid(did: string): Promise<string | null> {
  const cached = didHandleCache.get(did)
  if (cached) return cached

  const pending = (async () => {
    try {
      const response = await fetch(`${PLC_DIRECTORY_BASE}/${did}`, {
        headers: { Accept: "application/json" },
      })
      if (!response.ok) return null
      const payload = (await response.json()) as { alsoKnownAs?: string[] }
      const atIdentifier = payload.alsoKnownAs?.find((identifier) => identifier.startsWith("at://"))
      return atIdentifier ? atIdentifier.slice("at://".length) : null
    } catch {
      return null
    }
  })()

  didHandleCache.set(did, pending)
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

async function enrichLeafletCommentBacklink(backlink: AtprotoBacklink): Promise<AtprotoBacklink> {
  const value = await fetchRepoRecord(backlink.did, backlink.collection, backlink.rkey)
  if (!value) return backlink

  const enriched: AtprotoBacklink = { ...backlink, commentRecord: value }
  const handle = await resolveHandleForDid(backlink.did)
  if (handle) {
    enriched.actorHandle = handle
  }

  if (typeof value.plaintext === "string" && value.plaintext.trim().length > 0) {
    enriched.commentText = truncateText(value.plaintext, 280)
  }
  if (typeof value.createdAt === "string") {
    enriched.commentCreatedAt = value.createdAt
  }
  if (typeof value.subject === "string") {
    enriched.commentSubject = value.subject
  }

  const reply = value.reply as Record<string, unknown> | undefined
  if (typeof reply?.parent === "string") {
    enriched.commentParent = reply.parent
  }

  return enriched
}

async function enrichAtprotoBacklinks(backlinks: AtprotoBacklink[]): Promise<AtprotoBacklink[]> {
  const publicationBacklinks = backlinks.filter(
    (backlink) => backlink.collection === "site.standard.document",
  )
  const blueskyBacklinks = backlinks.filter(
    (backlink) => backlink.collection === "app.bsky.feed.post",
  )
  const leafletCommentBacklinks = backlinks.filter(
    (backlink) => backlink.collection === "pub.leaflet.comment",
  )
  const otherBacklinks = backlinks.filter(
    (backlink) =>
      backlink.collection !== "site.standard.document" &&
      backlink.collection !== "app.bsky.feed.post" &&
      backlink.collection !== "pub.leaflet.comment",
  )

  const enrichedPublications = await Promise.all(
    publicationBacklinks.map((backlink) => enrichPublicationBacklink(backlink)),
  )
  const enrichedBluesky = await enrichBlueskyBacklinks(blueskyBacklinks)
  const enrichedLeafletComments = await Promise.all(
    leafletCommentBacklinks.map((backlink) => enrichLeafletCommentBacklink(backlink)),
  )

  return [
    ...enrichedPublications,
    ...enrichedBluesky,
    ...enrichedLeafletComments,
    ...otherBacklinks,
  ]
}

async function enrichAtprotoRecordFromUri(
  atUri: string,
  sourceUrl: string,
): Promise<AtprotoBacklink | null> {
  const record = parseAtUri(atUri)
  if (!record) return null

  const [enriched] = await enrichAtprotoBacklinks([
    {
      ...record,
      source: "external-url",
      sourceCollection: record.collection,
      sourcePath: "",
      uri: atUri,
      href: sourceUrl,
      target: sourceUrl,
      targetKind: "url",
      sourceUrl,
    },
  ])

  return enriched ?? null
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

  if (backlink.collection === "pub.leaflet.comment") {
    return `${backlink.actorHandle ?? backlink.did} on Leaflet`
  }

  if (backlink.collection === "site.standard.document") {
    return backlink.documentTitle ?? backlink.publicationName ?? "Untitled document"
  }

  return `${backlink.collection} by ${backlink.did}`
}

function backlinkDescription(backlink: AtprotoBacklink): string {
  return (
    backlink.postText ??
    backlink.commentText ??
    backlink.documentDescription ??
    backlink.postExternalTitle ??
    backlink.postExternalDescription ??
    backlink.publicationName ??
    backlink.uri
  )
}

function isAllowedGeneratedRecord(
  record: ConstellationRecord,
  allowedDids: Record<string, boolean>,
) {
  return GENERATED_COLLECTIONS.has(record.collection) && allowedDids[record.did] === true
}

function createDiscoveredDidsReport(allowedDids: Record<string, boolean>): DiscoveredDidsReport {
  return {
    generatedAt: new Date().toISOString(),
    allowlistPath: ALLOWED_DIDS_FILE,
    dids: Object.fromEntries(
      Object.entries(allowedDids)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([did, allowed]) => [did, { allowed, records: [] }]),
    ),
  }
}

function addDiscoveredDidRecord(
  report: DiscoveredDidsReport,
  record: ConstellationRecord,
  allowedDids: Record<string, boolean>,
  reason: DiscoveredDidReason,
  sourcePage?: FullSlug,
  sourceUrl?: string,
  title?: string,
) {
  const entry = (report.dids[record.did] ??= {
    allowed: allowedDids[record.did] === true,
    records: [],
  })
  const uri = makeAtUri(record.did, record.collection, record.rkey)
  if (
    entry.records.some(
      (existing) =>
        existing.uri === uri &&
        existing.reason === reason &&
        existing.sourcePage === sourcePage &&
        existing.sourceUrl === sourceUrl,
    )
  ) {
    return
  }

  entry.records.push({
    uri,
    collection: record.collection,
    rkey: record.rkey,
    title,
    sourcePage,
    sourceUrl,
    reason,
  })
}

async function writeDiscoveredDidsReport(report: DiscoveredDidsReport) {
  for (const entry of Object.values(report.dids)) {
    entry.records.sort((a, b) => a.uri.localeCompare(b.uri))
  }

  const sortedReport: DiscoveredDidsReport = {
    ...report,
    dids: Object.fromEntries(
      Object.entries(report.dids)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([did, entry]) => [
          did,
          {
            allowed: entry.allowed,
            records: entry.records,
          },
        ]),
    ),
  }

  const reportPath = discoveredDidsReportPath()
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(sortedReport, null, 2)}\n`)
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

function hostFromConfigValue(value?: string): string | undefined {
  if (!value || value.includes(" ")) return undefined

  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname
  } catch {
    return undefined
  }
}

function renderOptionsForCtx(ctx: BuildCtx): AtprotoRenderOptions {
  const hosts = new Set<string>()
  const baseUrlHost = hostFromConfigValue(ctx.cfg.configuration.baseUrl)
  if (baseUrlHost) hosts.add(baseUrlHost)
  return { internalHosts: hosts }
}

function internalHrefForSiteUrl(rawHref: string, options: AtprotoRenderOptions) {
  try {
    const url = new URL(rawHref)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (!options.internalHosts.has(url.hostname)) return undefined

    const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "")
    return `${pathname}${url.search}${url.hash}`
  } catch {
    return undefined
  }
}

function linkPropertiesForHref(href: string, options: AtprotoRenderOptions) {
  const internalHref = internalHrefForSiteUrl(href, options)
  if (internalHref) {
    const slugPath = decodeURIComponent(internalHref.split(/[?#]/, 1)[0]).replace(/^\/+/, "")
    return {
      href: internalHref,
      className: ["internal"],
      "data-slug": simplifySlug((slugPath || "index") as FullSlug),
    }
  }

  return { href, target: "_blank", rel: ["noopener", "noreferrer"] }
}

function renderLeafletText(
  plaintext: string,
  facets: unknown,
  options: AtprotoRenderOptions,
): ElementContent[] {
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

    const features = facet.features as Array<Record<string, unknown>>
    const href = leafletFacetHref(features)
    let beforeText = plaintext.slice(cursor, start)
    let segment = plaintext.slice(start, end)
    let nextCursor = end
    if (href) {
      const markdownLinkMatch = beforeText.match(/\[([^\]\n]+)\]\($/)
      if (markdownLinkMatch && plaintext[end] === ")") {
        beforeText = beforeText.slice(0, -markdownLinkMatch[0].length)
        segment = markdownLinkMatch[1]
        nextCursor = end + 1
      }
    }

    if (beforeText.length > 0) {
      children.push(textNode(beforeText))
    }

    let segmentNode: ElementContent = textNode(segment)
    if (leafletFacetHasCode(features)) {
      segmentNode = element("code", {}, [segmentNode])
    }

    if (href) {
      segmentNode = element("a", linkPropertiesForHref(href, options), [segmentNode])
    }

    children.push(segmentNode)
    cursor = nextCursor
  }

  if (cursor < plaintext.length) {
    children.push(textNode(plaintext.slice(cursor)))
  }

  return children
}

function leafletPlaintext(backlink: AtprotoBacklink): string | undefined {
  if (backlink.collection === "pub.leaflet.comment" && backlink.commentText) {
    return backlink.commentText
  }

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

function renderLeafletCommentContent(
  backlink: AtprotoBacklink,
  options: AtprotoRenderOptions,
): ElementContent[] | undefined {
  if (backlink.collection !== "pub.leaflet.comment") return undefined
  const plaintext = backlink.commentRecord?.plaintext
  if (typeof plaintext !== "string" || plaintext.trim().length === 0) return undefined

  return [paragraph(renderLeafletText(plaintext, backlink.commentRecord?.facets, options))]
}

function renderLeafletContent(
  backlink: AtprotoBacklink,
  options: AtprotoRenderOptions,
): ElementContent[] | undefined {
  const commentContent = renderLeafletCommentContent(backlink, options)
  if (commentContent) return commentContent

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
        children.push(paragraph(renderLeafletText(plaintext, block.facets, options)))
      }
    }
  }

  return children.length > 0 ? children : undefined
}

function generatedBreadcrumbs(
  title: string,
  contextPages: AtprotoLinkTarget[],
): AtprotoBreadcrumb[] {
  const root: AtprotoBreadcrumb = { displayName: "Home", slug: "index" as FullSlug }
  if (contextPages.length === 1) {
    const page = contextPages[0]
    return [
      root,
      {
        displayName: page.title,
        slug: page.slug,
      },
      { displayName: title },
    ]
  }

  return [root, { displayName: title }]
}

function linkTargetFromFile(fileData: QuartzPluginData): AtprotoLinkTarget {
  return {
    slug: fileData.slug!,
    title: fileData.frontmatter?.title ?? fileData.slug!,
    kind: "note",
    dates: fileData.dates,
  }
}

function linkTargetFromBacklink(backlink: AtprotoBacklink): AtprotoLinkTarget {
  return {
    slug: slugForBacklink(backlink),
    title: backlinkTitle(backlink),
    kind: "record",
  }
}

function buildRecordTree(
  backlink: AtprotoBacklink,
  linkedPages: AtprotoLinkTarget[],
  options: AtprotoRenderOptions,
): Root {
  const description = backlinkDescription(backlink)
  const sourceLabel = backlink.targetKind === "url" ? "Linked via URL" : "Linked via at:// URI"
  const sourceParts = [
    backlink.collection,
    backlink.publicationName ?? backlink.actorDisplayName ?? backlink.actorHandle ?? backlink.did,
    sourceLabel,
  ].filter(Boolean)
  const renderedContent = renderLeafletContent(backlink, options)
  const children: ElementContent[] = renderedContent ?? [
    paragraph([textNode(description)], "atproto-record-text"),
  ]

  children.push(paragraph([textNode(sourceParts.join(" · "))], "atproto-record-meta"))

  if (linkedPages.length > 0) {
    const linkedPageHeading = linkedPages.every((page) => page.kind === "note")
      ? "Linked notes"
      : "Linked pages"
    children.push({
      type: "element",
      tagName: "h2",
      properties: {},
      children: [textNode(linkedPageHeading)],
    })
    children.push({
      type: "element",
      tagName: "ul",
      properties: {},
      children: linkedPages.map((page) => ({
        type: "element",
        tagName: "li",
        properties: {},
        children: [link(resolveRelative(slugForBacklink(backlink), page.slug), page.title, true)],
      })),
    })
  }

  children.push(
    paragraph(
      [link(backlink.sourceUrl ?? backlink.href, "Open original")],
      "atproto-record-source",
    ),
  )

  return { type: "root", children }
}

function newestDateForTargets(linkedPages: AtprotoLinkTarget[]): QuartzPluginData["dates"] {
  const datedPages = linkedPages.filter((page) => page.dates)
  if (datedPages.length === 0) {
    const now = new Date()
    return { created: now, modified: now, published: now }
  }

  return datedPages
    .map((page) => page.dates!)
    .reduce((newest, dates) => ({
      created: dates.created > newest.created ? dates.created : newest.created,
      modified: dates.modified > newest.modified ? dates.modified : newest.modified,
      published: dates.published > newest.published ? dates.published : newest.published,
    }))
}

function dateForGeneratedRecord(
  backlink: AtprotoBacklink,
  linkedPages: AtprotoLinkTarget[],
): QuartzPluginData["dates"] {
  if (backlink.commentCreatedAt) {
    const commentDate = new Date(backlink.commentCreatedAt)
    if (!Number.isNaN(commentDate.valueOf())) {
      return { created: commentDate, modified: commentDate, published: commentDate }
    }
  }

  return newestDateForTargets(linkedPages)
}

function buildGeneratedContent(
  backlink: AtprotoBacklink,
  linkedPages: AtprotoLinkTarget[],
  contextPages: AtprotoLinkTarget[],
  options: AtprotoRenderOptions,
): ProcessedContent {
  const slug = slugForBacklink(backlink)
  const linkedSlugs = linkedPages.map((page) => simplifySlug(page.slug))
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
    dates: dateForGeneratedRecord(backlink, linkedPages),
    description,
    text: [title, contentText].join("\n\n"),
    links: linkedSlugs as SimpleSlug[],
    atUri: backlink.uri,
    atprotoUri: backlink.uri,
    atprotoBacklinks: [],
    atprotoBreadcrumbs: generatedBreadcrumbs(title, contextPages),
    atprotoGeneratedRecord: {
      collection: backlink.collection,
      did: backlink.did,
      rkey: backlink.rkey,
      uri: backlink.uri,
      href: backlink.href,
      sourceUrl: backlink.sourceUrl,
      sourceKind: backlink.targetKind,
    },
  }

  return [buildRecordTree(backlink, linkedPages, options), { data } as ProcessedContent[1]]
}

export async function prepareAtprotoBacklinkContent(
  ctx: BuildCtx,
  content: ProcessedContent[],
): Promise<ProcessedContent[]> {
  const atprotoCfg = normalizeAtprotoBacklinksConfig(ctx.cfg.configuration.atprotoBacklinks)
  const renderOptions = renderOptionsForCtx(ctx)
  await Promise.all(content.map(([, file]) => hydrateAtprotoBacklinks(ctx, file.data)))
  const allowedDids = await readAllowedDids()
  const discoveredDidsReport = createDiscoveredDidsReport(allowedDids)

  const localFiles = content.map(([, file]) => file.data)
  const localRecords = new Map<string, QuartzPluginData>()
  for (const file of localFiles) {
    const atUri = getAtUri(file)
    if (!atUri) continue

    const record = parseAtUri(atUri)
    if (record) {
      localRecords.set(`${record.did}/${record.collection}/${record.rkey}`, file)
    }
  }

  const generationSkipReason = (record: ConstellationRecord): DiscoveredDidReason | undefined => {
    if (!GENERATED_COLLECTIONS.has(record.collection)) return "unsupported-collection"
    if (allowedDids[record.did] !== true) return "did-not-allowed"
    return undefined
  }

  const writeReport = async () => {
    try {
      await writeDiscoveredDidsReport(discoveredDidsReport)
    } catch (err) {
      console.warn(styleText("yellow", `[ATProto] failed to write discovered DID report`))
      console.warn(err)
    }
  }

  const generatedByKey = new Map<
    string,
    {
      backlink: AtprotoBacklink
      linkedPages: Map<FullSlug, AtprotoLinkTarget>
      sourcePages: Map<FullSlug, AtprotoLinkTarget>
    }
  >()
  const addGeneratedRecord = (
    backlink: AtprotoBacklink,
    direction: "record-to-page" | "page-to-record",
    linkedPage: AtprotoLinkTarget,
  ) => {
    const key = recordKey(backlink)
    if (localRecords.has(key)) return undefined
    if (!isAllowedGeneratedRecord(backlink, allowedDids)) return undefined

    const internalSlug = slugForBacklink(backlink)
    backlink.internalSlug = internalSlug

    let generated = generatedByKey.get(key)
    if (!generated) {
      generated = {
        backlink,
        linkedPages: new Map(),
        sourcePages: new Map(),
      }
      generatedByKey.set(key, generated)
    } else if (!generated.backlink.sourceUrl && backlink.sourceUrl) {
      generated.backlink.sourceUrl = backlink.sourceUrl
      generated.backlink.href = backlink.href
    }

    const targetMap = direction === "record-to-page" ? generated.linkedPages : generated.sourcePages
    targetMap.set(linkedPage.slug, linkedPage)
    return internalSlug
  }

  const rewriteLinkToSlug = (fileData: QuartzPluginData, node: Element, targetSlug: FullSlug) => {
    node.properties ??= {}
    node.properties.href = resolveRelative(fileData.slug!, targetSlug)
    node.properties["data-slug"] = targetSlug
    delete node.properties.target
    delete node.properties.rel

    const classes = new Set((node.properties.className ?? []) as string[])
    classes.delete("external")
    classes.add("internal")
    node.properties.className = [...classes]
    node.children = node.children.filter(
      (child) =>
        !(
          child.type === "element" &&
          (((child as Element).properties?.className as string[] | undefined)?.includes(
            "external-icon",
          ) ||
            (child as Element).properties?.class === "external-icon")
        ),
    )

    const links = new Set(fileData.links ?? [])
    links.add(simplifySlug(targetSlug))
    fileData.links = [...links]
  }

  for (const [, file] of content) {
    const noteSlug = file.data.slug
    if (!noteSlug) continue

    const renderableBacklinks: AtprotoBacklink[] = []
    for (const backlink of (file.data.atprotoBacklinks ?? []) as AtprotoBacklink[]) {
      const skipReason = generationSkipReason(backlink)
      if (skipReason) {
        addDiscoveredDidRecord(
          discoveredDidsReport,
          backlink,
          allowedDids,
          skipReason,
          noteSlug,
          backlink.sourceUrl,
          backlinkTitle(backlink),
        )
        continue
      }

      const key = recordKey(backlink)
      if (localRecords.has(key)) continue
      if (addGeneratedRecord(backlink, "record-to-page", linkTargetFromFile(file.data))) {
        renderableBacklinks.push(backlink)
      }
    }

    file.data.atprotoBacklinks = renderableBacklinks
  }

  await Promise.all(
    content.map(async ([tree, file]) => {
      const noteSlug = file.data.slug
      if (!noteSlug) return

      const pendingRewrites: Promise<void>[] = []
      visit(tree, "element", (node) => {
        if (node.tagName !== "a" || !node.properties || typeof node.properties.href !== "string") {
          return
        }

        const sourceUrl = normalizeExternalUrl(node.properties.href)
        if (!sourceUrl) return

        pendingRewrites.push(
          (async () => {
            const atUri = await resolveAtUriForExternalUrl(sourceUrl)
            if (!atUri) return

            const record = parseAtUri(atUri)
            if (!record) return

            const key = recordKey(record)
            const localRecord = localRecords.get(key)
            if (localRecord?.slug) {
              rewriteLinkToSlug(file.data, node, localRecord.slug)
              return
            }

            const skipReason = generationSkipReason(record)
            if (skipReason) {
              addDiscoveredDidRecord(
                discoveredDidsReport,
                record,
                allowedDids,
                skipReason,
                noteSlug,
                sourceUrl,
              )
              return
            }

            const backlink = await enrichAtprotoRecordFromUri(atUri, sourceUrl)
            if (!backlink) return

            const internalSlug = addGeneratedRecord(
              backlink,
              "page-to-record",
              linkTargetFromFile(file.data),
            )
            if (!internalSlug) return

            rewriteLinkToSlug(file.data, node, internalSlug)
          })(),
        )
      })

      await Promise.all(pendingRewrites)
    }),
  )

  if (atprotoCfg.sourceCollections.includes("pub.leaflet.comment")) {
    const generatedRecordsForCommentLookup = [...generatedByKey.values()].filter(
      ({ backlink }) => backlink.collection === "site.standard.document",
    )

    await Promise.all(
      generatedRecordsForCommentLookup.map(async ({ backlink: subjectBacklink }) => {
        const commentBacklinks = await fetchBacklinksForSubject(
          { value: subjectBacklink.uri, kind: "at-uri" },
          ["pub.leaflet.comment"],
          atprotoCfg.limit,
        )
        const enrichedComments = await enrichAtprotoBacklinks(commentBacklinks)
        const subjectPage = linkTargetFromBacklink(subjectBacklink)

        for (const comment of enrichedComments) {
          const skipReason = generationSkipReason(comment)
          if (skipReason) {
            addDiscoveredDidRecord(
              discoveredDidsReport,
              comment,
              allowedDids,
              skipReason,
              subjectPage.slug,
              comment.sourceUrl,
              backlinkTitle(comment),
            )
            continue
          }

          if (localRecords.has(recordKey(comment))) continue
          addGeneratedRecord(comment, "record-to-page", subjectPage)
        }
      }),
    )
  }

  const sortPages = (pages: Iterable<AtprotoLinkTarget>) =>
    [...pages].sort((a, b) => a.title.localeCompare(b.title))

  const generatedContent = [...generatedByKey.values()].map(
    ({ backlink, linkedPages, sourcePages }) => {
      const sortedLinkedPages = sortPages(linkedPages.values())
      const sortedSourcePages = sortPages(sourcePages.values())
      return buildGeneratedContent(
        backlink,
        sortedLinkedPages,
        sortedSourcePages.length > 0 ? sortedSourcePages : sortedLinkedPages,
        renderOptions,
      )
    },
  )

  await writeReport()

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
