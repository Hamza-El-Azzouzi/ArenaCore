# BASE_IMAGE must be an operator-verified node:24-bookworm-slim digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 10001:10001
WORKDIR /work
