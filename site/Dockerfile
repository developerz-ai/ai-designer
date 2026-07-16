# syntax=docker/dockerfile:1
#
# developerz.ai Designer landing page (Vite static site) — DOCR image
# `designer-landing`. Stage 1 builds the static bundle; stage 2 serves it from
# an UNPRIVILEGED nginx.
#
# Build context is `site/` (this sub-project is self-contained: own package.json
# + bun.lock). The deploy workflow builds with `context: site` / `file:
# site/Dockerfile` — keep the two in sync.
#
# Runtime contract (infra #870 stack manifest):
#   - nginxinc/nginx-unprivileged, uid 101, listens on :8080
#   - /assets/ hashed bundle cached immutable; unknown routes fall back to
#     index.html

# ---- build the static site ----
FROM oven/bun:1.3.14-slim AS build
WORKDIR /app

# Lockfile first for a cache-friendly, frozen install; then the sources.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# hCaptcha PUBLIC site key, baked into the bundle at build time (Vite inlines
# import.meta.env.VITE_*). Passed by site-deploy.yml from the HCAPTCHA_SITEKEY
# repo variable; when absent/empty, main.ts falls back to the hCaptcha test key.
ARG VITE_HCAPTCHA_SITEKEY=""
ENV VITE_HCAPTCHA_SITEKEY=${VITE_HCAPTCHA_SITEKEY}
# `build` = `vite build` -> /app/dist
RUN bun run build

# ---- serve the static bundle (unprivileged nginx, :8080, uid 101) ----
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
# Static server config: listen 8080, immutable /assets/, index.html fallback.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# Explicit non-root user (uid 101). The base image already runs as this, but a
# literal USER makes the non-root contract explicit for static analysis and
# matches the k8s manifest's runAsUser:101.
USER nginx
EXPOSE 8080
# Base image CMD is ["nginx","-g","daemon off;"].
