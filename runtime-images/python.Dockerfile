# BASE_IMAGE must be an operator-verified python:3.14-alpine3.24 digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Submitted programs only need the interpreter and standard library. Package
# installers and their bundled wheels unnecessarily enlarge the attack surface.
USER root
RUN rm -rf \
    /usr/local/bin/pip \
    /usr/local/bin/pip3 \
    /usr/local/bin/pip3.14 \
    /usr/local/lib/python3.14/ensurepip \
    /usr/local/lib/python3.14/site-packages/pip \
    /usr/local/lib/python3.14/site-packages/pip-*.dist-info \
    /usr/local/lib/python3.14/site-packages/setuptools \
    /usr/local/lib/python3.14/site-packages/setuptools-*.dist-info

USER 10001:10001
WORKDIR /work
