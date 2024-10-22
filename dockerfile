# Pull base image.
FROM ghcr.io/puppeteer/puppeteer:latest
USER root

WORKDIR /app

COPY package.json package.json
COPY tsconfig.json tsconfig.json
COPY index.ts index.ts
COPY UI.ts UI.ts

# install deps
RUN npm install

# Expose ports
EXPOSE 5500

USER pptruser

CMD [ "npm", "start" ]