# syntax=docker/dockerfile:1
# Multi-stage: better-sqlite3 needs a compiler only while npm installs it (and only when no prebuilt
# binary matches). The runtime stage is node:20-slim with production dependencies, a non-root user,
# and a health check against /api/health.

FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    RASTA_DB=/app/data/rasta.db \
    RASTA_UPLOAD_DIR=/app/uploads \
    LOG_FORMAT=json
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js db.js vision.js scoring.js ./
COPY lib ./lib
COPY knowledge ./knowledge
COPY public ./public
COPY data/seed.json data/demo-route.json ./data/
# data/ and uploads/ are volumes; make sure the non-root user owns them when nothing is mounted.
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
