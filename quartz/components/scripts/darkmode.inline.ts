const colorSchemeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
const getDeviceTheme = (): "light" | "dark" => (colorSchemeMediaQuery.matches ? "dark" : "light")
document.documentElement.setAttribute("saved-theme", getDeviceTheme())

const emitThemeChangeEvent = (theme: "light" | "dark") => {
  const event: CustomEventMap["themechange"] = new CustomEvent("themechange", {
    detail: { theme },
  })
  document.dispatchEvent(event)
}

document.addEventListener("nav", () => {
  const themeChange = () => {
    const newTheme = getDeviceTheme()
    document.documentElement.setAttribute("saved-theme", newTheme)
    emitThemeChangeEvent(newTheme)
  }

  colorSchemeMediaQuery.addEventListener("change", themeChange)
  window.addCleanup(() => colorSchemeMediaQuery.removeEventListener("change", themeChange))
})
