# syntax=docker/dockerfile:1
ARG DATABASE_URL=postgresql://myescrow:myescrow@localhost:5432/myescrow
ARG BUILD_SHA=development

FROM node:20-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app

FROM base AS deps
ARG DATABASE_URL
ENV DATABASE_URL=${DATABASE_URL}
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate

FROM base AS build
ARG DATABASE_URL
ENV DATABASE_URL=${DATABASE_URL}
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build

FROM base AS prod
ARG DATABASE_URL
ARG BUILD_SHA
ENV NODE_ENV=production
ENV DATABASE_URL=${DATABASE_URL}
ENV APP_BUILD_SHA=${BUILD_SHA}
LABEL org.opencontainers.image.revision=${BUILD_SHA}
COPY package*.json ./
COPY prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --production
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]
