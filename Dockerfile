FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server/server.js"]
