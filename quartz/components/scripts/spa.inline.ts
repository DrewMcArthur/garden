import micromorph from "micromorph"
import { FullSlug, RelativeURL, getFullSlug, normalizeRelativeURLs } from "../../util/path"
import { fetchCanonical } from "./util"

// adapted from `micromorph`
// https://github.com/natemoo-re/micromorph
const NODE_TYPE_ELEMENT = 1
let announcer = document.createElement("route-announcer")
const isElement = (target: EventTarget | null): target is Element =>
  (target as Node)?.nodeType === NODE_TYPE_ELEMENT
const isLocalUrl = (href: string) => {
  try {
    const url = new URL(href)
    if (window.location.origin === url.origin) {
      return true
    }
  } catch (e) {}
  return false
}

const isSamePage = (url: URL): boolean => {
  const sameOrigin = url.origin === window.location.origin
  const samePath = url.pathname === window.location.pathname
  return sameOrigin && samePath
}

const paneStackParam = "stack"
const paneViewportQuery = "(min-width: 1200px)"

const shouldUsePanes = () => window.matchMedia(paneViewportQuery).matches

const slugFromUrl = (url: URL): FullSlug => {
  let slug = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "")
  slug = slug.replace(/\.html$/, "")
  return (slug.length === 0 ? "index" : slug) as FullSlug
}

const urlFromSlug = (slug: FullSlug): URL => {
  return new URL(slug === "index" ? "/" : `/${slug}`, window.location.origin)
}

const getUrlBaseSlug = (url: URL = new URL(window.location.toString())): FullSlug => {
  return slugFromUrl(url)
}

const getPaneStack = (url: URL = new URL(window.location.toString())): FullSlug[] => {
  const raw = url.searchParams.get(paneStackParam)
  if (!raw) return []
  return raw
    .split("|")
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0) as FullSlug[]
}

const getOpenPath = (baseSlug = getUrlBaseSlug()): FullSlug[] => {
  return [baseSlug, ...getPaneStack()]
}

function notifyPaneChange(path = getOpenPath()) {
  const event: CustomEventMap["panechange"] = new CustomEvent("panechange", {
    detail: { path },
  })
  document.dispatchEvent(event)
}

const getOpts = ({
  target,
}: Event):
  | { url: URL; scroll?: boolean; paneIndex?: number; openInPane: boolean; inArticle: boolean }
  | undefined => {
  if (!isElement(target)) return
  if (target.attributes.getNamedItem("target")?.value === "_blank") return
  const a = target.closest("a")
  if (!a) return
  if ("routerIgnore" in a.dataset) return
  const { href } = a
  if (!isLocalUrl(href)) return
  const column = a.closest<HTMLElement>(".note-column")
  const paneIndex = column?.dataset.paneIndex ? Number(column.dataset.paneIndex) : undefined
  const inArticle = Boolean(column || a.closest("article") || a.closest(".page-footer"))
  return {
    url: new URL(href),
    scroll: "routerNoscroll" in a.dataset ? false : undefined,
    paneIndex,
    openInPane: shouldUsePanes() && inArticle,
    inArticle,
  }
}

function notifyNav(url: FullSlug) {
  const event: CustomEventMap["nav"] = new CustomEvent("nav", { detail: { url } })
  document.dispatchEvent(event)
}

const cleanupFns: Set<(...args: any[]) => void> = new Set()
window.addCleanup = (fn) => cleanupFns.add(fn)

function startLoading() {
  const loadingBar = document.createElement("div")
  loadingBar.className = "navigation-progress"
  loadingBar.style.width = "0"
  if (!document.body.contains(loadingBar)) {
    document.body.appendChild(loadingBar)
  }

  setTimeout(() => {
    loadingBar.style.width = "80%"
  }, 100)
}

let isNavigating = false
let p: DOMParser
async function _navigate(url: URL, isBack: boolean = false) {
  isNavigating = true
  startLoading()
  p = p || new DOMParser()
  const contents = await fetchCanonical(url)
    .then((res) => {
      const contentType = res.headers.get("content-type")
      if (contentType?.startsWith("text/html")) {
        return res.text()
      } else {
        window.location.assign(url)
      }
    })
    .catch(() => {
      window.location.assign(url)
    })

  if (!contents) return

  // notify about to nav
  const event: CustomEventMap["prenav"] = new CustomEvent("prenav", { detail: {} })
  document.dispatchEvent(event)

  // cleanup old
  cleanupFns.forEach((fn) => fn())
  cleanupFns.clear()

  const html = p.parseFromString(contents, "text/html")
  normalizeRelativeURLs(html, url)

  let title = html.querySelector("title")?.textContent
  if (title) {
    document.title = title
  } else {
    const h1 = document.querySelector("h1")
    title = h1?.innerText ?? h1?.textContent ?? url.pathname
  }
  if (announcer.textContent !== title) {
    announcer.textContent = title
  }
  announcer.dataset.persist = ""
  html.body.appendChild(announcer)

  // morph body
  await micromorph(document.body, html.body)

  // scroll into place and add history
  if (!isBack) {
    if (url.hash) {
      const el = document.getElementById(decodeURIComponent(url.hash.substring(1)))
      el?.scrollIntoView()
    } else {
      window.scrollTo({ top: 0 })
    }
  }

  // now, patch head, re-executing scripts
  const elementsToRemove = document.head.querySelectorAll(":not([data-persist])")
  elementsToRemove.forEach((el) => el.remove())
  const elementsToAdd = html.head.querySelectorAll(":not([data-persist])")
  elementsToAdd.forEach((el) => document.head.appendChild(el))

  // delay setting the url until now
  // at this point everything is loaded so changing the url should resolve to the correct addresses
  if (!isBack) {
    history.pushState({}, "", url)
  }

  notifyNav(getFullSlug(window))
  void renderNoteColumns()
  delete announcer.dataset.persist
}

async function navigate(url: URL, isBack: boolean = false) {
  if (isNavigating) return
  isNavigating = true
  try {
    await _navigate(url, isBack)
  } catch (e) {
    console.error(e)
    window.location.assign(url)
  } finally {
    isNavigating = false
  }
}

window.spaNavigate = navigate

type TrailingCrumb = {
  index: number
  opacity: number
  slug: FullSlug
}

function getSiteTitleLink() {
  const source = document.querySelector<HTMLAnchorElement>(".note-column-active .page-title a")
  const fallback = document.querySelector<HTMLAnchorElement>(".page-title a")
  const link = document.createElement("a")
  link.href = source?.getAttribute("href") ?? fallback?.getAttribute("href") ?? "/"
  link.textContent = source?.textContent ?? fallback?.textContent ?? window.location.hostname
  return link
}

async function renderNotePath(
  path = getOpenPath(),
  expanded = false,
  trailingCrumb?: TrailingCrumb,
) {
  document.getElementById("note-path")?.remove()
  const inPaneMode = shouldUsePanes() && document.body.classList.contains("pane-mode")
  const chrome = document.getElementById("note-track-chrome")
  if (!inPaneMode) {
    chrome?.replaceChildren()
  }

  document.querySelectorAll<HTMLElement>(".breadcrumb-container").forEach((breadcrumb) => {
    breadcrumb.hidden = inPaneMode || path.length > 1
  })

  if (path.length <= 1 && !inPaneMode) return

  const pageHeader = document.querySelector(".note-column-active .page-header")
  if (!pageHeader && !chrome) return

  const data = await fetchData
  const nav = document.createElement("nav")
  nav.id = "note-path"
  nav.setAttribute("aria-label", "Note path")
  if (expanded) {
    nav.dataset.expanded = "true"
  }

  const shouldCollapse = !shouldUsePanes() && path.length > 4 && !expanded
  const renderIndexes = shouldCollapse
    ? [0, path.length - 2, path.length - 1]
    : path.map((_, i) => i)

  function appendCrumb(index: number, needsSeparator: boolean, trailingOpacity?: number) {
    const fullPath = getOpenPath()
    const slug = index < path.length ? path[index] : fullPath[index]
    if (!slug) return

    if (needsSeparator) {
      const separator = document.createElement("span")
      separator.className = "note-path-separator"
      separator.setAttribute("aria-hidden", "true")
      separator.textContent = "/"
      if (trailingOpacity !== undefined) {
        separator.style.opacity = String(trailingOpacity)
      }
      nav.appendChild(separator)
    }

    const link = document.createElement("a")
    const trail = fullPath.slice(0, index + 1)
    const url = urlFromSlug(trail[0])
    const stack = trail.slice(1)
    if (stack.length > 0) {
      url.searchParams.set(paneStackParam, stack.join("|"))
    }
    link.href = url.pathname + url.search
    link.textContent = data[slug]?.title ?? (slug === "index" ? "Home" : slug)
    if (trailingOpacity !== undefined) {
      link.style.opacity = String(trailingOpacity)
    } else if (index === path.length - 1) {
      link.setAttribute("aria-current", "page")
    }
    nav.appendChild(link)
  }

  for (const [visibleIndex, pathIndex] of renderIndexes.entries()) {
    appendCrumb(pathIndex, visibleIndex > 0)

    if (shouldCollapse && visibleIndex === 0) {
      const separator = document.createElement("span")
      separator.className = "note-path-separator"
      separator.setAttribute("aria-hidden", "true")
      separator.textContent = "/"
      nav.appendChild(separator)

      const expand = document.createElement("button")
      expand.className = "note-path-expand"
      expand.type = "button"
      expand.setAttribute("aria-label", "Show full note path")
      expand.textContent = "..."
      expand.addEventListener("click", () => {
        void renderNotePath(path, true)
      })
      nav.appendChild(expand)
    }
  }

  if (trailingCrumb && !shouldCollapse) {
    appendCrumb(trailingCrumb.index, path.length > 0, trailingCrumb.opacity)
  }

  if (inPaneMode && chrome) {
    const siteTitle = document.createElement("h2")
    siteTitle.className = "page-title note-site-title"
    siteTitle.appendChild(getSiteTitleLink())
    chrome.replaceChildren(siteTitle, nav)
    return
  }

  pageHeader?.after(nav)
}

async function fetchPageCenter(
  slug: FullSlug,
): Promise<{ center: HTMLElement; title?: string } | undefined> {
  const url = urlFromSlug(slug)
  const contents = await fetchCanonical(url)
    .then((res) => {
      if (res.headers.get("content-type")?.startsWith("text/html")) {
        return res.text()
      }
    })
    .catch(() => undefined)

  if (!contents) return

  p = p || new DOMParser()
  const html = p.parseFromString(contents, "text/html")
  normalizeRelativeURLs(html, url)

  const nextCenter = html.querySelector(".center")
  if (!nextCenter) return

  return {
    center: nextCenter as HTMLElement,
    title: html.querySelector("title")?.textContent ?? undefined,
  }
}

async function renderActiveNote(slug: FullSlug) {
  const center = document.querySelector<HTMLElement>("#note-column-track > .note-column-active")
  if (!center) return

  const page = await fetchPageCenter(slug)
  if (!page) return

  await micromorph(center, page.center)
  prepareNoteColumn(center, slug, getPaneStack().length - 1, true)
  document.body.dataset.slug = slug

  if (page.title) {
    document.title = page.title
    if (announcer.textContent !== page.title) {
      announcer.textContent = page.title
    }
  }
}

let paneRenderId = 0
function prepareNoteColumn(
  column: HTMLElement,
  slug: FullSlug,
  paneIndex: number,
  isActive: boolean,
) {
  column.classList.add("center", "note-column")
  column.classList.toggle("note-column-active", isActive)
  column.classList.toggle("note-column-previous", !isActive)
  column.dataset.paneIndex = String(paneIndex)
  column.dataset.slug = slug
}

function scrollLatestNoteIntoView() {
  const track = document.getElementById("note-column-track")
  if (!track || !shouldUsePanes()) return
  requestAnimationFrame(() => {
    track.scrollLeft = 0
  })
}

function scrollPathIndexIntoView(pathIndex: number) {
  if (!shouldUsePanes()) return false

  const column = document.querySelector<HTMLElement>(
    `#note-column-track > .note-column[data-pane-index="${pathIndex - 1}"]`,
  )
  if (!column) return false

  column.scrollIntoView({ block: "nearest", inline: "end", behavior: "smooth" })
  requestAnimationFrame(() => {
    const { path, trailingCrumb } = getFocusedPathView()
    void renderNotePath(path, false, trailingCrumb)
  })
  return true
}

function getFocusedPathView(): { path: FullSlug[]; trailingCrumb?: TrailingCrumb } {
  const fullPath = getOpenPath()
  const track = document.getElementById("note-column-track")
  if (!track || !shouldUsePanes()) return { path: fullPath }

  const trackRect = track.getBoundingClientRect()
  const columns = [...track.querySelectorAll<HTMLElement>(":scope > .note-column")]
  let focusedIndex = fullPath.length - 1
  let closestRightEdge = Number.POSITIVE_INFINITY
  const visibleRatios = new Map<number, number>()

  for (const column of columns) {
    const pathIndex = Number(column.dataset.paneIndex) + 1
    const rect = column.getBoundingClientRect()
    const visibleWidth = Math.max(
      0,
      Math.min(rect.right, trackRect.right) - Math.max(rect.left, trackRect.left),
    )
    const visibleRatio = rect.width > 0 ? visibleWidth / rect.width : 0
    visibleRatios.set(pathIndex, visibleRatio)

    if (visibleWidth <= 1) continue

    const rightEdgeDistance = Math.abs(rect.right - trackRect.right)
    if (rightEdgeDistance < closestRightEdge) {
      closestRightEdge = rightEdgeDistance
      focusedIndex = pathIndex
    }
  }

  const trailingIndex = focusedIndex + 1
  const trailingOpacity = visibleRatios.get(trailingIndex) ?? 0
  const trailingCrumb =
    trailingIndex < fullPath.length && trailingOpacity > 0.02
      ? {
          index: trailingIndex,
          opacity: Math.min(1, Math.max(0, trailingOpacity)),
          slug: fullPath[trailingIndex],
        }
      : undefined

  return {
    path: fullPath.slice(0, focusedIndex + 1),
    trailingCrumb,
  }
}

let boundPathTrack: HTMLElement | undefined
let unbindPathTrack: (() => void) | undefined
function bindNotePathToTrackScroll(track: HTMLElement) {
  if (boundPathTrack === track) return

  unbindPathTrack?.()
  let frame = 0
  const updatePath = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const { path, trailingCrumb } = getFocusedPathView()
      void renderNotePath(path, false, trailingCrumb)
    })
  }

  track.addEventListener("scroll", updatePath, { passive: true })
  boundPathTrack = track
  unbindPathTrack = () => {
    track.removeEventListener("scroll", updatePath)
    if (frame) cancelAnimationFrame(frame)
    if (boundPathTrack === track) boundPathTrack = undefined
  }
}

async function renderNoteColumns(slugs = getPaneStack()) {
  const track = document.getElementById("note-column-track")
  const activeColumn = track?.querySelector<HTMLElement>(":scope > .note-column-active")
  if (!track || !activeColumn) return

  const renderId = ++paneRenderId
  track.querySelectorAll(":scope > .note-column-previous").forEach((column) => column.remove())

  if (!shouldUsePanes()) {
    unbindPathTrack?.()
    document.body.classList.remove("pane-mode")
    const path = getOpenPath()
    if (slugs.length > 0) {
      await renderActiveNote(slugs[slugs.length - 1])
    } else {
      prepareNoteColumn(activeColumn, getUrlBaseSlug(), -1, true)
    }

    void renderNotePath(path)
    notifyPaneChange(path)
    return
  }

  const baseSlug = getUrlBaseSlug()
  const activeSlug = slugs[slugs.length - 1] ?? baseSlug
  if (slugs.length > 0) {
    await renderActiveNote(activeSlug)
  } else if (getFullSlug(window) !== baseSlug) {
    await renderActiveNote(baseSlug)
  } else {
    prepareNoteColumn(activeColumn, activeSlug, slugs.length - 1, true)
  }

  const path = getOpenPath()
  const previousPath = slugs.length > 0 ? path.slice(0, -1) : []
  document.body.classList.add("pane-mode")

  const previousColumns = previousPath.map((slug, index) => ({ index, slug })).reverse()

  for (const { index, slug } of previousColumns) {
    const loadingColumn = document.createElement("div")
    prepareNoteColumn(loadingColumn, slug, index - 1, false)
    loadingColumn.setAttribute("aria-label", `Linked note ${index + 1}`)
    loadingColumn.innerHTML = `<div class="note-column-loading">Loading...</div>`
    track.appendChild(loadingColumn)

    const page = await fetchPageCenter(slug)
    if (renderId !== paneRenderId) return

    if (!page) {
      loadingColumn.innerHTML = `<p class="note-column-loading">Unable to load this note.</p>`
      continue
    }

    const centerClone = page.center.cloneNode(true) as HTMLElement
    prepareNoteColumn(centerClone, slug, index - 1, false)
    centerClone.querySelectorAll<HTMLElement>(".breadcrumb-container").forEach((breadcrumb) => {
      breadcrumb.hidden = true
    })
    loadingColumn.replaceWith(centerClone)
  }

  bindNotePathToTrackScroll(track)
  scrollLatestNoteIntoView()
  const { path: visiblePath, trailingCrumb } = getFocusedPathView()
  void renderNotePath(visiblePath, false, trailingCrumb)
  notifyPaneChange(path)
}

function setPaneStack(slugs: FullSlug[], replace = false) {
  const nextUrl = new URL(window.location.toString())
  if (slugs.length > 0) {
    nextUrl.searchParams.set(paneStackParam, slugs.join("|"))
  } else {
    nextUrl.searchParams.delete(paneStackParam)
  }

  if (nextUrl.toString() === window.location.toString()) return

  history[replace ? "replaceState" : "pushState"]({}, "", nextUrl)
  void renderNoteColumns(slugs)
}

function openPane(url: URL, paneIndex?: number) {
  const stack = getPaneStack()
  const slug = slugFromUrl(url)
  const openPath = getOpenPath()
  const existingIndex = openPath.lastIndexOf(slug)
  if (existingIndex !== -1) {
    if (scrollPathIndexIntoView(existingIndex)) return

    setPaneStack(openPath.slice(1, existingIndex + 1))
    return
  }

  const nextStack =
    paneIndex === undefined ? [...stack, slug] : [...stack.slice(0, paneIndex + 1), slug]
  setPaneStack(nextStack)
}

window.spaOpenPane = (url: URL) => openPane(url)

function createRouter() {
  if (typeof window !== "undefined") {
    window.addEventListener("click", async (event) => {
      const { url, paneIndex, openInPane, inArticle } = getOpts(event) ?? {}
      // dont hijack behaviour, just let browser act normally
      if (!url || event.ctrlKey || event.metaKey) return
      event.preventDefault()

      if (inArticle && !url.hash) {
        openPane(url, paneIndex)
        return
      }

      if (isSamePage(url) && url.hash) {
        const el = document.getElementById(decodeURIComponent(url.hash.substring(1)))
        el?.scrollIntoView()
        history.pushState({}, "", url)
        return
      }

      if (openInPane) {
        openPane(url, paneIndex)
        return
      }

      navigate(url, false)
    })

    window.addEventListener("popstate", (event) => {
      const { url } = getOpts(event) ?? {}
      if (window.location.hash && window.location.pathname === url?.pathname) return
      const nextUrl = new URL(window.location.toString())
      if (slugFromUrl(nextUrl) === getFullSlug(window)) {
        void renderNoteColumns(getPaneStack(nextUrl))
        return
      }
      navigate(nextUrl, true)
      return
    })
  }

  return new (class Router {
    go(pathname: RelativeURL) {
      const url = new URL(pathname, window.location.toString())
      return navigate(url, false)
    }

    back() {
      return window.history.back()
    }

    forward() {
      return window.history.forward()
    }
  })()
}

createRouter()
notifyNav(getFullSlug(window))
void renderNoteColumns()

const paneViewport = window.matchMedia(paneViewportQuery)
paneViewport.addEventListener("change", () => void renderNoteColumns())

if (!customElements.get("route-announcer")) {
  const attrs = {
    "aria-live": "assertive",
    "aria-atomic": "true",
    style:
      "position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px",
  }

  customElements.define(
    "route-announcer",
    class RouteAnnouncer extends HTMLElement {
      constructor() {
        super()
      }
      connectedCallback() {
        for (const [key, value] of Object.entries(attrs)) {
          this.setAttribute(key, value)
        }
      }
    },
  )
}
