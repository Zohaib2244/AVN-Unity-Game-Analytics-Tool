FROM python:3.14-slim AS sqlite-build

RUN apt-get update && apt-get install -y --no-install-recommends gcc make curl ca-certificates libc6-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSLO https://www.sqlite.org/2026/sqlite-autoconf-3510300.tar.gz \
    && echo '81f5be397049b0cae1b167f2225af7646fc0f82e4a9b3c48c9ea3a533e21d77a  sqlite-autoconf-3510300.tar.gz' | sha256sum -c - \
    && tar -xzf sqlite-autoconf-3510300.tar.gz \
    && cd sqlite-autoconf-3510300 \
    && ./configure --prefix=/opt/sqlite --disable-static --disable-readline \
    && make -j2 && make install

FROM python:3.14-slim

COPY --from=sqlite-build /opt/sqlite/lib/ /opt/sqlite/lib/
ENV LD_LIBRARY_PATH=/opt/sqlite/lib PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 AVN_DATA_DIR=/data
RUN python -c 'import sqlite3; assert sqlite3.sqlite_version_info >= (3, 51, 3)'
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY avn_analytics ./avn_analytics
USER 1000:1000
EXPOSE 8000
CMD ["uvicorn", "avn_analytics.api:create_ingest_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "100", "--no-proxy-headers"]
