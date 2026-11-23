# Built by the exact-source lifecycle fixture producer, never with run-specific credentials.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash codexia-backup \
    && mkdir -p /home/codexia-backup/.ssh /backups \
    && chown -R codexia-backup:codexia-backup /home/codexia-backup/.ssh /backups \
    && chmod 0700 /home/codexia-backup/.ssh \
    && rm -f /etc/ssh/ssh_host_*_key*
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
