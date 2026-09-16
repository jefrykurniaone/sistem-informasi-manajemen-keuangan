# Bun version is pinned so the container matches the version the lockfile was written with.
FROM oven/bun:1.3.14-alpine AS base
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
COPY . .
RUN bun run build

# Production image. adapter-node emits build/index.js, which Bun runs directly.
FROM base AS production
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./
EXPOSE 3000
CMD ["bun", "./build/index.js"]
