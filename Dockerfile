# Bun is pinned to one exact version, the same as `bun-version` in .github/workflows/ci.yml, so
# the image installs and runs on the Bun the quality gate ran on, and `bun install
# --frozen-lockfile` below reads bun.lock with a known version. Why 1.4.2 (#223):
# - It carries the fix for oven-sh/bun#31889 (oven-sh/bun#32488, first released in 1.4.0). 1.3.14
#   closed a kept-alive node:http connection with no response after serving a static file, which
#   Caddy logged as 502 "msg":"EOF" (#213). 1.4.2 is the version the #213 reproduction measured
#   with zero dropped connections.
# - 1.4.1 brought node:http server fixes, and regressions in `bun build` scoping and
#   AsyncLocalStorage memory that 1.4.2 fixes, together with musl (Alpine) GC crashes.
# - The open regression oven-sh/bun#43853 (the node:http client agent reuses a socket after a
#   `Connection: close` request to Bun.serve) reproduces on 1.4.0 and 1.4.2 alike, so no 1.4.x
#   patch avoids it. It does not reach this app: the app serves through a node:http server and
#   sends no request through a node:http client. Recheck that before the next bump.
FROM oven/bun:1.4.2-alpine AS base
WORKDIR /app

# Dependencies are installed in their own layer so that a source change does not reinstall them.
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Development image. docker-compose.yml mounts the working tree over /app and keeps this
# node_modules, so dependencies never have to be installed on the host.
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 5173
CMD ["bun", "run", "dev"]

FROM deps AS build
# The complex name is read through `$env/static/public`, which Vite inlines into the bundle at
# build time: setting it on the running container changes nothing. It is therefore a build arg,
# exported before `bun run build`, and changing the name means building and deploying again.
# `.env` is kept out of the build context by .dockerignore, so this is the only value the build sees.
ARG PUBLIC_COMPLEX_NAME=Komplek
ENV PUBLIC_COMPLEX_NAME=$PUBLIC_COMPLEX_NAME
COPY . .
# `superuser:grant` gives the first superuser, and on the server it has to run inside this image,
# which carries no src/. scripts/grant-superuser.ts is therefore bundled here into one file with
# every first-party import inlined. Two choices keep that bundle honest:
# - `$lib` is resolved through scripts/tsconfig.seed.json, which spells the alias out against
#   src/lib, rather than through tsconfig.json, which extends the generated .svelte-kit/tsconfig.json.
#   The bundle therefore does not depend on `svelte-kit sync` having run, and holds no `$lib` import.
# - Only pg and drizzle-orm are external, named one by one. They come from the node_modules the
#   production image already carries, the same copies the app runs on. `--packages external` is
#   not used because it would also pass an unresolved `$lib/...` through as if it were a package,
#   and the image would only fail when somebody ran the command. Named externals make an import
#   that cannot be resolved fail this build instead.
RUN bun build scripts/grant-superuser.ts --target bun \
		--tsconfig-override scripts/tsconfig.seed.json \
		--external pg --external drizzle-orm \
		--outfile dist/grant-superuser.js
RUN bun run build

# Production image. adapter-node emits build/index.js, which Bun runs directly.
# The migrations, drizzle.config.ts and scripts/migrate-preflight.ts are copied as well, so the
# `migrate` service in docker-compose.prod.yml runs `bun run db:migrate` from this same image
# instead of from a second one that could drift from it. drizzle-kit is a dev dependency, and it is
# present because the deps stage installs dev dependencies too.
FROM base AS production
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json drizzle.config.ts ./
COPY drizzle ./drizzle
# The bundle lands next to where the source lives in the working tree, as .js instead of .ts. The
# package.json script runs `bun run scripts/grant-superuser` with no extension, and Bun finds the
# .ts in a working tree and this .js in the image, so `bun run superuser:grant <email>` is the same
# command in both places.
COPY --from=build /app/dist/grant-superuser.js ./scripts/grant-superuser.js
# `bun run db:migrate` runs this check before drizzle-kit, so that a DATABASE_URL which does not
# parse or connect is named instead of swallowed (#202). Copied as it is rather than bundled like
# grant-superuser: it imports nothing but pg, which node_modules above already carries, Bun runs
# the .ts directly, and the path is the same as in a working tree. See the file's own comment.
COPY scripts/migrate-preflight.ts ./scripts/migrate-preflight.ts
EXPOSE 3000
CMD ["bun", "./build/index.js"]
