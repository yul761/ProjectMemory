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

RUN node -e "const fs=require('fs'); const path=require('path'); for (const rel of ['packages/core/package.json','packages/contracts/package.json','packages/prompts/package.json','packages/db/package.json']) { const file=path.join('/app', rel); const pkg=JSON.parse(fs.readFileSync(file,'utf8')); pkg.main='dist/index.js'; pkg.types='dist/index.d.ts'; fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n'); }"

FROM runtime-base AS api-runtime

EXPOSE 3000

CMD ["pnpm", "--filter", "@statecore/api", "start"]

FROM runtime-base AS worker-runtime

CMD ["pnpm", "--filter", "@statecore/worker", "start"]

FROM runtime-base AS migrate

CMD ["pnpm", "db:deploy"]
