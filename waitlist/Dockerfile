# designer-waitlist — Bun + Hono double-opt-in service (:3000, non-root).
# Bun runs the TS directly (no build step, no dist). Base identity is fixed
# in FROM for both local and deployment builds: exact version + registry digest.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
WORKDIR /app

# Production deps only (devDeps — vitest, biome, types — excluded).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source.
COPY tsconfig.json ./
COPY src ./src

# oven/bun ships a non-root `bun` user (UID 1000).
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
