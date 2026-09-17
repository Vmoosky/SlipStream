FROM node:24.14.1-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends sudo \
    && npx --yes playwright@1.62.1 install-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm

RUN printf '%s\n' 'node ALL=(root) NOPASSWD: /usr/bin/chown -R node /workspaces/slipstream/node_modules /workspaces/slipstream/packages/core/node_modules /workspaces/slipstream/packages/hook-runtime/node_modules /workspaces/slipstream/packages/mcp-server/node_modules /workspaces/slipstream/packages/copilot-plugin/node_modules /workspaces/slipstream/packages/extension/node_modules' > /etc/sudoers.d/slipstream-volumes \
    && chmod 0440 /etc/sudoers.d/slipstream-volumes \
    && visudo -cf /etc/sudoers.d/slipstream-volumes

WORKDIR /workspaces/slipstream
USER node
