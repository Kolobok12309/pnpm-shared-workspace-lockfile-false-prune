# Pnpm shared-workspace-lockfile=false prune

Analogue of [turbo prune --docker](https://turbo.build/repo/docs/guides/tools/docker#the---docker-flag), but for pnpm with shared-workspace-lockfile=false.

Currently is not supported by turbo

## Usage

```Dockerfile
FROM node:18-alpine AS base

FROM base AS builder
# some builder steps

WORKDIR /app

RUN pnpm add -g pnpm-shared-workspace-lockfile-false-prune

COPY . .
# Our prune
RUN pnpm-shared-workspace-lockfile-false-prune prune --workspace web

FROM base AS installer
#some installer steps

COPY --from=builder /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Build the project
COPY --from=builder /app/out/full/ .
# Post prune step, required for resolve injected deps
RUN pnpm-shared-workspace-lockfile-false-prune post-prune --workspace web

# Some other build steps
RUN pnpm build
```
