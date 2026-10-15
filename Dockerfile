FROM node:20-slim

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9.15.9

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile
RUN pnpm exec playwright install --with-deps firefox && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node . .

ARG SAO_BUILD_SHA
RUN pnpm build:client && pnpm prune --prod
RUN chown node:node /app
ENV NODE_ENV=production
USER node

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
