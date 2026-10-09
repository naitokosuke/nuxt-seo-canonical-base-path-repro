// Minimal reproduction of canonical/og:url duplicating app.baseURL after hydration.
//
// The three ingredients are:
//   1. app.baseURL is a sub path (not "/")
//   2. site.url is an origin, as nuxt-site-config requires (no path)
//   3. @nuxtjs/i18n is installed, with no i18n.baseUrl set
export default defineNuxtConfig({
  modules: ["@nuxtjs/i18n", "@nuxtjs/seo"],

  compatibilityDate: "2024-11-01",

  app: {
    // Only applied for production builds, which is where the bug shows.
    baseURL: process.env.NODE_ENV === "production" ? "/sub/" : "/",
  },

  site: {
    url: "https://example.com",
    name: "Repro",
  },

  i18n: {
    locales: [
      { code: "en", language: "en-US" },
      { code: "ja", language: "ja-JP" },
    ],
    defaultLocale: "en",
    // Set this to "https://example.com" to see the second variant described in
    // the README: the host is then correct but the base path is still doubled.
    // baseUrl: "https://example.com",
  },

  // Keep the reproduction focused on canonical/og:url.
  robots: { enabled: false },
  sitemap: { enabled: false },
  ogImage: { enabled: false },
  schemaOrg: { enabled: false },
  linkChecker: { enabled: false },
});
