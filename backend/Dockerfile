FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY db/package*.json ./db/
RUN npm install --workspaces --legacy-peer-deps

FROM deps AS build
COPY backend ./backend
COPY db ./db
WORKDIR /app/backend
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY db/package*.json ./db/
RUN npm install --workspaces --omit=dev --legacy-peer-deps
COPY --from=build /app/backend/dist ./backend/dist
COPY backend/load-env.cjs ./backend/load-env.cjs
WORKDIR /app/backend
EXPOSE 5000
CMD ["npm", "start"]
