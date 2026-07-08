# Single image for both api and worker (command selects which). Multi-stage: build the monorepo,
# then run the compiled dist. ffmpeg provides ffprobe for media validation (#3).
FROM node:22-slim AS base
RUN corepack enable && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app ./
# Default command runs the API; the worker service overrides it in compose.prod.yml.
CMD ["node", "apps/api/dist/index.js"]
