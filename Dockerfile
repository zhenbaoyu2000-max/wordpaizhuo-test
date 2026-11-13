FROM node:24-bookworm-slim
WORKDIR /app
COPY server.mjs game-worker.mjs ./
USER node
ENV HOST=0.0.0.0 DB_PATH=/tmp/game.sqlite
CMD ["node","server.mjs"]
