FROM node:22-alpine3.21

# better-sqlite3 requires native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /data

EXPOSE 3001

# 512MB heap — adjust based on number of bot instances on the server
CMD ["node", "--max-old-space-size=512", "src/index.js"]
