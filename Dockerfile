# Stage 1: Build TypeScript source
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Lightweight production runtime
FROM node:20-alpine AS runner

WORKDIR /app

# Install Docker CLI & procps (standard Linux 'free' & 'uptime' utilities) for host/Docker monitoring tools
RUN apk add --no-cache docker-cli procps

ENV NODE_ENV=production
ENV PORT=3301
ENV HOST=0.0.0.0

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 3301

CMD ["node", "dist/server.js"]
