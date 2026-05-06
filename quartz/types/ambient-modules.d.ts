declare module "micromorph" {
  export default function micromorph(fromNode: Node, toNode: Node): void | Promise<void>
}
