# Pull base image.
FROM node:18-alpine

WORKDIR /app

COPY package.json package.json
COPY tsconfig.json tsconfig.json
COPY index.ts index.ts
COPY metadata metadata

# install deps
RUN npm install
RUN npm install ts-node -g

ENV PORT=8080

CMD [ "npm", "start" ]