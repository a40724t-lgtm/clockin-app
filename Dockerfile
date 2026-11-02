# 員工打卡系統 — 容器映像（SnapDeploy / 任何 Docker 主機）
FROM node:22-slim
ENV NODE_ENV=production \
    TRUST_PROXY=1 \
    DATA_DIR=/app/data \
    PORT=3000
WORKDIR /app
# better-sqlite3 v13 內含 linux-x64 / linux-arm64 預編譯檔；--ignore-scripts 跳過 node-gyp 編譯（不需編譯工具）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get()"
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
