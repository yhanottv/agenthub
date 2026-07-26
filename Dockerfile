FROM node:20-bookworm-slim

# Build deps for better-sqlite3 (falls back to a source build when no prebuilt
# binary matches the platform).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
ENV PORT=8090
ENV DATA_DIR=/data

EXPOSE 8090
VOLUME ["/data"]

CMD ["node", "server.js"]
