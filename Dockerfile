FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build:client

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
