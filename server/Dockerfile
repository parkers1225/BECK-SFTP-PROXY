# Dockerfile for the Beck Auto-Post proxy.
# NOTE: Railway builds this service with Nixpacks (see /railway.json), so this file
# is only for running the proxy elsewhere. Build from the server/ directory:
#   docker build -t beck-auto-post-proxy . && docker run -p 3000:3000 --env-file .env beck-auto-post-proxy
FROM node:20-alpine

WORKDIR /app

# Install production dependencies first so the layer caches across code changes
COPY package*.json ./
RUN npm install --omit=dev

# Copy the whole service (sftp-proxy.js, users.js, admin.html, config.json)
COPY . ./

EXPOSE 3000
CMD ["node", "sftp-proxy.js"]
