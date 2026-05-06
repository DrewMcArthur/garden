function bindCopyAtUriButtons() {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-copy-at-uri]")
  buttons.forEach((button) => {
    if (button.dataset.bound === "true") return
    button.dataset.bound = "true"

    button.addEventListener("click", async () => {
      const atUri = button.dataset.copyAtUri
      if (!atUri) return

      try {
        await navigator.clipboard.writeText(atUri)
        const originalTitle = button.getAttribute("title") ?? "copy at:// uri"
        const originalAria = button.getAttribute("aria-label") ?? "copy at:// uri"
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
