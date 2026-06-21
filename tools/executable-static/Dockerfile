FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp/home
RUN apt-get update \
    && apt-get install -y --no-install-recommends file binutils p7zip-full build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt
RUN git clone --depth 1 https://github.com/mandiant/capa-rules.git /opt/capa-rules \
    && rm -rf /opt/capa-rules/.git
COPY analyze.py .
ENTRYPOINT ["python", "/app/analyze.py"]
