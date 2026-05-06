import "@quartz/plugins"
import "@quartz/plugins/transformers/description"
import "@quartz/plugins/transformers/frontmatter"
import "@quartz/plugins/transformers/lastmod"
import "@quartz/plugins/transformers/links"

declare module "micromorph" {
  export default function micromorph(fromNode: Node, toNode: Node): void | Promise<void>
}
