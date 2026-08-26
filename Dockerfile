FROM node:24-alpine

RUN apk add --no-cache tzdata && \
    ln -snf /usr/share/zoneinfo/Europe/Paris /etc/localtime && \
    echo "Europe/Paris" > /etc/timezone

WORKDIR /app

# Installation des dependances en couche separee pour profiter du cache Docker
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY content ./content

# La base SQLite et les certificats sont montes en volume
RUN mkdir -p /app/data /app/certs && \
    addgroup -S cyber && adduser -S cyber -G cyber && \
    chown -R cyber:cyber /app
USER cyber

ENV NODE_ENV=production PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
