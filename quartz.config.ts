import type { QuartzConfig } from "@quartz/cfg";
import type { Theme } from "@quartz/util/theme";
import * as Plugin from "@quartz/plugins";

const theme: Theme = {
  typography: {
    title: "Lato",
    header: "Lato",
    body: {
      name: "Lato",
      weights: [300, 400, 500],
      includeItalic: true,
    },
    code: {
      name: "IBM Plex Mono",
      weights: [400, 500],
      includeItalic: false,
    },
  },
  cdnCaching: true,
  colors: {
    lightMode: {
      light: "#FAF0E6",
      lightgray: "#DBD3CA",
      gray: "#807A75",
      darkgray: "#4D4946",
      dark: "#292726",
      secondary: "#4D4946",
      tertiary: "#807A75",
      highlight: "rgba(219, 211, 202, 0.36)",
      textHighlight: "#fff23688",
    },
    darkMode: {
      light: "#292726",
      lightgray: "#4D4946",
      gray: "#807A75",
      darkgray: "#DBD3CA",
      dark: "#F0E6FA",
      secondary: "#DBD3CA",
      tertiary: "#807A75",
      highlight: "rgba(219, 211, 202, 0.32)",
      textHighlight: "#8a7a1288",
    },
  },
  fontOrigin: "googleFonts",
};

const config: QuartzConfig = {
  configuration: {
    pageTitle: "notes.drewmca.net",
    enableSPA: true,
    enablePopovers: false,
    analytics: null,
    ignorePatterns: [],
    locale: "en-US",
    defaultDateType: "modified",
    theme,
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        priority: ["frontmatter", "git", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: {
          light: "github-light",
          dark: "github-dark",
        },
        keepBackground: false,
      }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: "katex" }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({
        enableSiteMap: true,
        enableRSS: true,
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.Favicon(),
      Plugin.NotFoundPage(),
      Plugin.CustomOgImages(),
    ],
  },
};

export default config;
