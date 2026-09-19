# BASE_IMAGE must be an operator-verified python:3.14-slim digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 10001:10001
WORKDIR /work
