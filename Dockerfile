FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/

FROM node:24-alpine
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=builder /app ./
RUN mkdir -p /app/data
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]