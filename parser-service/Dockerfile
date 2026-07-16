FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
# Use `npm install --production` to support builds when no package-lock.json exists
# (Render's default `npm ci` fails when package-lock.json is absent).
RUN npm install --production
COPY . .
EXPOSE 3001
CMD ["node", "index.js"]
