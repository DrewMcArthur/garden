import path from "path"
import { styleText } from "util"
import { Node } from "unist"
import { QuartzEmitterPlugin } from "../types"
import { QuartzComponentProps } from "../../components/types"
import HeaderConstructor from "../../components/Header"
import BodyConstructor from "../../components/Body"
import { pageResources, renderPage } from "../../components/renderPage"
import { FullPageLayout } from "../../cfg"
import { FullSlug, pathToRoot, simplifySlug } from "../../util/path"
import { defaultContentPageLayout, sharedPageComponents } from "../../../quartz.layout"
import { Content } from "../../components"
import { write } from "./helpers"
import { BuildCtx } from "../../util/ctx"
import { StaticResources } from "../../util/resources"
import { ProcessedContent, QuartzPluginData } from "../vfile"
import { getAtUri, normalizeAtprotoBacklinksConfig } from "../atprotoBacklinks"

function headerPathsForSlug(slug: FullSlug): string[] {
  const simpleSlug = simplifySlug(slug)
  const paths = new Set<string>()

  if (simpleSlug === "/") {
    paths.add("/")
  } else {
    paths.add(`/${simpleSlug}`)
    paths.add(`/${simpleSlug}/`)
  }
  paths.add(`/${slug}.html`)

  return [...paths]
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "")
}

async function writeAtprotoHeaders(ctx: BuildCtx, content: ProcessedContent[]) {
  const atprotoCfg = normalizeAtprotoBacklinksConfig(ctx.cfg.configuration.atprotoBacklinks)
  if (!atprotoCfg.emitHttpHeader) {
    return undefined
  }

  const blocks: string[] = []
  for (const [, file] of content) {
    const slug = file.data.slug!
    if (slug.endsWith("/index") || slug.startsWith("tags/")) continue

    const atUri = getAtUri(file.data)
    if (!atUri) continue

    for (const headerPath of headerPathsForSlug(slug)) {
      blocks.push(`${headerPath}\n  Atproto-Uri: ${sanitizeHeaderValue(atUri)}`)
    }
  }

  return write({
    ctx,
    slug: "_headers" as FullSlug,
    ext: "",
    content: blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "",
  })
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

function shouldSkipPage(slug: FullSlug): boolean {
  return slug.endsWith("/index") || slug.startsWith("tags/")
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
        if (slug === "index") {
          containsIndex = true
        }

        if (shouldSkipPage(slug)) continue
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

      const headersPath = await writeAtprotoHeaders(ctx, content)
      if (headersPath) {
        yield headersPath
      }
    },
    async *partialEmit(ctx, content, resources, changeEvents) {
      const allFiles = content.map((c) => c[1].data)

      const changedSlugs = new Set<string>()
      for (const changeEvent of changeEvents) {
        if (!changeEvent.file) continue
        if (changeEvent.type === "add" || changeEvent.type === "change") {
          changedSlugs.add(changeEvent.file.data.slug!)
        }
      }

      for (const [tree, file] of content) {
        const slug = file.data.slug!
        if (shouldSkipPage(slug)) continue
        if (!changedSlugs.has(slug) && !file.data.atprotoGeneratedRecord) continue

        yield processContent(ctx, tree, file.data, allFiles, opts, resources)
      }

      const headersPath = await writeAtprotoHeaders(ctx, content)
      if (headersPath) {
        yield headersPath
      }
    },
  }
}
