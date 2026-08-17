#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sshd_source="$script_dir/sshd-brooklynbowl.conf"
fail2ban_source="$script_dir/fail2ban-sshd.local"
sshd_target=/etc/ssh/sshd_config.d/00-brooklynbowl-hardening.conf
fail2ban_target=/etc/fail2ban/jail.d/99-brooklynbowl-sshd.local
backup_dir="/root/ssh-hardening-backup-$(date +%Y%m%d-%H%M%S)"

test "$(id -u)" -eq 0
test -s /root/.ssh/authorized_keys
test -f "$sshd_source"
test -f "$fail2ban_source"

install -d -m 700 "$backup_dir"
test ! -f "$sshd_target" || cp -a "$sshd_target" "$backup_dir/"
test ! -f "$fail2ban_target" || cp -a "$fail2ban_target" "$backup_dir/"
install -m 644 "$sshd_source" "$sshd_target"
install -m 644 "$fail2ban_source" "$fail2ban_target"

if ! sshd -t; then
  rm -f "$sshd_target"
  test ! -f "$backup_dir/$(basename "$sshd_target")" || cp -a "$backup_dir/$(basename "$sshd_target")" "$sshd_target"
  exit 1
fi

systemctl reload ssh
fail2ban-client reload

echo 'Effective SSH settings:'
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|logingracetime|maxauthtries|maxstartups|persourcemaxstartups) '
echo 'Fail2ban SSH settings:'
for key in findtime maxretry bantime; do
  printf '%s=' "$key"
  fail2ban-client get sshd "$key"
done
echo "Backup: $backup_dir"

