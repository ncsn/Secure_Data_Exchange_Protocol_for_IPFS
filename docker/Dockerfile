FROM node:22-alpine
WORKDIR /app
COPY src/ src/
COPY docker/docker-node.mjs .
CMD ["node", "docker-node.mjs"]
