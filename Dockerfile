# Self-contained Python 3.14, matching the host's /usr/bin/python3.14 so the existing
# hasaki-work-mcp .venv (mounted from the host) keeps working without reinstalling anything.
FROM python:3.14-slim-bookworm AS pybase

FROM node:24-bookworm-slim
# setsid (util-linux) is how manager.ts gives each spawned server its own killable process group.
# ca-certificates: some managed servers' env points at /etc/ssl/certs (mounted from the host too).
# libsqlite3/libssl/libffi/etc: the copied python3.14 build is dynamically linked against these
# (normally provided by the python:slim image's own apt packages, which we didn't copy — only
# /usr/local, the Python install itself).
RUN apt-get update && apt-get install -y --no-install-recommends \
    util-linux ca-certificates \
    libbz2-1.0 libffi8 liblzma5 libncursesw6 libreadline8 libsqlite3-0 libssl3 zlib1g \
  && rm -rf /var/lib/apt/lists/*
COPY --from=pybase /usr/local /usr/local
# the mounted .venv's symlinks hardcode "/usr/bin/python3" (pyvenv.cfg home=/usr/bin) — point
# that at the python3.14 just copied in, not reinstalled, in /usr/local.
RUN ln -sf /usr/local/bin/python3.14 /usr/bin/python3.14 && ln -sf /usr/local/bin/python3.14 /usr/bin/python3

WORKDIR /app
# corporate network's CA, so `npm ci` at build time doesn't hit SELF_SIGNED_CERT_IN_CHAIN
# (the same reason the running app itself needs NODE_OPTIONS=--use-system-ca).
COPY ca-certificates.crt /usr/local/share/ca-certificates/corporate-ca.crt
RUN update-ca-certificates
ENV NODE_OPTIONS=--use-system-ca
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

ENV NODE_OPTIONS=--use-system-ca PYTHONDONTWRITEBYTECODE=1
EXPOSE 3100
CMD ["node", "src/index.ts"]
