#!/usr/bin/env bash
# render-vps entrypoint: sshd + web/ws bridge
set -euo pipefail

SSH_USER="${SSH_USER:-root}"
SSH_PASSWORD="${SSH_PASSWORD:-}"
SSH_PUBKEY="${SSH_PUBKEY:-}"
SSH_PORT="${SSH_PORT:-22}"

log() { echo "[render-vps $(date +%H:%M:%S)] $*"; }

# --- agar kuch bhi auth set nahi hai to random password banao ---------
if [ -z "$SSH_PASSWORD" ] && [ -z "$SSH_PUBKEY" ]; then
  SSH_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
  log "SSH_PASSWORD set nahi tha -> generated: ${SSH_PASSWORD}"
  log "(isse aap apne shell se copy karo; Render ke Environment me SSH_PASSWORD set karna better hai)"
fi

# --- user banao --------------------------------------------------------
if ! id "$SSH_USER" >/dev/null 2>&1; then
  log "creating user ${SSH_USER}"
  useradd -m -s /bin/bash "$SSH_USER"
fi
HOME_DIR="$(getent passwd "$SSH_USER" | cut -d: -f6)"
mkdir -p "$HOME_DIR"

if [ "$SSH_USER" != "root" ]; then
  echo "${SSH_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${SSH_USER}"
  chmod 440 "/etc/sudoers.d/90-${SSH_USER}"
fi

if [ -n "$SSH_PASSWORD" ]; then
  echo "${SSH_USER}:${SSH_PASSWORD}" | chpasswd
  log "password auth enabled for ${SSH_USER}"
fi

if [ -n "$SSH_PUBKEY" ]; then
  mkdir -p "$HOME_DIR/.ssh"
  printf '%s\n' "$SSH_PUBKEY" >> "$HOME_DIR/.ssh/authorized_keys"
  chmod 700 "$HOME_DIR/.ssh"
  chmod 600 "$HOME_DIR/.ssh/authorized_keys"
  chown -R "$SSH_USER" "$HOME_DIR/.ssh"
  log "public key installed for ${SSH_USER}"
fi

# --- host keys + sshd config ------------------------------------------
mkdir -p /run/sshd /var/run/sshd
ssh-keygen -A >/dev/null 2>&1 || true

cat > /etc/ssh/sshd_config.d/99-render-vps.conf <<EOF
Port ${SSH_PORT}
ListenAddress 127.0.0.1
PermitRootLogin yes
PubkeyAuthentication yes
PasswordAuthentication $( [ -n "$SSH_PASSWORD" ] && echo yes || echo no )
KbdInteractiveAuthentication yes
UsePAM yes
PermitEmptyPasswords no
X11Forwarding no
AllowTcpForwarding yes
AllowAgentForwarding yes
GatewayPorts no
ClientAliveInterval 30
ClientAliveCountMax 4
MaxSessions 10
Subsystem sftp internal-sftp
EOF

# agar default config me ListenAddress :: hai to conflict karta hai — hata do
sed -i 's/^ListenAddress ::/#ListenAddress ::/' /etc/ssh/sshd_config 2>/dev/null || true
sed -i "s/^#\?Port .*/#Port 22/" /etc/ssh/sshd_config 2>/dev/null || true

log "starting sshd on 127.0.0.1:${SSH_PORT}"
/usr/sbin/sshd -D -e &
SSHD_PID=$!

# agar sshd mar jaye to container bhi band ho (Render restart kar dega)
trap 'kill -TERM $SSHD_PID 2>/dev/null || true' TERM INT

log "starting web/ws bridge on port ${PORT:-8080}"
exec node /app/server.js
