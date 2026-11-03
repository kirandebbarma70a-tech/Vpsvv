# render-vps — ek chhota VPS jo Render par chalta hai
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server \
      sudo \
      bash \
      ca-certificates \
      curl \
      wget \
      git \
      nano \
      vim-tiny \
      less \
      procps \
      tmux \
      htop \
      jq \
      unzip \
      zip \
      python3 \
      iproute2 \
      net-tools \
      dnsutils \
      rsync \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN chmod +x /app/start.sh && mkdir -p /run/sshd

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["/bin/bash", "/app/start.sh"]
