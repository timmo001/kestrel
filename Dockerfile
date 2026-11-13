# The Kestrel server, from a release's kestrel-nvr archive: the same bundle,
# with its own Bun and go2rtc, as every other package, plus ffmpeg for
# recording. It serves plain HTTP on port 7380, where pairing guards
# everything but the page. Config, state and recordings live in /data, so
# mount a volume there. Pair a device with `docker exec <container> kestrel
# pair`.
#
# The default target, server, runs as the kestrel user. The app target is the
# Home Assistant app, which runs as root because the Supervisor creates /data
# as root.
#
# VERSION names the release, whose archive is checked against its
# SHA256SUMS. CI builds from the archive it has just made instead, by
# replacing the archive stage:
#   docker build --build-arg VERSION=<version> \
#     --build-context archive=<folder with the kestrel-nvr archive> .

ARG DEBIAN=debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

FROM ${DEBIAN} AS download

ARG VERSION
ARG TARGETARCH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /out

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "There's no kestrel-nvr build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    release="https://github.com/timmo001/kestrel/releases/download/$VERSION"; \
    file="kestrel-nvr-$VERSION-linux-$arch.tar.gz"; \
    curl -fsSLO "$release/$file"; \
    curl -fsSL "$release/SHA256SUMS" | grep " $file\$" | sha256sum -c -

# The archive alone, which --build-context archive=<folder> replaces
FROM scratch AS archive

COPY --from=download /out/ /

FROM ${DEBIAN} AS base

ARG VERSION
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=bind,from=archive,target=/archive \
    set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
    esac; \
    tar -xzf "/archive/kestrel-nvr-$VERSION-linux-$arch.tar.gz" -C /opt; \
    mv "/opt/kestrel-nvr-$VERSION-linux-$arch" /opt/kestrel-nvr; \
    ln -s /opt/kestrel-nvr/bin/kestrel /usr/local/bin/kestrel

# go2rtc moves off its usual 1984, since the app shares the host's network,
# where another go2rtc, such as Frigate's, may already use it
ENV KESTREL_PORT=7380 \
    KESTREL_CONFIG=/data/config \
    KESTREL_STATE=/data/state \
    KESTREL_RECORDINGS=/data/recordings \
    KESTREL_GO2RTC_PORT=11984

EXPOSE 7380

ENTRYPOINT ["/usr/local/bin/kestrel"]

CMD ["serve"]

FROM base AS app

FROM base AS server

RUN useradd --system --home-dir /data --create-home --shell /usr/sbin/nologin kestrel

USER kestrel

VOLUME /data
