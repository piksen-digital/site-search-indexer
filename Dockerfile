FROM apify/actor-node:20

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . ./
RUN npm run build && npm prune --omit=dev

CMD ["npm", "start"]