# BASE_IMAGE must be an operator-verified node:24-alpine3.24 digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# ArenaCore executes one source file with node directly. npm, Corepack and Yarn
# are build/install tools and must not be available to submitted programs.
USER root
RUN rm -rf \
    /opt/yarn-* \
    /usr/local/bin/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
    /usr/local/lib/node_modules/corepack \
    /usr/local/lib/node_modules/npm

USER 10001:10001
WORKDIR /work
