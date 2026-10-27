# Build official source tags locally instead of pulling unavailable MinIO images.
FROM golang:1.24-alpine AS builder
RUN apk add --no-cache git ca-certificates
ENV CGO_ENABLED=0
WORKDIR /src

FROM builder AS server-build
ARG MINIO_VERSION=RELEASE.2025-04-22T22-12-26Z
RUN git clone --depth 1 --branch "$MINIO_VERSION" https://github.com/minio/minio.git .
# Limit compiler parallelism to reduce peak memory on development machines.
RUN go build -p 2 -trimpath -o /out/minio .

FROM builder AS client-build
ARG MC_VERSION=RELEASE.2025-04-16T18-13-26Z
RUN git clone --depth 1 --branch "$MC_VERSION" https://github.com/minio/mc.git .
RUN go build -p 2 -trimpath -o /out/mc .

FROM alpine:3.22 AS minio
RUN apk add --no-cache ca-certificates
COPY --from=server-build /out/minio /usr/local/bin/minio
COPY --from=server-build /src/LICENSE /licenses/minio-LICENSE
EXPOSE 9000
ENTRYPOINT ["minio"]
CMD ["server", "/data"]

FROM alpine:3.22 AS mc
RUN apk add --no-cache ca-certificates
COPY --from=client-build /out/mc /usr/local/bin/mc
COPY --from=client-build /src/LICENSE /licenses/mc-LICENSE
ENTRYPOINT ["mc"]
