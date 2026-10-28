# ---- Stage 1: build the React frontend ----
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build          # outputs to /app/public (per vite.config.js outDir)

# ---- Stage 2: backend runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# better-sqlite3 needs a toolchain to compile its native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
# Bring in the built frontend from stage 1.
COPY --from=frontend /app/public ./public

ENV DATA_DIR=/data
ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "server.js"]
