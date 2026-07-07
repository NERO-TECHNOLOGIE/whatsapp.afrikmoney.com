FROM node:22-alpine

# better-sqlite3 needs build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Persistent data lives here — mount a volume at this path in Coolify
RUN mkdir -p /data
ENV SESSION_DB_PATH=/data/bot.db

EXPOSE 3001

CMD ["node", "src/index.js"]
