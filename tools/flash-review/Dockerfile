FROM mcr.microsoft.com/playwright:v1.61.0-noble

ARG FFDEC_VERSION=26.2.1
ARG RUFFLE_TAG=nightly-2026-06-17
ARG RUFFLE_DATE=2026_06_17

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-21-jre-headless unzip curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/jindrapetrik/jpexs-decompiler/releases/download/version${FFDEC_VERSION}/ffdec_${FFDEC_VERSION}.zip" -o /tmp/ffdec.zip \
    && mkdir -p /opt/ffdec \
    && unzip -q /tmp/ffdec.zip -d /opt/ffdec \
    && rm /tmp/ffdec.zip \
    && curl -fsSL "https://github.com/ruffle-rs/ruffle/releases/download/${RUFFLE_TAG}/ruffle-nightly-${RUFFLE_DATE}-web-selfhosted.zip" -o /tmp/ruffle.zip \
    && mkdir -p /opt/ruffle \
    && unzip -q /tmp/ruffle.zip -d /opt/ruffle \
    && rm /tmp/ruffle.zip

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY review.mjs .

ENV HOME=/tmp/home
ENTRYPOINT ["node", "/app/review.mjs"]
