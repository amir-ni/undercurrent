# syntax=docker/dockerfile:1.7

# ---- build: install all deps, typecheck, test, build the UI ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY test ./test
COPY web ./web
RUN npm run check && npm run build

# ---- runtime: production deps only, non-root, read-only friendly ----
FROM node:26-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/data/undercurrent.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8787/readyz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
