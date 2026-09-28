FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4317
ENV HOSTNAME=0.0.0.0
ENV DATABASE_PATH=/app/data/library.db
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    mkvtoolnix \
    python3 \
    python3-venv \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-hun \
    tesseract-ocr-deu \
    tesseract-ocr-fra \
    tesseract-ocr-spa \
    tesseract-ocr-ita \
    util-linux \
    libssl3 \
    libexpat1 \
  && python3 -m venv /opt/whisper \
  && /opt/whisper/bin/pip install --no-cache-dir faster-whisper \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data /app/scripts
ENV WHISPER_PYTHON=/opt/whisper/bin/python
ENV HF_HOME=/app/data/whisper
# deploy.sh fills vendor/makemkv. A later build does not download MakeMKV again.
COPY vendor/makemkv/bin/ /usr/bin/
COPY vendor/makemkv/lib/ /usr/lib/
RUN chmod 755 /usr/bin/makemkvcon /usr/bin/mmgplsrv \
  && ldconfig \
  && ! ldd /usr/bin/makemkvcon /usr/bin/mmgplsrv /usr/lib/libmakemkv.so.1 /usr/lib/libdriveio.so.0 /usr/lib/libmmbd.so.0 | grep "not found"
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/scripts/detect_speech.py ./scripts/detect_speech.py
COPY --from=builder /app/scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh
EXPOSE 4317
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
