# designer-waitlist — Bun + Hono double-opt-in service (:3000, non-root).
# Bun runs the TS directly (no build step, no dist). Image base is digest-pinned
# by the registry-standardization rule at deploy time; the tag here is the
# dev-local build target.
FROM oven/bun:1
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
