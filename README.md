# Repro: canonical/og:url duplicate `app.baseURL` when `@nuxtjs/i18n` is installed

With `app.baseURL` set to a sub path and `@nuxtjs/i18n` installed, `@nuxtjs/seo`
emits `canonical` and `og:url` with the base path applied twice, and with no host
at all unless `i18n.baseUrl` is set.

```
expected  https://example.com/sub/page
actual    https:///sub/sub/page
```

The empty host is not ignored. Per WHATWG URL that normalizes to `https://sub/sub/page`,
host `sub`, so the live `og:url` points at an unrelated host.

## Versions

| package | version |
| --- | --- |
| `nuxt` | 4.6.0 |
| `@nuxtjs/seo` | 5.3.16 |
| `nuxt-seo-utils` | 8.6.1 |
| `nuxt-site-config` | 4.2.3 |
| `site-config-stack` | 4.2.3 |
| `@nuxtjs/i18n` | 10.6.0 |
| Node | 24.x |

These are the current latest of each at the time of writing. The SSR and payload
values below were measured on them. The hydrated-DOM values were measured on the
previous pin (`@nuxtjs/seo` 3.4.0, `nuxt-site-config` 3.2.21) and are pending a
re-read here; the client-side mechanism is unchanged, and `_priority.url` still
serializes as `0` on 4.2.3.

## The documented config: the SSR HTML is already wrong

`site.url` in `nuxt.config` is pushed at priority `-3`, and the i18n plugin pushes at
`-2`, so i18n outranks an explicitly configured `site.url` on the server. Nothing
else supplies a url, so the server renders the doubled one.

```sh
pnpm install
NODE_ENV=production NITRO_PRESET=node-server pnpm build
PORT=3200 pnpm preview
curl -s http://localhost:3200/sub/page | grep -oE '<link rel="canonical"[^>]*>'
```

```
<link rel="canonical" href="https:///sub/sub/page">
<meta property="og:url" content="https:///sub/sub/page">
payload site config: url "https:///sub/"  _priority.url -2
```

No hydration or JS-executing crawler is needed to see this one. This is the config
`nuxt-site-config`'s own `SKILL.md` prescribes: "Put the path in `app.baseURL`, and
keep `url` as the origin."

## With `NUXT_SITE_URL`: SSR correct, hydrated DOM wrong

`NUXT_SITE_URL` is pushed as `runtimeEnv` at `_priority: 0`, which outranks i18n on
the server. The server output becomes correct while the client still resolves the
wrong url.

```sh
NODE_ENV=production NITRO_PRESET=node-server NUXT_SITE_URL=https://example.com/ pnpm build
NUXT_SITE_URL=https://example.com/ PORT=3201 pnpm preview
```

SSR is now correct, but the serialized priority cannot survive hydration:

```
<link rel="canonical" href="https://example.com/sub/page">
inline site config: url "https://example.com/"  _priority.url 0
```

Hydrated DOM at `http://localhost:3201/sub/page`, measured in Chromium:

```
link[rel=canonical]      getAttribute("href")  https:///sub/sub/page
meta[property="og:url"]  content               https:///sub/sub/page
link[rel=canonical]      .href (resolved)      https://sub/sub/page
```

Console, on every load:

```
[Nuxt Site Config] Your I18n baseUrl `` doesn't match your site url example.com.
```

Read the live DOM, not just the HTML: here the HTML is correct, so `curl` and
crawlers that do not execute JS see nothing wrong.

## Root cause

### `@nuxtjs/i18n` resolves its `baseUrl` as origin plus base path

`@nuxtjs/i18n/dist/runtime/context.js` — `getBaseUrl()`:

```js
return joinURL(baseUrl(), nuxt.$config.app.baseURL);
```

`baseUrl` defaults to `""`, so under a base path this returns `joinURL("", "/sub/")`
=== `"/sub/"`: truthy, but with no host. Set `i18n.baseUrl` and it returns
`https://example.com/sub/` instead — a host plus the base path.

This is correct for i18n's own purpose. `baseUrl` is documented as the prefix for
hreflang alternate URLs, which do need the base path. The value is the same on the
server and the client.

### `nuxt-site-config` consumes that value as the site origin

`nuxt-site-config/dist/runtime/app/plugins/i18n.js` reads `toValue(i18n.baseUrl)` and
pushes it as site config `url` — at `_priority: -2` on the server but `-1` on the
client.

Both shapes it can push are rejected by `nuxt-site-config`'s own
`validateSiteConfigStack` (`site-config-stack/dist/index.mjs`):

```
"/sub/"                    => url "https:///sub/" from @nuxtjs/i18n is not absolute
"https://example.com/sub/" => url "https://example.com/sub/" from @nuxtjs/i18n should not contain a path
"https://example.com"      => []
```

The host-less form becomes `https:///sub/` in `normalizeSiteConfig`, where
`hasProtocol("/sub/")` is false and `withHttps()` prepends the scheme to a path.

### The priority that wins on the server does not survive hydration

`nuxt-site-config/dist/runtime/app/plugins/0.siteConfig.js`:

```js
stack.push({ [k]: store[k], _priority: store._priority?.[k] || -1 });
```

A legitimate priority of `0` — what `runtimeEnv` carries — is falsy and collapses to
`-1`, tying with the i18n client push at `-1`. The sort is stable and
`0.siteConfig.js` is `enforce: "pre"`, so the later i18n entry wins and the client
resolves a different site url than the server did. `docs/.../how-it-works.md`
promises the opposite: hydration from the SSR payload "ensures the client has the
same config as the server without any hydration mismatches."

### `resolveSitePath` applies the base twice

`site-config-stack/dist/urls.mjs`:

```js
let origin = withoutTrailingSlash(options.absolute ? options.siteUrl : "");
if (base !== "/" && origin.endsWith(base)) {
  origin = origin.slice(0, origin.indexOf(base));
}
const baseWithOrigin = options.withBase ? withBase(base, origin || "/") : origin;
```

`origin` has its trailing slash stripped while `base` keeps one, so the guard cannot
match for any base derived from `app.baseURL` — `createSitePathResolver` passes
`useRuntimeConfig().app.baseURL`, which Nuxt normalizes with a trailing slash, and
`".../sub"` never ends with `"/sub/"`. The guard matches only for a base written
without the trailing slash, which is why upstream's own `it('base - weird issue')`
test passes while `it('base url empty')` has a committed snapshot that accepts the
doubling.

Calling the real function directly:

| `siteUrl` | `base` | result |
| --- | --- | --- |
| `https://example.com` | `/sub/` | `https://example.com/sub/page` |
| `https://example.com/sub/` | `/sub/` | `https://example.com/sub/sub/page` |
| `https:///sub/` | `/sub/` | `https:///sub/sub/page` |

## Setting `i18n.baseUrl` is not a fix

This is the documented remedy — `SKILL.md` says `i18n.baseUrl` overriding `site.url`
is intended, and to give them the same value — and it does not stop the duplication.
`getBaseUrl()` still appends `app.baseURL`, so the url gains a host but keeps the
path: `https://example.com/sub/`, which `resolveSitePath` then doubles.

```sh
# with i18n.baseUrl: "https://example.com" uncommented in nuxt.config.ts
NODE_ENV=production NITRO_PRESET=node-server NUXT_SITE_URL=https://example.com/ pnpm build
NUXT_SITE_URL=https://example.com/ PORT=3202 pnpm preview
```

Hydrated DOM at `http://localhost:3202/sub/page`, measured in Chromium. SSR is
correct, as above:

```
link[rel=canonical]      getAttribute("href")  https://example.com/sub/sub/page
meta[property="og:url"]  content               https://example.com/sub/sub/page
```

The host is correct and the path is still doubled. The console error does go away,
so a clean console is not a signal that the url is right.

## What actually fixes it

Pushing only the *origin* into site config, at a priority above i18n's, corrects the
url on its own in all three configurations above. Setting `i18n.baseUrl` to that same
origin additionally stops the console error, but does not affect the url.

Fixes to `0.siteConfig.js` (`||` → `??`) or to the `resolveSitePath` guard each
correct only some of the three configurations.
