import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    title: "databricks-agent-kit",
    description: "MCP server that gives coding agents governed SQL and Unity Catalog metadata access to Databricks.",
    base: "/databricks-agent-kit/",
    lang: "en-US",
    cleanUrls: true,
    srcExclude: ["research/**"],
    rewrites: { "adr/README.md": "adr/index.md" },

    themeConfig: {
      nav: [
        { text: "Quickstart", link: "/guide/quickstart" },
        { text: "Guide", link: "/guide/authentication" },
        { text: "Architecture", link: "/architecture" },
        { text: "Reference", link: "/guide/configuration" },
        { text: "Decisions", link: "/adr/" },
      ],

      sidebar: [
        {
          text: "Getting started",
          items: [
            { text: "Introduction", link: "/" },
            { text: "Quickstart", link: "/guide/quickstart" },
            { text: "Authentication", link: "/guide/authentication" },
            { text: "Connect your agent", link: "/guide/agents" },
          ],
        },
        {
          text: "Using the server",
          items: [
            { text: "Tools", link: "/guide/tools" },
            { text: "Read-only mode and SQL safety", link: "/guide/read-only" },
            { text: "Exporting results", link: "/guide/exports" },
            { text: "Operational logs", link: "/guide/logs" },
            { text: "Coexistence with Databricks skills", link: "/guide/skills" },
          ],
        },
        {
          text: "Architecture and security",
          items: [
            { text: "Architecture", link: "/architecture" },
            { text: "Security model", link: "/security" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Configuration", link: "/guide/configuration" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
            { text: "Design", link: "/design" },
            { text: "Decisions (ADRs)", link: "/adr/" },
          ],
        },
      ],

      socialLinks: [{ icon: "github", link: "https://github.com/alexmarco/databricks-agent-kit" }],
      search: { provider: "local" },
      outline: { level: [2, 3] },
      footer: { message: "Released under the MIT License.", copyright: "databricks-agent-kit" },
    },

    mermaid: {
      theme: "base",
      themeVariables: {
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: "15px",
        primaryColor: "#E8F1FF",
        primaryBorderColor: "#2F6FDB",
        primaryTextColor: "#1F2937",
        textColor: "#1F2937",
        secondaryColor: "#E6F7EE",
        tertiaryColor: "#FFF4E5",
        lineColor: "#4B5563",
        clusterBkg: "#FAFAFA",
        clusterBorder: "#D1D5DB",
        edgeLabelBackground: "#FFFFFF",
        actorBkg: "#E8F1FF",
        actorBorder: "#2F6FDB",
        actorTextColor: "#1F2937",
        noteBkgColor: "#FFF4E5",
        noteBorderColor: "#E07B00",
        noteTextColor: "#1F2937",
        activationBkgColor: "#E6F7EE",
        activationBorderColor: "#1E9E62",
      },
      flowchart: {
        curve: "basis",
        padding: 16,
        nodeSpacing: 50,
        rankSpacing: 60,
        htmlLabels: false,
        wrappingWidth: 360,
      },
      sequence: { mirrorActors: false, boxMargin: 10, messageMargin: 40 },
    },
    mermaidPlugin: { class: "mermaid-diagram" },
  }),
);
