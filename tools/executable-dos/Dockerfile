FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive DISPLAY=:99 HOME=/tmp/home
RUN apt-get update \
    && apt-get install -y --no-install-recommends dosbox xvfb imagemagick python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 reviewer
COPY runner.py /app/runner.py
USER reviewer
ENTRYPOINT ["python3", "/app/runner.py"]
