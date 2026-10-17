# Two targets share one dependency layer:
#   test: docker build --target test -t question-bank-prep-test . && docker run --rm question-bank-prep-test
#   app:  docker build --target app -t question-bank-prep .
#         docker run --rm -p 3000:3000 -e STUDY_PASSWORD=change-me -v question-bank-data:/app/app-data question-bank-prep
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
COPY . .
RUN npm run build
# A container port is not loopback, so the server requires STUDY_PASSWORD at run time.
ENV STUDY_HOST=0.0.0.0 STUDY_PORT=3000 STUDY_DATA_DIR=app-data
EXPOSE 3000
CMD ["npm", "start"]
