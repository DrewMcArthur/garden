function bindCopyAtUriButtons() {
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    "[data-copy-at-uri], [data-copy-note-url]",
  )
  buttons.forEach((button) => {
    if (button.dataset.bound === "true") return
    button.dataset.bound = "true"

    button.addEventListener("click", async () => {
      const copyValue = button.dataset.copyAtUri ?? button.dataset.copyNoteUrl
      if (!copyValue) return

      try {
        await navigator.clipboard.writeText(copyValue)
        const originalTitle = button.getAttribute("title") ?? "copy link"
        const originalAria = button.getAttribute("aria-label") ?? "copy link"
        button.setAttribute("title", "copied")
        button.setAttribute("aria-label", "copied")
        window.setTimeout(() => {
          button.setAttribute("title", originalTitle)
          button.setAttribute("aria-label", originalAria)
        }, 1400)
      } catch {
        // ignore clipboard failures and keep the button stable
      }
    })
  })
}

document.addEventListener("nav", bindCopyAtUriButtons)
bindCopyAtUriButtons()
