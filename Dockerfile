FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json .npmrc ./
ARG GITHUB_TOKEN
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc && \
    npm ci && \
    rm -f .npmrc
COPY . .
RUN npm run build

FROM node:26-alpine AS runner
LABEL io.modelcontextprotocol.server.name="io.github.wyre-technology/action1-mcp"
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mcp
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Prune devDependencies out of the shipped image — the builder stage needs
# them (tsc/vite/vitest etc. for `npm run build`), but the runtime only
# executes `node dist/index.js` and never needs a test/build toolchain.
# Also closes off a false-alarm class: a devDependency-only CVE (e.g.
# GHSA-5xrq-8626-4rwp on vitest, triaged 2026-08-03) would otherwise show up
# as present in the production image even though nothing here ever invokes
# it.
RUN npm prune --omit=dev && npm cache clean --force

USER mcp
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=env
CMD ["node", "dist/index.js"]
