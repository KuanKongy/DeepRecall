FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The URL the user's browser calls; compose publishes the api there.
ARG VITE_API_URL=http://localhost:10000
ENV VITE_API_URL=$VITE_API_URL

# Serve from / in Docker (the GitHub Pages deploy uses base /DeepRecall/).
RUN npm run build -- --base=/

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
