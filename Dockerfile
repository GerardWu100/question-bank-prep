# Two targets share one dependency layer:
#   test: docker build --target test -t question-bank-prep-test . && docker run --rm question-bank-prep-test
#   app:  the published image (ghcr.io/gerardwu100/question-bank-prep); run it with
#         docker-compose.example.yml, or build it locally with docker-compose.yml.
FROM node:24-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM deps AS test
# Chromium plus its system libraries for the Playwright browser test.
RUN npx playwright install --with-deps chromium
COPY . .
# CI=1 makes Playwright start fresh servers instead of reusing stray ones.
ENV CI=1
CMD ["sh", "-c", "npm run typecheck && npm test && npm run build && npm run test:e2e"]

FROM deps AS app
# ripgrep backs the tutor's read-only `rg` tool over the study notes.
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build
# A container port is not loopback, so the server requires STUDY_PASSWORD at run time.
# Mount points (see docker-compose.example.yml):
#   /data            database and backups (writable)
#   /question_bank   question-bank folder, synced on open (read-only)
#   /materials       study notes for the Materials page and the tutor (read-only)
#   /codex           folder holding the ChatGPT sign-in auth.json (read-write, so an
#                    app-owned sign-in can be refreshed)
# HOME=/tmp lets the app run as any user id without a home folder.
ENV STUDY_HOST=0.0.0.0 STUDY_PORT=3000 STUDY_DATA_DIR=/data \
    MATERIAL_ROOT=/question_bank READING_ROOT=/materials CODEX_AUTH_FILE=/codex/auth.json HOME=/tmp
EXPOSE 3000
# node runs the TypeScript server through tsx directly; no npm process wrapper.
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
