FROM node:20-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/prompts/package.json packages/prompts/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY . .

RUN pnpm db:generate
RUN pnpm build

FROM node:20-bookworm-slim AS runtime-base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app

COPY --from=build /app /app

# The workspace packages used to point `main` at `src/index.ts`, so this stage
# rewrote all four to `dist` before the runtime could start. That made the image
# the only place a built app was startable, and any other consumer of the built
# output — the integration smoke workflow — died on `SyntaxError: Unexpected
# token '{'` from a `.ts` entry. They now ship pointing at `dist`, so nothing
# needs rewriting here.

FROM runtime-base AS api-runtime

EXPOSE 3000

CMD ["pnpm", "--filter", "@statecore/api", "start"]

FROM runtime-base AS worker-runtime

CMD ["pnpm", "--filter", "@statecore/worker", "start"]

FROM runtime-base AS migrate

CMD ["pnpm", "db:deploy"]
