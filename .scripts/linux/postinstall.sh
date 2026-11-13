#!/bin/sh
# After the .deb or .rpm installs: makes the `kestrel` user the system
# service runs as, and has systemd read the new services. Neither service is
# turned on.
set -e

if command -v systemd-sysusers >/dev/null 2>&1; then
  systemd-sysusers kestrel-nvr.conf || true
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi
