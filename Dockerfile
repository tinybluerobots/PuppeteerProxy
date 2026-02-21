FROM oven/bun AS build
WORKDIR /app
COPY . .
RUN bun install
RUN bun build ./index.ts --compile --outfile puppeteerproxy

FROM ghcr.io/puppeteer/puppeteer
WORKDIR /app
COPY --from=build /app/puppeteerproxy puppeteerproxy
CMD ["./puppeteerproxy"]
