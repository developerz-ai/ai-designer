# designer-waitlist — Bun + Hono double-opt-in service (:3000, non-root).
# Bun runs the TS directly (no build step, no dist).
#
# BASE IMAGE = TAG + INDEX DIGEST. `oven/bun:1.4.4` alone floats to whatever 1.4.4 is pushed
# next; the digest does not. 1.4.4 is the toolchain this repo runs — BUN_VERSION in
# .github/workflows/ci.yml and .github/workflows/waitlist.yml, packageManager in package.json.
# Full variant, not -slim: the stock runtime and its non-root `bun` user (UID 1000) stay as they
# are. Digest resolved from https://hub.docker.com/v2/repositories/oven/bun/tags/1.4.4
# (media_type application/vnd.oci.image.index.v1+json — the multi-arch index, the same pin
# convention site/Dockerfile uses) and cross-checked against that file's `-slim` digest.
# Guarded by test/unit/waitlist-image-pin.test.ts — a tag or version drift fails the suite.
#
# NOTHING reparses or repins this file at deploy time. .github/workflows/waitlist-deploy.yml
# builds it exactly as written (context: waitlist, file: waitlist/Dockerfile, linux/amd64) and
# pushes `designer-waitlist` to DOCR as `latest` + `sha-<short>`. The ArgoCD Image Updater
# digest repin that workflow names (infra#870) moves the PUBLISHED app image in-cluster, never
# this base image.
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
