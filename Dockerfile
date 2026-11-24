# Arena wrapper — deployable site image.
# Needs a real Chromium (the engine drives arena.ai in a browser), so this
# installs Playwright's Chromium + system deps. Host requirements:
#   - >= 2 GB RAM (Chromium + Node), persistent disk for /data.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && rm -rf /root/.npm

COPY . .

ENV NODE_ENV=production
# Persistent data (keys.json + default profile location) — mount a disk here.
ENV DATA_DIR=/data
ENV ARENA_PROFILE_DIR=/data/arena-profile
RUN mkdir -p /data

EXPOSE 3100
CMD ["node", "index.js"]
