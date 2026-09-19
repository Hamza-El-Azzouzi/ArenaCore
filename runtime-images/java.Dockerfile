# BASE_IMAGE must be an operator-verified eclipse-temurin:21-jdk digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 10001:10001
WORKDIR /work
