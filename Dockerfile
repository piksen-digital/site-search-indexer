FROM apify/actor-node:22

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --include=dev --no-audit --no-fund
COPY . ./
RUN npm run build && npm prune --omit=dev

CMD ["npm", "start"]