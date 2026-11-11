FROM node:26.13.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace @gethookd/api --include-workspace-root=false
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
RUN npm run build -w @gethookd/api

FROM node:26.13.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @gethookd/api --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle
USER node
EXPOSE 3000
# Reuse the shared config boundary for encoded container defaults and explicit URLs.
# The same entrypoint runs either the API or the compiled one-shot initializer.
ENTRYPOINT ["node", "--input-type=module", "--eval", "import { loadConfig } from './apps/api/dist/config.js'; process.env.DATABASE_URL = loadConfig({ context: 'container' }).databaseUrl; await import(process.argv[1]);"]
CMD ["./apps/api/dist/server.js"]
