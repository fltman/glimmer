# ai-ps Python + Celery workers.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps for Pillow (zlib/jpeg) and healthy TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libjpeg62-turbo \
        zlib1g \
        ca-certificates \
        bash \
    && rm -rf /var/lib/apt/lists/*

# Install the package (deps resolved from pyproject). Copy metadata first for
# better layer caching, then the source.
COPY pyproject.toml ./
COPY aips ./aips
RUN pip install --upgrade pip && pip install .

COPY start.sh ./start.sh
RUN chmod +x ./start.sh

# Default: run BOTH the bridge and the Celery worker.
CMD ["./start.sh"]
