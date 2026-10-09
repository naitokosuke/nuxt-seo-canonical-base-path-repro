# Repro: canonical/og:url duplicate `app.baseURL` when `@nuxtjs/i18n` is installed

With `app.baseURL` set to a sub path and `@nuxtjs/i18n` installed, `@nuxtjs/seo`
emits `canonical` and `og:url` with the base path applied **twice** — and with no
origin at all unless `i18n.baseUrl` is set.

```
expected  https://example.com/sub/page
actual    https:///sub/sub/page
```

`https:///sub/sub/page` has an empty host, so `new URL()` resolves it against the
path and browsers treat the first segment as the host. A numeric base path makes
this worse: `app.baseURL: "/123/"` yields `https:///123/123/page`, and
`new URL()` reads `123` as the 32-bit integer form of an IPv4 address, producing
`https://0.0.0.123/123/page`. Anything that consumes the live `og:url` — a share
sheet, for instance — then hands out a URL pointing at an unrelated IP address.

## Versions

| package | version |
| --- | --- |
| `nuxt` | 4.5.0 |
| `@nuxtjs/seo` | 3.4.0 |
| `nuxt-seo-utils` | 7.0.19 |
| `nuxt-site-config` | 3.2.21 |
| `site-config-stack` | 3.2.21 |
| `@nuxtjs/i18n` | 10.4.0 |
| Node | 24.14.0 |

The two faulty code paths below are **unchanged in `nuxt-site-config` /
`site-config-stack` 4.2.3**, so upgrading does not help.

## Variant A — visible in the SSR HTML

```sh
pnpm install
NODE_ENV=production NITRO_PRESET=node-server pnpm build
PORT=3200 pnpm preview
curl -s http://localhost:3200/sub/page | grep -oE '<link rel="canonical"[^>]*>'
```

Measured:

```
<link rel="canonical" href="https:///sub/sub/page">
```

The serialized site config in that response is `url: "https:///sub/"` with
`_priority.url: -2`.

## Variant B — SSR correct, hydration wrong

Supplying `NUXT_SITE_URL` adds a `buildEnv` entry at priority `-1`, which outranks
the i18n entry at `-2` on the server. The server output becomes correct while the
client still resolves the wrong url — this is the shape that reaches production,
where it is invisible to `curl` and to crawlers that do not run JS.

```sh
NODE_ENV=production NITRO_PRESET=node-server NUXT_SITE_URL=https://example.com/ pnpm build
NUXT_SITE_URL=https://example.com/ PORT=3201 pnpm preview
```

Measured — SSR is now right, but the payload carries a priority that cannot survive
hydration:

```
<link rel="canonical" href="https://example.com/sub/page">
payload site config: url "https://example.com/"  _priority.url 0
```

Then read the hydrated DOM in a browser at `http://localhost:3201/sub/page`:

```js
document.querySelector('link[rel=canonical]').getAttribute("href");
```

Measured in Chromium — the server sent the right url and the client replaced it:

```
link[rel=canonical]      getAttribute("href")  https:///sub/sub/page
meta[property="og:url"]  content               https:///sub/sub/page
link[rel=canonical]      .href (resolved)      https://sub/sub/page
```

The empty host is not ignored. The browser resolves the first path segment as the
host, so the live `og:url` points at a host named `sub`. The console also carries,
on every load:

```
[Nuxt Site Config] Your I18n baseUrl `` doesn't match your site url example.com.
```

This is the shape that reaches production: right in the HTML, wrong in the live
DOM. `curl` and crawlers that do not execute JS never see it, while anything
reading the live `og:url` — a share sheet, an in-page copy button — does.

Read the live DOM, and do not let one browser's first-load reading settle it. On a
real deployment running these versions, Chromium showed the *correct* value on
first load while Safari showed the broken one; in this reproduction Chromium shows
the broken value directly. The HTML is right in both cases, so it tells you
nothing.

## Root cause

Three separate things combine.

### 1. `@nuxtjs/i18n` reports a path as its `baseUrl`

`@nuxtjs/i18n/dist/runtime/context.js` — `getBaseUrl()`:

```js
return joinURL(baseUrl(), nuxt.$config.app.baseURL);
```

`baseUrl` defaults to `""` (`dist/module.mjs`), so under a base path this returns
`joinURL("", "/sub/")` === `"/sub/"`: truthy, but with no origin. The server-side
counterpart in `dist/runtime/server/plugin.js` returns `""` instead, so the two
sides disagree.

### 2. `nuxt-site-config` loses the server-resolved priority on hydration

`nuxt-site-config/dist/runtime/app/plugins/0.siteConfig.js`:

```js
stack.push({ [k]: store[k], _priority: store._priority?.[k] || -1 });
```

A legitimate priority of `0` is falsy and collapses to `-1`. Separately,
`site-config-stack/dist/index.mjs` never records priority `-1` at all:

```js
if (typeof stack[o]._priority !== "undefined" && stack[o]._priority !== -1) {
  siteConfig._priority[key] = stack[o]._priority;
}
```

so an entry that wins on the server at `-1` is serialized with whatever lower
priority was recorded before it. Either way the restored entry ends up at `-1`,
tying with the i18n client entry — which `nuxt-site-config/dist/runtime/app/plugins/i18n.js`
pushes at `_priority: -1` on the client but `-2` on the server. The sort is stable
and `0.siteConfig.js` is `enforce: "pre"`, so the later i18n entry wins on the
client and the client resolves a different site url than the server did.

### 3. `resolveSitePath` applies the base twice

`site-config-stack/dist/urls.mjs`:

```js
let origin = withoutTrailingSlash(options.absolute ? options.siteUrl : "");
if (base !== "/" && origin.endsWith(base)) {
  origin = origin.slice(0, origin.indexOf(base));
}
const baseWithOrigin = options.withBase ? withBase(base, origin || "/") : origin;
```

`origin` has its trailing slash stripped while `base` keeps one, so
`origin.endsWith(base)` can never match — `".../sub"` never ends with `"/sub/"`.
The guard that exists to avoid doubling the base therefore never fires.

Calling the real function directly:

| `siteUrl` | `base` | result |
| --- | --- | --- |
| `https://example.com` | `/sub/` | `https://example.com/sub/page` |
| `https://example.com/sub/` | `/sub/` | `https://example.com/sub/sub/page` |
| `https:///sub/` | `/sub/` | `https:///sub/sub/page` |

## Setting `i18n.baseUrl` is not a fix

Uncommenting `i18n.baseUrl` in `nuxt.config.ts` gives the i18n-reported url an
origin. But `getBaseUrl()` still appends `app.baseURL`, so that url becomes
`https://example.com/sub/` — an origin *with a path*, which is exactly what issue 3
doubles.

```sh
# with i18n.baseUrl: "https://example.com" uncommented in nuxt.config.ts
NODE_ENV=production NITRO_PRESET=node-server NUXT_SITE_URL=https://example.com/ pnpm build
NUXT_SITE_URL=https://example.com/ PORT=3202 pnpm preview
```

Measured in Chromium. SSR is correct, and the payload is unchanged from variant B
apart from the trailing slash:

```
SSR  <link rel="canonical" href="https://example.com/sub/page">
SSR  <meta property="og:url" content="https://example.com/sub/page">
payload site config: url "https://example.com"  _priority.url 0
```

The hydrated DOM at `http://localhost:3202/sub/page`:

```
link[rel=canonical]      getAttribute("href")  https://example.com/sub/sub/page
meta[property="og:url"]  content               https://example.com/sub/sub/page
link[rel=canonical]      .href (resolved)      https://example.com/sub/sub/page
```

The host is correct and the path is still doubled. Setting `i18n.baseUrl` moves the
broken value from `https:///sub/sub/page` to `https://example.com/sub/sub/page`; it
does not stop the duplication, because the duplication happens after the origin has
been resolved.

What it does fix is the console. The load is clean — the
`[Nuxt Site Config] Your I18n baseUrl ...` error is gone, because the mismatch check
compares hosts and the i18n url now has one. The error going quiet is therefore not
a signal that the url is right: here it goes quiet while the canonical is still
wrong, which is the misleading combination to watch for.

So `i18n.baseUrl` is worth setting, but it is not the fix for the duplicated base.
On a real deployment running these versions, stopping the duplication took two
pieces together: a plugin pushing *only the origin* into site config at a priority
above i18n's, plus `i18n.baseUrl` set to that same origin.
