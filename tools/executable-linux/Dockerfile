FROM debian:13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 strace file \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 reviewer
COPY runner.py /app/runner.py
USER reviewer
ENTRYPOINT ["python3", "/app/runner.py"]
