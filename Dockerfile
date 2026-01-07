FROM node:20-slim

# ffprobe comes from ffmpeg
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=3000
ENV MEDIA_ROOT=/media

EXPOSE 3000

CMD ["node", "src/server.js"]
