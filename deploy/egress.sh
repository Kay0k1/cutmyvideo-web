#!/usr/bin/env bash
# Only our media processes are filtered. Never flush Docker or host rules.
set -euo pipefail
chain=CUTMY-EGRESS
host_chain=CUTMY-HOST
api=172.30.240.10
worker=172.30.240.11
postgres=172.30.240.12
action="${1:-apply}"

if [[ "$action" == rules ]]; then
  cat <<RULES
*filter
:$chain - [0:0]
:$host_chain - [0:0]
-F $chain
-F $host_chain
-A $host_chain -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A $host_chain -j REJECT
-A $chain -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A $chain -d $postgres/32 -p tcp --dport 5432 -j RETURN
RULES
  # IANA special-purpose ranges, including metadata, CGNAT and multicast.
  for address in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
    printf -- '-A %s -d %s -j REJECT\n' "$chain" "$address"
  done
  cat <<RULES
-A $chain -p udp --dport 53 -j RETURN
-A $chain -p tcp --dport 53 -j RETURN
-A $chain -p tcp --dport 443 -j RETURN
-A $chain -j REJECT
COMMIT
RULES
  exit
fi

if [[ "$action" != apply && "$action" != remove && "$action" != check ]]; then
  printf 'Usage: egress.sh apply|check|remove|rules\n' >&2; exit 2
fi
iptables -w 10 -n -L DOCKER-USER > /dev/null
if [[ "$action" == remove ]]; then
  for address in "$api" "$worker"; do
    while iptables -w 10 -C DOCKER-USER -s "$address/32" -j "$chain" 2>/dev/null; do
      iptables -w 10 -D DOCKER-USER -s "$address/32" -j "$chain"
    done
    while iptables -w 10 -C INPUT -s "$address/32" -j "$host_chain" 2>/dev/null; do
      iptables -w 10 -D INPUT -s "$address/32" -j "$host_chain"
    done
  done
  iptables -w 10 -F "$chain" 2>/dev/null || true
  iptables -w 10 -X "$chain" 2>/dev/null || true
  iptables -w 10 -F "$host_chain" 2>/dev/null || true
  iptables -w 10 -X "$host_chain" 2>/dev/null || true
  exit
fi
if [[ "$action" == apply ]]; then
  # --noflush leaves unrelated container and host firewall chains intact.
  bash "${BASH_SOURCE[0]}" rules | iptables-restore -w 10 --noflush
  for address in "$api" "$worker"; do
    if ! iptables -w 10 -C DOCKER-USER -s "$address/32" -j "$chain" 2>/dev/null; then
      iptables -w 10 -I DOCKER-USER 1 -s "$address/32" -j "$chain"
    fi
    # Docker-host destinations traverse INPUT, not DOCKER-USER/FORWARD.
    # Deny every new host connection, including the host's public HTTPS IP.
    if ! iptables -w 10 -C INPUT -s "$address/32" -j "$host_chain" 2>/dev/null; then
      iptables -w 10 -I INPUT 1 -s "$address/32" -j "$host_chain"
    fi
  done
fi
for address in "$api" "$worker"; do
  iptables -w 10 -C DOCKER-USER -s "$address/32" -j "$chain"
  iptables -w 10 -C INPUT -s "$address/32" -j "$host_chain"
done
iptables -w 10 -C "$chain" -d "$postgres/32" -p tcp --dport 5432 -j RETURN
iptables -w 10 -C "$chain" -j REJECT
iptables -w 10 -C "$host_chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w 10 -C "$host_chain" -j REJECT
