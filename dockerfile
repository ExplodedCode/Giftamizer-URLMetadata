# Pull base image.
FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

COPY package.json package.json
COPY tsconfig.json tsconfig.json
COPY index.ts index.ts

# install deps
RUN npm install

# Expose ports
EXPOSE 5500

CMD [ "npm", "start" ]