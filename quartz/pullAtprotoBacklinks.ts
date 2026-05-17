import sourceMapSupport from "source-map-support"
sourceMapSupport.install(options)
import cfg from "../quartz.config"
import { filterContent } from "./processors/filter"
import { parseMarkdown } from "./processors/parse"
import {
  normalizeAtprotoBacklinksConfig,
  pullAtprotoBacklinksContext,
} from "./plugins/atprotoBacklinks"
import { Argv, BuildCtx } from "./util/ctx"
import { glob } from "./util/glob"
import { FilePath, joinSegments, slugifyFilePath } from "./util/path"
import { randomIdNonSecure } from "./util/random"
import { options } from "./util/sourcemap"

type PullBacklinksArgv = Pick<Argv, "directory" | "verbose" | "concurrency">

async function pullAtprotoBacklinks(argv: PullBacklinksArgv) {
  const buildArgv: Argv = {
    directory: argv.directory,
    output: "public",
    verbose: argv.verbose,
    serve: false,
    watch: false,
    port: 8080,
    wsPort: 3001,
    concurrency: argv.concurrency,
  }

  const allFiles = await glob("**/*.*", buildArgv.directory, cfg.configuration.ignorePatterns)
  const markdownPaths = allFiles.filter((fp) => fp.endsWith(".md")).sort()
  const filePaths = markdownPaths.map((fp) => joinSegments(buildArgv.directory, fp) as FilePath)
  const ctx: BuildCtx = {
    buildId: randomIdNonSecure(),
    argv: buildArgv,
    cfg,
    allFiles,
    allSlugs: allFiles.map((fp) => slugifyFilePath(fp)),
    incremental: false,
  }

  console.log(`[ATProto] parsing ${markdownPaths.length} markdown files`)
  const parsedFiles = await parseMarkdown(ctx, filePaths)
  const filteredContent = filterContent(ctx, parsedFiles)
  const context = await pullAtprotoBacklinksContext(ctx, filteredContent)
  const atprotoCfg = normalizeAtprotoBacklinksConfig(cfg.configuration.atprotoBacklinks)

  console.log(
    `[ATProto] wrote ${Object.keys(context.subjects).length} backlink subjects to ${atprotoCfg.contextFile}`,
  )
}

export default pullAtprotoBacklinks
