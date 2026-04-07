FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN mkdir -p uploads public/uploads
EXPOSE 3000
CMD ["node", "server.js"]
