import type { QuartzConfig } from "@quartz/cfg";
import type { Theme } from "@quartz/util/theme";
import * as Plugin from "@quartz/plugins";

const theme: Theme = {
  typography: {
    title: {
      name: "Newsreader",
      weights: [500, 600, 700],
      includeItalic: false,
    },
    header: {
      name: "Newsreader",
      weights: [500, 600, 700],
      includeItalic: false,
    },
    body: {
      name: "Inter",
      weights: [400, 500, 600],
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
      light: "#f7f8fb",
      lightgray: "#e6e9f0",
      gray: "#9aa3b2",
      darkgray: "#3f495c",
      dark: "#1b2230",
      secondary: "#2d5b88",
      tertiary: "#3f7d7a",
      highlight: "rgba(45, 91, 136, 0.12)",
      textHighlight: "#ffe58f88",
    },
    darkMode: {
      light: "#121722",
      lightgray: "#252d3b",
      gray: "#8893a8",
      darkgray: "#c3cad8",
      dark: "#edf1fa",
      secondary: "#7cb0e0",
      tertiary: "#73b8b3",
      highlight: "rgba(124, 176, 224, 0.16)",
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
