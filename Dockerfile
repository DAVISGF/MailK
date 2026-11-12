FROM node:22-bookworm-slim AS build
WORKDIR /app
# Herramientas para compilar better-sqlite3 si no hay binario precompilado disponible
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
ENV npm_config_nodedir=/usr/local
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production MAILK_DB=/data/mailk.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME /data
EXPOSE 1025 1143 1110 8025 1465 1993 1995
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAILK_HTTP_PORT||8025)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
