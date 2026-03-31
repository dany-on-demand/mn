# syntax=docker/dockerfile:1
FROM node:24-alpine AS base

WORKDIR /app

# Install native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Create required directories
RUN mkdir -p data media

EXPOSE 3016

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3016/api/auth/me',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.mjs"]
