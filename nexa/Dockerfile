# ---- build the web app ----
FROM node:20-bookworm-slim AS web
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install --include=optional
COPY frontend/ ./
RUN npm run build

# ---- runtime: one server, one port ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production PORT=4000 NEXA_DB_PATH=/data/nexa.db
WORKDIR /app/backend
COPY backend/package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY backend/ ./
COPY --from=web /app/frontend/dist /app/frontend/dist
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
