# ShincChat app image — multi-stage, no dev deps, runs as non-root.
#
# On ARM hosts (Oracle Always Free Ampere) every base image here has a
# native arm64 build, so the same Dockerfile works unchanged.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p data/media && chown -R node:node /app
USER node
EXPOSE 3000

# boot.js forks one worker per CPU (WEB_CONCURRENCY overrides) and shares
# state through Redis — see SCALING.md.
CMD ["node", "server/boot.js"]
