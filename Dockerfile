FROM oven/bun AS build
WORKDIR /app
COPY . .
RUN bun install
RUN bun build ./index.ts --compile --outfile puppeteerproxy

FROM dockerclovertech/puppeteer
WORKDIR /app
COPY --from=build /app/puppeteerproxy puppeteerproxy
COPY --from=build /app/package.json package.json
RUN npm install --ignore-scripts && npx puppeteer browsers install chrome && rm -rf node_modules package.json package-lock.json
CMD ["./puppeteerproxy"]